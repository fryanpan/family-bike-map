import { describe, it, expect } from 'bun:test'
import type { Browser } from 'playwright'
import { closeBrowser, isHardFailure, TimeoutError, withTimeout } from '../scripts/render-checks/lib/bounds'
import type { CheckResult } from '../scripts/render-checks/lib/types'

// On 2026-10-20 the `always-visible` check wedged for 71 minutes with no
// output: run-all.ts awaited each check unbounded, and a check's
// `finally { await browser.close() }` never resolved because the browser
// process was already gone. Nothing printed, so a hang was
// indistinguishable from a slow check. These pin the bounds.

const never = new Promise<never>(() => {})

function result(over: Partial<CheckResult> = {}): CheckResult {
  return { name: 'determinism', passed: false, summary: '', details: [], ...over }
}

describe('withTimeout', () => {
  it('returns the work\'s value when it finishes inside the cap', async () => {
    expect(await withTimeout('fast', 1000, Promise.resolve(42))).toBe(42)
  })

  it('rejects with TimeoutError when the work never settles', async () => {
    await expect(withTimeout('wedged', 20, never)).rejects.toBeInstanceOf(TimeoutError)
  })

  it('names the label and the cap, so the output says WHICH check hung', async () => {
    // The whole point is that a reader of CI output can tell what wedged.
    const err = await withTimeout('check "always-visible"', 20, never).catch((e) => e as TimeoutError)
    expect(err.label).toBe('check "always-visible"')
    expect(err.message).toContain('always-visible')
  })

  it('passes a rejection through unchanged rather than reporting a timeout', async () => {
    const boom = new Error('real failure')
    await expect(withTimeout('fails', 1000, Promise.reject(boom))).rejects.toBe(boom)
  })
})

describe('closeBrowser', () => {
  it('gives up on a browser that never closes instead of hanging the check', async () => {
    const hung = { contexts: () => [], close: () => never } as unknown as Browser
    // Resolves (does not reject, does not hang) — a cleanup failure must
    // not cost a check the verdict it already computed.
    expect(await closeBrowser(hung, 20)).toBeUndefined()
  })

  it('swallows a close() rejection for the same reason', async () => {
    const broken = {
      contexts: () => [],
      close: () => Promise.reject(new Error('target closed')),
    } as unknown as Browser
    expect(await closeBrowser(broken, 1000)).toBeUndefined()
  })

  it('still closes a healthy browser', async () => {
    let closed = false
    const ok = { contexts: () => [], close: async () => { closed = true } } as unknown as Browser
    await closeBrowser(ok, 1000)
    expect(closed).toBe(true)
  })

  it('closes every context BEFORE the browser', async () => {
    // A context holding in-flight requests is why browser.close() hangs, and
    // an abandoned close breaks the NEXT check rather than this one — that is
    // how always-visible came to throw only when it ran after time-stability.
    const order: string[] = []
    const ctx = (name: string) => ({ close: async () => { order.push(name) } })
    const b = {
      contexts: () => [ctx('ctx-a'), ctx('ctx-b')],
      close: async () => { order.push('browser') },
    } as unknown as Browser

    // Budget has to exceed BROWSER_CLOSE_FLOOR_MS or there is nothing to
    // share out and every context is skipped by design.
    await closeBrowser(b, 5000)
    expect(order).toEqual(['ctx-a', 'ctx-b', 'browser'])
  })

  it('still closes the browser when one context refuses to close', async () => {
    const order: string[] = []
    const b = {
      contexts: () => [
        { close: () => never },
        { close: async () => { order.push('ctx-b') } },
      ],
      close: async () => { order.push('browser') },
    } as unknown as Browser

    // The hung context gets a FAIR SHARE of the budget over the floor, not
    // all of it, so ctx-b and the browser still get their turns. 3000ms
    // total, 1000ms floor, 2 contexts: the hung one is capped at 1000ms.
    await closeBrowser(b, 3000)
    expect(order).toEqual(['ctx-b', 'browser'])
  })
})

describe('isHardFailure', () => {
  it('passes a check that passed, listed or not', () => {
    expect(isHardFailure(result({ passed: true }), undefined)).toBe(false)
    expect(isHardFailure(result({ passed: true }), 'tracked debt')).toBe(false)
  })

  it('hard-fails an unlisted failure', () => {
    expect(isHardFailure(result(), undefined)).toBe(true)
  })

  it('downgrades a listed failure to XFAIL', () => {
    expect(isHardFailure(result(), 'tracked debt')).toBe(false)
  })

  it('hard-fails a TIMEOUT even when the check is listed as a known-fail', () => {
    // The hole this closes: known-fails.ts describes a product behaviour
    // expected to be wrong. It says nothing about the check being able to
    // RUN. If an entry could mask a hang, a check could be silenced by
    // wedging rather than by failing — the same "gate cannot fail" bug
    // one level up.
    expect(isHardFailure(result({ timedOut: true }), 'tracked debt')).toBe(true)
  })

  it('hard-fails a TIMEOUT on an unlisted check too', () => {
    expect(isHardFailure(result({ timedOut: true }), undefined)).toBe(true)
  })
})
