#!/usr/bin/env bun
// ALWAYS-VISIBLE — at citywide zoom (z11-z12) over SF, the bike overlay
// must paint at least a minimum count of colored pixels. Listed in
// known-fails.ts: current main has no citywide-zoom guarantee (the
// overlay only paints preferred infra, and preferred infra can be sparse
// at wide zoom depending on what's fetched) — feat/always-visible-overlay
// is expected to fix this.

import { chromium } from 'playwright'
import { serveApp } from '../lib/serve'
import { gotoView, waitForTilesSettled } from '../lib/mapControl'
import { screenshotMapCanvas } from '../lib/screenshot'
import { paintedMask, countPainted } from '../lib/pixels'
import type { CheckResult } from '../lib/types'

// Outer Sunset — a residential SF neighborhood, deliberately NOT downtown.
// Calibration testing (2026-07-11) found downtown SF (Market/Valencia/JFK
// Promenade area) already paints comfortably at z11-z12 regardless of an
// "always visible" guarantee — dense preferred infra there masks the gap
// this check exists to catch. Outer Sunset is mostly quiet residential
// streets with sparse preferred (1a/1b) infra, which is exactly the case
// an "always visible" guarantee needs to cover: a neighborhood with no
// standout bike infrastructure should still show SOMETHING at citywide
// zoom, not read as a dead zone.
const SF_VIEW = { lat: 37.7520, lng: -122.4950, zoom: 12 }
const TRAVEL_MODE = 'kid-confident'

// Calibration note (2026-07-11, cold wrangler-dev cache — `rm -r
// .wrangler/state/v3/{cache,r2}` before measuring; a warm local cache
// from a prior run reads much higher and hides the gap, see README.md
// "recalibrating budgets"): the Outer Sunset viewport above painted a
// stable ~360px on a genuinely cold run (measured 9s-97s post-load,
// painted count didn't move past the first ~10s). Current main has no
// explicit "paint at least N px" guarantee, so 360 is just whatever
// preferred infra happens to be tagged nearby — not a floor. 500 sits
// just above that measured value: low enough not to be a density
// target, high enough to fail on today's code and catch a genuinely
// empty viewport.
const MIN_PAINTED_PIXELS = 500

export async function runAlwaysVisibleCheck(baseUrl: string): Promise<CheckResult> {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await gotoView(page, baseUrl, SF_VIEW, { travelMode: TRAVEL_MODE })
    await waitForTilesSettled(page)

    const img = await screenshotMapCanvas(page)
    const mask = paintedMask(img)
    const painted = countPainted(mask)

    const passed = painted >= MIN_PAINTED_PIXELS
    return {
      name: 'always-visible',
      passed,
      summary: passed
        ? `${painted} painted px (>= ${MIN_PAINTED_PIXELS} minimum) at z${SF_VIEW.zoom} over SF`
        : `only ${painted} painted px (< ${MIN_PAINTED_PIXELS} minimum) at z${SF_VIEW.zoom} over SF`,
      details: [
        { label: 'painted px', value: String(painted) },
        { label: 'minimum', value: String(MIN_PAINTED_PIXELS) },
        { label: 'canvas size', value: `${img.width}x${img.height}` },
        { label: 'mode', value: TRAVEL_MODE },
      ],
    }
  } finally {
    await browser.close()
  }
}

if (import.meta.main) {
  const app = await serveApp()
  try {
    const result = await runAlwaysVisibleCheck(app.url)
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.passed ? 0 : 1)
  } finally {
    await app.stop()
  }
}
