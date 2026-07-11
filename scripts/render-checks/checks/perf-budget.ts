#!/usr/bin/env bun
// PERF BUDGET — measure long tasks + total blocking time (TBT) during
// initial load and during a zoom-out interaction; assert against a budget
// set at ~3x a measured baseline (see README.md for the recalibration
// procedure). Complements scripts/bench-overlay-paint.ts: that script
// measures the CPU-bound classify/gate/simplify cost in isolation (no
// browser, runs in CI); this measures the real main-thread cost INSIDE a
// live page, including layout/paint/GC, which is where #208's tile-
// arrival jank actually showed up as user-visible lag.

import { chromium, type Page } from 'playwright'
import { serveApp } from '../lib/serve'
import { gotoView, setEngineView, waitForTilesSettled } from '../lib/mapControl'
import type { CheckResult, CheckDetail } from '../lib/types'

const CENTER = { lat: 37.7649, lng: -122.4294, zoom: 14 }
const TRAVEL_MODE = 'kid-confident'
const LONG_TASK_THRESHOLD_MS = 50 // standard Web Vitals "long task" floor

// Calibrated 2026-07-11 against a live local wrangler-dev build (3 runs,
// cold-ish cache — see README.md "recalibrating budgets"): initial-load
// TBT 688-982ms, zoom-out TBT 131-623ms. Budgets below are ~3x the worst
// observed run of each, rounded up — same reasoning as bench-overlay-
// paint.ts's budgets.
const BUDGETS_MS = {
  initialLoadTbt: 3000,
  zoomOutTbt: 2000,
}

async function installLongTaskObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __longTasks: number[] }).__longTasks = []
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          (window as unknown as { __longTasks: number[] }).__longTasks.push(entry.duration)
        }
      })
      obs.observe({ entryTypes: ['longtask'] })
    } catch {
      // longtask entryType unsupported — leave __longTasks empty; the
      // check below treats an empty list as "0 long tasks measured",
      // which is fail-open (no false failures) at the cost of not
      // catching a real regression in that environment.
    }
  })
}

async function readLongTasks(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { __longTasks?: number[] }).__longTasks ?? [])
}

function totalBlockingTime(durationsMs: number[]): number {
  return durationsMs.reduce((sum, d) => sum + Math.max(0, d - LONG_TASK_THRESHOLD_MS), 0)
}

async function clearLongTasks(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __longTasks: number[] }).__longTasks = [] })
}

export async function runPerfBudgetCheck(baseUrl: string): Promise<CheckResult> {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await installLongTaskObserver(page)

    // ── initial load ──────────────────────────────────────────────────
    await gotoView(page, baseUrl, CENTER, { travelMode: TRAVEL_MODE })
    await waitForTilesSettled(page)
    const loadTasks = await readLongTasks(page)
    const loadTbt = totalBlockingTime(loadTasks)

    // ── zoom-out interaction ────────────────────────────────────────
    await clearLongTasks(page)
    await setEngineView(page, { lat: CENTER.lat, lng: CENTER.lng, zoom: CENTER.zoom - 3 })
    await waitForTilesSettled(page)
    const zoomTasks = await readLongTasks(page)
    const zoomTbt = totalBlockingTime(zoomTasks)

    const failures: string[] = []
    if (loadTbt > BUDGETS_MS.initialLoadTbt) failures.push(`initial-load TBT ${loadTbt.toFixed(0)}ms > budget ${BUDGETS_MS.initialLoadTbt}ms`)
    if (zoomTbt > BUDGETS_MS.zoomOutTbt) failures.push(`zoom-out TBT ${zoomTbt.toFixed(0)}ms > budget ${BUDGETS_MS.zoomOutTbt}ms`)

    const details: CheckDetail[] = [
      { label: 'initial-load long tasks', value: String(loadTasks.length) },
      { label: 'initial-load TBT', value: `${loadTbt.toFixed(0)}ms (budget ${BUDGETS_MS.initialLoadTbt}ms)` },
      { label: 'zoom-out long tasks', value: String(zoomTasks.length) },
      { label: 'zoom-out TBT', value: `${zoomTbt.toFixed(0)}ms (budget ${BUDGETS_MS.zoomOutTbt}ms)` },
    ]

    return {
      name: 'perf-budget',
      passed: failures.length === 0,
      summary: failures.length === 0 ? 'within long-task/TBT budgets' : failures.join('; '),
      details,
    }
  } finally {
    await browser.close()
  }
}

if (import.meta.main) {
  const app = await serveApp()
  try {
    const result = await runPerfBudgetCheck(app.url)
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.passed ? 0 : 1)
  } finally {
    await app.stop()
  }
}
