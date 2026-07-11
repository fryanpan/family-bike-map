import React from 'react'
import ReactDOM from 'react-dom/client'
import * as Sentry from '@sentry/react'
import { initSentry } from './sentry'
import { initUserback } from './userback'
import { APP_VERSION } from './version'
import { reportWaitingWorker, reportVersionMismatch, createOnceGuard, isNewVersion } from './services/swUpdate'
import 'leaflet/dist/leaflet.css'
import './App.css'
import App from './App'

// Printed unconditionally (not gated on DEV) so a user can screenshot
// which build their pinned home-screen app is running when reporting a
// "this looks stale" bug.
console.info(`[family-bike-map] APP_VERSION=${APP_VERSION}`)

initSentry()
initUserback()
registerServiceWorker()

/**
 * Register the offline-first service worker (`/sw.js`) and wire up
 * self-update detection (src/services/swUpdate.ts).
 *
 * Drives the sub-second second-load goal: the SW caches the app shell
 * (HTML / JS / CSS) cache-first and the map tiles stale-while-revalidate.
 * After the first successful load, repeat visits paint from cache
 * without waiting on network.
 *
 * Self-update: a pinned iOS home-screen app can sit suspended for days
 * without a real page navigation, so we can't rely on the browser's
 * default "check for SW updates on navigation" behaviour. Instead we
 * actively check on app load AND every time the app is foregrounded
 * (visibilitychange → visible) — both a SW byte-compare
 * (`registration.update()`) and a lightweight `/version` fetch. Either
 * signal surfaces an "Update available" toast (see UpdateBanner.tsx);
 * tapping it activates the new SW and reloads exactly once.
 *
 * Skipped on dev (Vite serves `/sw.js` only from the production build,
 * and HMR + SW interact badly). The `serviceWorker` API is also
 * missing on insecure origins, so this no-ops there. Practically this
 * means the whole self-update path is unverifiable on localhost — see
 * the PR test plan for the manual on-device steps.
 */
function registerServiceWorker(): void {
  if (typeof navigator === 'undefined') return
  if (!('serviceWorker' in navigator)) return
  if (import.meta.env.DEV) return

  // A postMessage(SKIP_WAITING) call makes the new SW activate, which
  // fires `controllerchange` on every open client — including this one.
  // Guard so we reload exactly once instead of looping if the event
  // fires more than expected.
  const allowReload = createOnceGuard()
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (allowReload()) window.location.reload()
  })

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      // Signal #1: SW byte-compare. Fires 'updatefound' when the SW
      // script at /sw.js differs from the one currently controlling
      // this page.
      registration.addEventListener('updatefound', () => {
        const installing = registration.installing
        if (!installing) return
        installing.addEventListener('statechange', () => {
          // 'installed' + an existing controller means this is a
          // genuine UPDATE (not the very first install on a fresh
          // device, where there's no controller yet) — the new SW is
          // sitting in `waiting`, ready to activate.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            reportWaitingWorker(installing)
          }
        })
      })

      // Check on load...
      registration.update().catch(() => {})
      checkVersionEndpoint()

      // ...and again on every foreground. This is the primary defense
      // against a suspended pinned iOS app running a stale bundle
      // indefinitely.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible') return
        registration.update().catch(() => {})
        checkVersionEndpoint()
      })
    }).catch((err) => {
      // Non-fatal — the app works without it, just slower on
      // repeat visits. Surface in Sentry so a broken SW deploy
      // doesn't silently kill the cache strategy.
      console.warn('[sw] register failed:', err)
      Sentry.captureException(err, { extra: { stage: 'sw-register' } })
    })
  })
}

/**
 * Signal #2: ask the Worker what version is actually deployed
 * (src/worker.ts GET /version). Cheaper and faster than a full SW
 * install cycle, so it can catch a stale pinned app on a foreground
 * where `registration.update()` hasn't finished its round trip yet.
 */
function checkVersionEndpoint(): void {
  fetch('/version', { cache: 'no-store' })
    .then((res) => (res.ok ? res.json() : null))
    .then((body: { version?: string } | null) => {
      if (!body) return
      reportVersionMismatch(isNewVersion(APP_VERSION, body.version))
    })
    .catch(() => {
      // Offline, or the endpoint 404s on an old deploy that predates
      // it — fail soft, the SW-side signal still works independently.
    })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<p style={{ padding: 24 }}>Something went wrong. Please reload the page.</p>}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
)
