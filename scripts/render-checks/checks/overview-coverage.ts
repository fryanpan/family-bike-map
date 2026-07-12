#!/usr/bin/env bun
// OVERVIEW-COVERAGE — at overview zoom (z9 / z10 / z11) the overlay must cover
// the WHOLE viewport, not a blob around the cursor.
//
// This is the check the baked 1.0° overview level exists to satisfy (outcome O2
// of docs/product/plans/2026-07-12-overlay-zoom-scale-plan.md). ALWAYS-VISIBLE
// asserts a non-empty floor ("something painted"); that floor is satisfied by
// the OLD behaviour too, because the 64-tile nearest-to-centre budget always
// paints *something* near the centre. The regression it cannot see is the
// deterministic coverage GAP at the edges: at z10 a 0.1°-tile viewport spans
// hundreds of tiles, 64 get fetched, and everything outside that central blob
// is blank. So this check asserts a spatial property instead of a count —
// painted pixels present across a grid of viewport cells, INCLUDING the outer
// ring.
//
// SEEDING (important): the overview level is served from R2 through the active
// manifest. A local `wrangler dev` has an empty local R2 unless you seed it:
//
//   bun scripts/pipeline/bake-overview.ts --tiles data/tiles/california
//   bun scripts/pipeline/upload-tiles.ts  --tiles data/tiles/california --local
//
// Without seeded cells /api/overview 404s, the client falls back to the 0.1°
// path (by design), and the coverage property provably cannot hold — so this
// check SKIPS rather than reporting a failure it can't attribute. See
// scripts/render-checks/README.md.

import { chromium } from 'playwright'
import { serveApp } from '../lib/serve'
import { gotoView, waitForTilesSettled, type ViewState } from '../lib/mapControl'
import { screenshotMapCanvas } from '../lib/screenshot'
import { paintedMask, countPainted, type DecodedImage } from '../lib/pixels'
import { latLngToOverviewCell } from '../../../src/services/overviewTiles'
import type { CheckResult } from '../lib/types'

// Bay Area → Sacramento Delta. Deliberately land in every quadrant (a viewport
// half-covered by the Pacific would fail a coverage assertion for reasons that
// have nothing to do with the overlay).
const CENTER = { lat: 38.05, lng: -121.95 }
const ZOOMS = [9, 10, 11]
const TRAVEL_MODE = 'kid-confident'

// The viewport is split into GRID × GRID cells; a cell "has coverage" when it
// holds at least MIN_PX_PER_CELL painted pixels (1 stray antialiasing pixel is
// not coverage). At overview zoom the bike network is a sparse web, so a cell
// is not required to be dense — only to be reached at all.
const GRID = 4
const MIN_PX_PER_CELL = 3
// Not every cell of a real landscape holds bike infrastructure (open water,
// state park, farmland), so this is not 100%. It IS far above what the
// centre-blob behaviour can produce: with a 64-tile budget at z10 the outer
// ring is blank by construction.
//
// CALIBRATION STATUS: chosen from the geometry of the gap this check exists to
// catch, NOT measured against a real bake (no overview tiles were seeded when
// this landed — see the seeding note above). Re-calibrate against the first
// real CA bake and record the measured numbers here.
const MIN_COVERED_CELLS_PCT = 60

interface Coverage {
  coveredCells: number
  totalCells: number
  pct: number
  painted: number
}

/** Fraction of viewport grid cells holding painted overlay pixels. */
export function gridCoverage(img: DecodedImage, mask: Uint8Array): Coverage {
  const counts = new Array<number>(GRID * GRID).fill(0)
  for (let y = 0; y < img.height; y++) {
    const gy = Math.min(GRID - 1, Math.floor((y / img.height) * GRID))
    for (let x = 0; x < img.width; x++) {
      if (!mask[y * img.width + x]) continue
      const gx = Math.min(GRID - 1, Math.floor((x / img.width) * GRID))
      counts[gy * GRID + gx]++
    }
  }
  const coveredCells = counts.filter((c) => c >= MIN_PX_PER_CELL).length
  return {
    coveredCells,
    totalCells: GRID * GRID,
    pct: (coveredCells / (GRID * GRID)) * 100,
    painted: countPainted(mask),
  }
}

/** Is the overview level actually seeded for this viewport's cells? */
async function overviewSeeded(baseUrl: string): Promise<boolean> {
  const { row, col } = latLngToOverviewCell(CENTER.lat, CENTER.lng)
  try {
    const resp = await fetch(`${baseUrl}/api/overview?row=${row}&col=${col}`)
    return resp.ok
  } catch {
    return false
  }
}

export async function runOverviewCoverageCheck(baseUrl: string): Promise<CheckResult> {
  if (!(await overviewSeeded(baseUrl))) {
    return {
      name: 'overview-coverage',
      // SKIPPED, not failed: with no overview tiles in the local R2 the client
      // is on its 0.1° fallback path, where the coverage gap is EXPECTED.
      passed: true,
      summary: 'SKIPPED — no overview tiles in the local R2 (see README: seeding the overview level)',
      details: [{ label: 'seeded', value: 'no' }],
    }
  }

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    const results: Array<{ zoom: number; cov: Coverage }> = []
    for (const zoom of ZOOMS) {
      const view: ViewState = { ...CENTER, zoom }
      await gotoView(page, baseUrl, view, { travelMode: TRAVEL_MODE })
      await waitForTilesSettled(page)
      const img = await screenshotMapCanvas(page)
      results.push({ zoom, cov: gridCoverage(img, paintedMask(img)) })
    }

    const failures = results.filter((r) => r.cov.pct < MIN_COVERED_CELLS_PCT)
    const passed = failures.length === 0
    return {
      name: 'overview-coverage',
      passed,
      summary: passed
        ? `whole-viewport coverage at z${ZOOMS.join('/z')} (>= ${MIN_COVERED_CELLS_PCT}% of ${GRID}x${GRID} cells painted at every zoom)`
        : `coverage gap at z${failures.map((f) => f.zoom).join(', z')} — the overlay is not covering the whole viewport`,
      details: results.map((r) => ({
        label: `z${r.zoom}`,
        value: `${r.cov.coveredCells}/${r.cov.totalCells} cells covered (${r.cov.pct.toFixed(0)}%), ${r.cov.painted} painted px`,
      })),
    }
  } finally {
    await browser.close()
  }
}

if (import.meta.main) {
  const app = await serveApp()
  try {
    const result = await runOverviewCoverageCheck(app.url)
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.passed ? 0 : 1)
  } finally {
    await app.stop()
  }
}
