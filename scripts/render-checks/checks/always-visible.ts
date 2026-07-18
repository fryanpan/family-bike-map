#!/usr/bin/env bun
// ALWAYS-VISIBLE — at citywide zoom (z11-z12) over SF, the bike overlay
// must paint a meaningful, non-trivial amount of colored pixels. This
// check's job is narrowly "the overlay is non-empty at citywide zoom" —
// it is NOT a density target and NOT a determinism check. Determinism
// (the SAME viewport painting the SAME thing regardless of how you got
// there — cold load vs. pan-away-and-return) is a different invariant,
// covered separately by checks/determinism.ts. Keep these two concerns
// apart: this check only asserts "something painted," not "the same
// thing painted every time."
//
// Nor is it a COVERAGE check. Below z12 the overlay switches to the baked 1.0°
// overview level, where the assertion that matters is "the whole viewport is
// covered" — a non-empty floor is satisfied by the old centre-blob behaviour
// too. That stronger property lives in checks/overview-coverage.ts (z9/z10/z11);
// this check stays on the z12 detail level.

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
// painted count didn't move past the first ~10s), and a second z12
// viewport painted 671px. Both main (post feat/always-visible-overlay,
// #223) and the sibling PR paint ~360px here — this is genuinely how
// sparse Outer Sunset's tagged preferred infra is, not a bug. An earlier
// version of this check asserted painted >= 500, which is ABOVE the real
// density of a legitimately-passing viewport and made the check
// viewport-fragile (any slightly-sparser real neighborhood would fail
// even though the overlay is working correctly). 150 is deliberately
// well below the ~360 measured floor: high enough to catch a genuinely
// empty/broken overlay (0px, or a handful of stray antialiasing pixels),
// low enough to not assert a density target this check was never meant
// to police.
const MIN_PAINTED_PIXELS = 150

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
