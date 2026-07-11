import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import {
  isNewVersion,
  computeUpdateAvailable,
  reportWaitingWorker,
  reportVersionMismatch,
  applyUpdate,
  __getSwUpdateSnapshot,
  __resetSwUpdateStatus,
} from '../src/services/swUpdate'

describe('isNewVersion', () => {
  it('is false when versions match', () => {
    expect(isNewVersion('0.1.184', '0.1.184')).toBe(false)
  })

  it('is true when the remote version differs', () => {
    expect(isNewVersion('0.1.184', '0.1.185')).toBe(true)
  })

  it('treats a missing/empty remote as "no signal", not a mismatch', () => {
    // Offline fetch, or an old deploy predating the /version endpoint —
    // must not falsely trigger the update toast.
    expect(isNewVersion('0.1.184', null)).toBe(false)
    expect(isNewVersion('0.1.184', undefined)).toBe(false)
    expect(isNewVersion('0.1.184', '')).toBe(false)
  })

  it('treats a dev build string as a normal string compare', () => {
    expect(isNewVersion('0.1.0-dev-abc1234', '0.1.0-dev-abc1234')).toBe(false)
    expect(isNewVersion('0.1.0-dev-abc1234', '0.1.0-dev-def5678')).toBe(true)
  })
})

describe('computeUpdateAvailable', () => {
  it('is false when neither signal fired', () => {
    expect(computeUpdateAvailable(false, false)).toBe(false)
  })

  it('is true when only the SW-waiting signal fired', () => {
    expect(computeUpdateAvailable(true, false)).toBe(true)
  })

  it('is true when only the version-mismatch signal fired', () => {
    expect(computeUpdateAvailable(false, true)).toBe(true)
  })

  it('is true when both signals fired', () => {
    expect(computeUpdateAvailable(true, true)).toBe(true)
  })
})

describe('swUpdate store', () => {
  beforeEach(() => __resetSwUpdateStatus())

  it('starts with no update available', () => {
    expect(__getSwUpdateSnapshot().updateAvailable).toBe(false)
  })

  it('reportWaitingWorker(worker) flips updateAvailable on', () => {
    reportWaitingWorker({ postMessage: () => {} } as unknown as ServiceWorker)
    expect(__getSwUpdateSnapshot().updateAvailable).toBe(true)
  })

  it('reportWaitingWorker(null) flips it back off', () => {
    reportWaitingWorker({ postMessage: () => {} } as unknown as ServiceWorker)
    reportWaitingWorker(null)
    expect(__getSwUpdateSnapshot().updateAvailable).toBe(false)
  })

  it('reportVersionMismatch(true) flips updateAvailable on independently of the SW signal', () => {
    reportVersionMismatch(true)
    expect(__getSwUpdateSnapshot().updateAvailable).toBe(true)
  })

  it('reportVersionMismatch(false) does not clear a waiting-worker signal', () => {
    reportWaitingWorker({ postMessage: () => {} } as unknown as ServiceWorker)
    reportVersionMismatch(false)
    expect(__getSwUpdateSnapshot().updateAvailable).toBe(true)
  })
})

describe('applyUpdate', () => {
  beforeEach(() => __resetSwUpdateStatus())

  // applyUpdate() always reloads directly — it is the ONLY caller of
  // window.location.reload() for a self-update, and it only runs from
  // the toast's onClick. This is what makes an auto-activated SW (see
  // public/sw.js's unconditional self.skipWaiting()) unable to reload
  // the page on its own; regression test for the PR #221 review finding.
  let originalWindow: typeof globalThis.window | undefined
  let reload: ReturnType<typeof mock>

  beforeEach(() => {
    originalWindow = globalThis.window
    reload = mock(() => {})
    ;(globalThis as { window: unknown }).window = { location: { reload } }
  })

  afterEach(() => {
    ;(globalThis as { window: unknown }).window = originalWindow
  })

  it('posts SKIP_WAITING to the waiting worker AND reloads directly, when one is present', () => {
    const postMessage = mock(() => {})
    reportWaitingWorker({ postMessage } as unknown as ServiceWorker)

    applyUpdate()

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
    // The reload must not depend on a `controllerchange` event ever
    // firing — sw.js's install handler auto-activates the new worker,
    // so that event may already have fired (and been ignored) before
    // the user ever taps Reload.
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads directly when no waiting worker is registered', () => {
    // version-mismatch-only case: /version detected staleness before any
    // SW updatefound cycle produced a waiting worker.
    reportVersionMismatch(true)

    applyUpdate()

    expect(reload).toHaveBeenCalledTimes(1)
  })
})
