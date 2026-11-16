// Wall-clock bounds for the suite.
//
// Every Playwright wait INSIDE a check already has a timeout, and
// serve.ts's killTree SIGKILLs the dev server after 3s — so for a long
// time it looked as though nothing here could hang. Two awaits were
// unbounded anyway, and on 2026-10-20 `always-visible` wedged for 71
// minutes with no output, no chromium process and no crash report. It ran
// clean on re-run, so the trigger was a one-off dead browser rather than
// anything in the check.
//
// The cost was never the hang: it was the silence. A suite that neither
// passes nor fails nor prints is indistinguishable from a slow one, so
// nobody knows to look. A gate that cannot report is worth no more than
// the gate that could not fail.

import type { Browser } from 'playwright'
import type { CheckResult } from './types'

/** Per-check wall-clock cap. The slowest real check (time-stability: three
 *  zooms, each a 15s hold plus paint-settle polling) runs a few minutes, so
 *  10 minutes is a wide margin over honest slowness while still bounded.
 *  Override with RENDER_CHECK_TIMEOUT_MS when a new check needs longer. */
export const CHECK_TIMEOUT_MS = Number(process.env.RENDER_CHECK_TIMEOUT_MS ?? 600_000)

/** How long to let a browser shut down before abandoning it. Playwright's
 *  `close()` does not resolve when the browser process is already gone,
 *  which is the specific hang observed above. */
const BROWSER_CLOSE_TIMEOUT_MS = 30_000

/** Render a cap for a human: seconds once it is worth seconds, else ms.
 *  `Math.round(ms / 1000)` alone prints a 20ms cap as "0s". */
function humanMs(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`
}

export class TimeoutError extends Error {
  constructor(public readonly label: string, public readonly ms: number) {
    super(`${label} exceeded its ${humanMs(ms)} wall-clock cap and was abandoned`)
    this.name = 'TimeoutError'
  }
}

/**
 * Resolve `work`, or reject with TimeoutError after `ms`.
 *
 * The losing promise is NOT cancelled — there is no way to cancel an
 * in-flight await — so a hung check's promise stays pending for the rest
 * of the process. That is fine for a suite runner that is about to exit,
 * and it is strictly better than the alternative of waiting forever. The
 * timer is unref'd so a fast resolve does not hold the event loop open.
 */
export function withTimeout<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const bell = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms)
    timer.unref?.()
  })
  return Promise.race([work, bell]).finally(() => clearTimeout(timer))
}

/**
 * Close a browser without letting a dead one hold the check open.
 *
 * Swallows both the timeout and any close error on purpose: by the time a
 * check reaches its `finally`, it already has a verdict (or a real error
 * on its way up), and losing that to a cleanup failure would turn a
 * reported result into no result at all.
 */
/** Cap for ONE context's close, inside the overall browser-close budget. */
export const CONTEXT_CLOSE_TIMEOUT_MS = 10_000

/** The browser's own close always gets at least this much of the budget, so a
 *  slow set of contexts can shorten its share but never take it to nothing. */
export const BROWSER_CLOSE_FLOOR_MS = 1_000

export async function closeBrowser(browser: Browser, timeoutMs = BROWSER_CLOSE_TIMEOUT_MS): Promise<void> {
  // Close the contexts BEFORE the browser. A context holding in-flight
  // requests is the usual reason browser.close() does not return, and
  // abandoning that close is not free: on 2026-11-14 time-stability's close
  // was abandoned at the 30s cap and the NEXT check then threw, because its
  // page never got a map canvas inside 15s while the previous browser was
  // still alive and still fetching. Run alone, that check passes. The
  // suite's own output named the abandoned close one line above the throw.
  //
  // `timeoutMs` is the budget for the WHOLE shutdown, not per call — one
  // wedged context must not spend what the rest of the shutdown needs. Same
  // shape as the Overpass chain budget: each step gets min(cap, remaining),
  // and the last step keeps a floor.
  const deadline = Date.now() + timeoutMs
  const remaining = () => deadline - Date.now()

  // Each context gets a FAIR SHARE of what is left over the browser's floor,
  // not all of it. Giving the first context everything meant one wedged
  // context skipped every healthy one behind it — and closing those is the
  // whole reason this loop exists.
  const contexts = browser.contexts()
  for (let i = 0; i < contexts.length; i++) {
    const ctx = contexts[i]
    const spendable = Math.max(0, remaining() - BROWSER_CLOSE_FLOOR_MS)
    const cap = Math.min(CONTEXT_CLOSE_TIMEOUT_MS, Math.floor(spendable / (contexts.length - i)))
    if (cap <= 0) {
      console.warn('[render-checks] out of shutdown budget — leaving a browser context open')
      break
    }
    try {
      await withTimeout('context.close()', cap, ctx.close())
    } catch (err) {
      console.warn(`[render-checks] a browser context did not close — continuing: ${String(err)}`)
    }
  }

  try {
    await withTimeout('browser.close()', Math.max(BROWSER_CLOSE_FLOOR_MS, remaining()), browser.close())
  } catch (err) {
    console.warn(`[render-checks] browser did not shut down cleanly — continuing: ${String(err)}`)
  }
}


/**
 * Does this result fail the suite?
 *
 * A listed known-fail failing is XFAIL — tracked debt, suite still green.
 * A TIMEOUT never is, listed or not: known-fails.ts describes a product
 * behaviour that is expected to be wrong, and says nothing about the
 * check being able to run at all. Letting an entry mask a hang would
 * rebuild the hole this suite exists to close, one level up — a check
 * could be silenced by wedging instead of by failing.
 *
 * Lives here rather than in run-all.ts because run-all.ts calls main()
 * at module scope, so a test cannot import it without running the suite.
 */
export function isHardFailure(result: CheckResult, known: string | undefined): boolean {
  if (result.passed) return false
  return result.timedOut === true || known === undefined
}
