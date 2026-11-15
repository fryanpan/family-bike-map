// Screenshot ONLY the map canvas (data-testid="map-canvas" on the engine's
// container div, added in src/components/Map.tsx for this harness) — never
// the full page, which includes app chrome (search bar, legend, bottom
// sheet) that isn't what these checks assert on and would dilute the
// painted-pixel counts with unrelated UI.

import type { Page } from 'playwright'
import { decodePng, type DecodedImage } from './pixels'

export async function screenshotMapCanvas(page: Page): Promise<DecodedImage> {
  const locator = page.locator('[data-testid="map-canvas"]')
  await locator.waitFor({ state: 'visible', timeout: 15000 })
  const buffer = await locator.screenshot({ type: 'png' })
  return decodePng(buffer)
}
