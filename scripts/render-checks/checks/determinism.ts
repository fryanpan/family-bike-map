#!/usr/bin/env bun
// DETERMINISM — the same viewport reached two ways must paint identically:
//   (a) direct cold load straight to the viewport
//   (b) load elsewhere, zoom in, pan around, zoom back out to the SAME
//       viewport
// Compares painted pixel masks (see lib/pixels.ts) with a dilation
// tolerance for sub-pixel jitter (re-simplified geometry, tile-boundary
// redraw, AA differences) — a real regression looks like a whole region
// of painted pixels present in one screenshot and absent in the other,
// not a few stray edge pixels.

import { chromium } from 'playwright'
import { serveApp } from '../lib/serve'
import { gotoView, panAwayAndReturn, waitForTilesSettled } from '../lib/mapControl'
import { screenshotWhenPaintSettles } from '../lib/screenshot'
import { paintedMask, comparePaintedMasks } from '../lib/pixels'
import type { CheckResult } from '../lib/types'

const TARGET_VIEW = { lat: 37.7649, lng: -122.4294, zoom: 14 }
const TRAVEL_MODE = 'kid-confident'

// A perfect 0-pixel-diff bar is too strict for a raster basemap (tile
// redraw / label placement can jitter a handful of pixels even with no
// overlay change at all). This is a "did a whole region vanish or
// appear" tripwire, not a pixel-perfect diff.
const MAX_DIVERGENT_PIXEL_RATIO = 0.10

export async function runDeterminismCheck(baseUrl: string): Promise<CheckResult> {
  const browser = await chromium.launch()
  try {
    // (a) direct cold load
    const pageA = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await gotoView(pageA, baseUrl, TARGET_VIEW, { travelMode: TRAVEL_MODE })
    await waitForTilesSettled(pageA)
    const imgA = await screenshotWhenPaintSettles(pageA)
    await pageA.close()

    // (b) load elsewhere, zoom in, pan, zoom back out to the same viewport
    const pageB = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const elsewhere = { lat: TARGET_VIEW.lat + 0.3, lng: TARGET_VIEW.lng - 0.3, zoom: 10 }
    await gotoView(pageB, baseUrl, elsewhere, { travelMode: TRAVEL_MODE })
    await panAwayAndReturn(pageB, TARGET_VIEW)
    await waitForTilesSettled(pageB)
    const imgB = await screenshotWhenPaintSettles(pageB)
    await pageB.close()

    if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
      return {
        name: 'determinism',
        passed: false,
        summary: `screenshot dimensions differ: ${imgA.width}x${imgA.height} vs ${imgB.width}x${imgB.height}`,
        details: [],
      }
    }

    const maskA = paintedMask(imgA)
    const maskB = paintedMask(imgB)
    const cmp = comparePaintedMasks(maskA, maskB, imgA.width, imgA.height)
    // Painted-denominated, for the same reason as time-stability: a
    // canvas denominator (1280x800) drowns the few thousand painted px
    // the overlay actually produces, so losing 90% of the overlay scored
    // 0.367% and passed a 2% budget.
    const paintedRef = Math.max(cmp.paintedInA, cmp.paintedInB)
    const divergentRatio = paintedRef === 0 ? 0 : (cmp.onlyInA + cmp.onlyInB) / paintedRef

    const passed = divergentRatio <= MAX_DIVERGENT_PIXEL_RATIO
    return {
      name: 'determinism',
      passed,
      summary: passed
        ? `painted masks agree (${(divergentRatio * 100).toFixed(3)}% divergent, budget ${(MAX_DIVERGENT_PIXEL_RATIO * 100).toFixed(2)}%)`
        : `painted masks diverge (${(divergentRatio * 100).toFixed(3)}% divergent, budget ${(MAX_DIVERGENT_PIXEL_RATIO * 100).toFixed(2)}%)`,
      details: [
        { label: 'painted (cold load)', value: String(cmp.paintedInA) },
        { label: 'painted (pan/zoom return)', value: String(cmp.paintedInB) },
        { label: 'only in cold-load shot', value: String(cmp.onlyInA) },
        { label: 'only in pan/zoom shot', value: String(cmp.onlyInB) },
        { label: 'divergent ratio', value: `${(divergentRatio * 100).toFixed(3)}%` },
      ],
    }
  } finally {
    await browser.close()
  }
}

if (import.meta.main) {
  const app = await serveApp()
  try {
    const result = await runDeterminismCheck(app.url)
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.passed ? 0 : 1)
  } finally {
    await app.stop()
  }
}
