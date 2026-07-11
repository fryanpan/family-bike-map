#!/usr/bin/env bun
// TIME-STABILITY — screenshot at t0 (network idle) and t+15s with ZERO
// interaction, at 2-3 zoom levels. Painted pixels may be ADDED over time
// (progressive loading) but a painted region DISAPPEARING is a failure —
// this is the flicker/vanishing-edges regression class documented in
// .claude/rules/rendering-changes.md ("loading adds paint, it never
// removes it").

import { chromium } from 'playwright'
import { serveApp } from '../lib/serve'
import { gotoView, waitForTilesSettled } from '../lib/mapControl'
import { screenshotMapCanvas } from '../lib/screenshot'
import { paintedMask, comparePaintedMasks } from '../lib/pixels'
import type { CheckResult, CheckDetail } from '../lib/types'

const TRAVEL_MODE = 'kid-confident'
const CENTER = { lat: 37.7649, lng: -122.4294 }
// browse ~z12, metro ~z14, street ~z16 — matches the rendering-changes
// rule's required manual check.
const ZOOMS = [12, 14, 16]
const STABILITY_WAIT_MS = 15000

// A handful of pixels flickering at a tile boundary during the wait
// (label re-placement, tile re-fetch retry) is not the regression class
// this guards; a whole region vanishing is. Zero would be ideal but
// raster basemap redraw isn't perfectly pixel-stable even with no
// overlay change at all.
const MAX_VANISHED_PIXEL_RATIO = 0.01

interface ZoomStabilityResult {
  zoom: number
  passed: boolean
  vanishedRatio: number
  details: CheckDetail[]
}

async function checkZoom(browser: import('playwright').Browser, baseUrl: string, zoom: number): Promise<ZoomStabilityResult> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  try {
    await gotoView(page, baseUrl, { ...CENTER, zoom }, { travelMode: TRAVEL_MODE })
    await waitForTilesSettled(page) // "t0" = right after tiles visibly finish loading, per rendering-changes.md
    const t0Img = await screenshotMapCanvas(page)

    await page.waitForTimeout(STABILITY_WAIT_MS)
    const t15Img = await screenshotMapCanvas(page)

    const maskT0 = paintedMask(t0Img)
    const maskT15 = paintedMask(t15Img)
    const cmp = comparePaintedMasks(maskT0, maskT15, t0Img.width, t0Img.height)
    const totalPx = t0Img.width * t0Img.height
    const vanishedRatio = cmp.onlyInA / totalPx // painted at t0, gone by t15

    return {
      zoom,
      passed: vanishedRatio <= MAX_VANISHED_PIXEL_RATIO,
      vanishedRatio,
      details: [
        { label: `z${zoom} painted @t0`, value: String(cmp.paintedInA) },
        { label: `z${zoom} painted @t+15s`, value: String(cmp.paintedInB) },
        { label: `z${zoom} vanished px`, value: String(cmp.onlyInA) },
        { label: `z${zoom} vanished ratio`, value: `${(vanishedRatio * 100).toFixed(3)}%` },
      ],
    }
  } finally {
    await page.close()
  }
}

export async function runTimeStabilityCheck(baseUrl: string): Promise<CheckResult> {
  const browser = await chromium.launch()
  try {
    const perZoom: ZoomStabilityResult[] = []
    for (const zoom of ZOOMS) perZoom.push(await checkZoom(browser, baseUrl, zoom))

    const details = perZoom.flatMap((r) => r.details)
    const failedZooms = perZoom.filter((r) => !r.passed).map((r) => r.zoom)
    const passed = failedZooms.length === 0

    return {
      name: 'time-stability',
      passed,
      summary: passed
        ? `no painted regions vanished over ${STABILITY_WAIT_MS / 1000}s at z${ZOOMS.join('/')}`
        : `painted regions vanished at z${failedZooms.join(',')} over ${STABILITY_WAIT_MS / 1000}s`,
      details,
    }
  } finally {
    await browser.close()
  }
}

if (import.meta.main) {
  const app = await serveApp()
  try {
    const result = await runTimeStabilityCheck(app.url)
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.passed ? 0 : 1)
  } finally {
    await app.stop()
  }
}
