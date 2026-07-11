/**
 * Self-update detection for the hand-rolled service worker (public/sw.js).
 *
 * Why this exists: a pinned iOS home-screen app is not a normal browser
 * tab. iOS suspends the standalone webview process instead of killing it,
 * so re-opening the icon often *resumes* the existing page rather than
 * performing a real navigation/reload. A SW that only checks for updates
 * on navigation (the browser default) can go days without ever noticing a
 * new deploy. We compensate with two independent foreground signals:
 *
 *   1. SW byte-compare (`registration.update()` + `updatefound`) — the
 *      standard mechanism, driven from src/main.tsx.
 *   2. `/version` fetch (src/worker.ts) — cheaper and faster than a full
 *      SW install cycle, so it can catch staleness even before signal #1
 *      finishes its round trip.
 *
 * Both signals feed this module's observable store (same
 * useSyncExternalStore pattern as tileLoadStatus.ts) so the UI can show a
 * single "Update available" toast regardless of which signal fired.
 */
import { useSyncExternalStore } from 'react'

// ── Pure decision logic (unit-tested; no DOM/SW dependency) ──────────────

/**
 * True when the version reported by the server differs from the version
 * this client is currently running. `remote` may be missing (offline
 * fetch failure, or an old deploy that predates the /version endpoint) —
 * treated as "no signal", not as a mismatch.
 */
export function isNewVersion(current: string, remote: string | null | undefined): boolean {
  if (!remote) return false
  return remote !== current
}

/** OR-combinator for the two independent update signals. Kept as a named
 *  function (rather than inlined `a || b`) so the "what counts as an
 *  update" decision has one obvious place to test and extend. */
export function computeUpdateAvailable(swWaiting: boolean, versionMismatch: boolean): boolean {
  return swWaiting || versionMismatch
}

// ── Observable store ──────────────────────────────────────────────────────

export interface SwUpdateSnapshot {
  updateAvailable: boolean
}

let swWaiting = false
let versionMismatch = false
let waitingWorker: ServiceWorker | null = null

let snapshot: SwUpdateSnapshot = { updateAvailable: false }
const listeners = new Set<() => void>()

function emit(): void {
  snapshot = { updateAvailable: computeUpdateAvailable(swWaiting, versionMismatch) }
  for (const l of listeners) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function getSnapshot(): SwUpdateSnapshot {
  return snapshot
}

/** React hook — re-renders the consumer whenever update status changes. */
export function useSwUpdateStatus(): SwUpdateSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Signal #1: a new SW finished installing and is sitting in `waiting`,
 *  ready to activate. Pass `null` to clear (rarely needed — a page
 *  reload naturally resets all module state). */
export function reportWaitingWorker(worker: ServiceWorker | null): void {
  waitingWorker = worker
  swWaiting = worker != null
  emit()
}

/** Signal #2: the `/version` foreground check found (or stopped finding)
 *  a mismatch against the running APP_VERSION. */
export function reportVersionMismatch(mismatch: boolean): void {
  versionMismatch = mismatch
  emit()
}

/**
 * User tapped "Reload" on the update toast. Reloads the page directly —
 * this function is the ONLY place in the app that calls
 * `window.location.reload()` for a self-update, and it only runs from the
 * button's onClick, so a reload can never happen without the user asking
 * for one.
 *
 * This is a deliberate change from an earlier design that reloaded from a
 * `navigator.serviceWorker.addEventListener('controllerchange', ...)`
 * listener in main.tsx instead. That listener reloaded on ANY
 * controllerchange, but public/sw.js calls `self.skipWaiting()`
 * unconditionally in `install` and `self.clients.claim()` in `activate`,
 * so a new SW activates and claims open clients on its own — firing
 * controllerchange without user action on (a) a first-ever visit to a
 * fresh device, and (b) every foreground `registration.update()` call
 * that finds a new build. Driving the reload from that listener meant a
 * spurious full reload for every new user, and a surprise reload of an
 * active user's in-progress state (search text, in-progress route)
 * whenever a background check found an update. Reloading only from here
 * fixes both (PR #221 review).
 *
 * Still posts SKIP_WAITING to a waiting worker first, best-effort, in
 * case a future change makes `install` stop skip-waiting unconditionally
 * (see the module doc for why that message currently has little left to
 * do) — but the reload itself no longer depends on it doing anything,
 * since the network-first HTML strategy in sw.js fetches the fresh shell
 * on reload regardless of which SW instance is in control.
 */
export function applyUpdate(): void {
  if (waitingWorker) {
    waitingWorker.postMessage({ type: 'SKIP_WAITING' })
  }
  window.location.reload()
}

/** Test-only: read the current snapshot without the React hook. */
export function __getSwUpdateSnapshot(): SwUpdateSnapshot {
  return snapshot
}

/** Test-only: wipe all state between cases. */
export function __resetSwUpdateStatus(): void {
  swWaiting = false
  versionMismatch = false
  waitingWorker = null
  snapshot = { updateAvailable: false }
}
