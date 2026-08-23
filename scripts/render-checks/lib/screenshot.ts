// Screenshot ONLY the map canvas (data-testid="map-canvas" on the engine's
// container div, added in src/components/Map.tsx for this harness) — never
// the full page, which includes app chrome (search bar, legend, bottom
// sheet) that isn't what these checks assert on and would dilute the
// painted-pixel counts with unrelated UI.

import type { Page } from 'playwright'
import { decodePng, paintedMask, countPainted, type DecodedImage } from './pixels'

export async function screenshotMapCanvas(page: Page): Promise<DecodedImage> {
  const locator = page.locator('[data-testid="map-canvas"]')
  await locator.waitFor({ state: 'visible', timeout: 15000 })
  const buffer = await locator.screenshot({ type: 'png' })
  return decodePng(buffer)
}


/**
 * Screenshot repeatedly until the painted-pixel count stops changing, then
 * return the settled image.
 *
 * `waitForTilesSettled` watches the app's `.tile-loading-boxes` indicator,
 * which a single slow/retrying tile can hold active indefinitely — so it
 * caps at 15s and continues regardless. That cap is fine when the caller
 * only needs "roughly loaded," but it is NOT a convergence signal, and the
 * determinism check depends on one: its pan-away-and-return leg screenshot
 * once the cap expired and captured 421 painted px against the cold load's
 * 4158, a 90% shortfall that was purely un-reloaded tiles. The old
 * canvas-denominated ratio hid that as "0.367% divergent"; against a
 * painted denominator it would read as a 90% failure every run.
 *
 * Polling the painted count directly measures the thing the checks assert
 * on. Two consecutive equal readings means paint has converged.
 */
export async function screenshotWhenPaintSettles(
  page: Page,
  {
    pollMs = 3000,
    maxWaitMs = 60000,
    stableReadings = 3,
  }: { pollMs?: number; maxWaitMs?: number; stableReadings?: number } = {},
): Promise<DecodedImage> {
  const deadline = Date.now() + maxWaitMs
  let img = await screenshotMapCanvas(page)
  let last = countPainted(paintedMask(img))
  let stable = 1

  while (Date.now() < deadline) {
    await page.waitForTimeout(pollMs)
    img = await screenshotMapCanvas(page)
    const count = countPainted(paintedMask(img))
    // Require SEVERAL consecutive identical readings, not just two. Tiles
    // arrive in bursts with quiet gaps between them, so a single matching
    // pair can land mid-gap and declare convergence while paint is still
    // growing. The two-reading version returned a t0 of 5089 px for a
    // viewport that reached 5351 px fifteen seconds later, which surfaced
    // as a spurious 2.4% "vanished" reading in time-stability.
    stable = count === last ? stable + 1 : 1
    last = count
    if (stable >= stableReadings) return img
  }
  console.warn(`[render-checks] painted count still moving after ${maxWaitMs}ms (last ${last}px) — using the latest frame`)
  return img
}
