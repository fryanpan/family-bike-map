import { describe, it, expect, beforeEach, mock } from 'bun:test'
import {
  isNewVersion,
  computeUpdateAvailable,
  createOnceGuard,
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

describe('createOnceGuard', () => {
  it('returns true on the first call', () => {
    const guard = createOnceGuard()
    expect(guard()).toBe(true)
  })

  it('returns false on every call after the first', () => {
    const guard = createOnceGuard()
    guard()
    expect(guard()).toBe(false)
    expect(guard()).toBe(false)
    expect(guard()).toBe(false)
  })

  it('guards are independent per instance', () => {
    const guardA = createOnceGuard()
    const guardB = createOnceGuard()
    expect(guardA()).toBe(true)
    // B hasn't fired yet — A firing must not consume B's guard.
    expect(guardB()).toBe(true)
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

  it('posts SKIP_WAITING to the waiting worker when one is present', () => {
    const postMessage = mock(() => {})
    reportWaitingWorker({ postMessage } as unknown as ServiceWorker)

    applyUpdate()

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' })
  })

  it('falls back to a direct reload when no waiting worker is registered', () => {
    // version-mismatch-only case: /version detected staleness before any
    // SW updatefound cycle produced a waiting worker.
    reportVersionMismatch(true)

    const originalLocation = globalThis.window?.location
    const reload = mock(() => {})
    ;(globalThis as { window: unknown }).window = { location: { reload } }

    applyUpdate()

    expect(reload).toHaveBeenCalledTimes(1)

    // Restore, in case other tests in the same process touch window.location.
    if (originalLocation) {
      ;(globalThis as { window: { location: unknown } }).window.location = originalLocation
    }
  })
})
