#!/usr/bin/env bun
// DIAGNOSTIC — separate host CPU contention from a real overlay regression
// in the perf-budget check.
//
// perf-budget asserts an absolute wall-clock TBT budget. TBT measures
// main-thread blocking, and the main thread of a headless chromium on a
// shared desktop competes with everything else running. So a failure is
// ambiguous: the overlay may have got slower, or the machine may be busy.
//
// This script makes the ambiguity measurable. Each iteration records a
// PAIR:
//
//   cpuMs   a fixed synthetic integer workload, run on about:blank in the
//           same browser with no app loaded. Its wall time is a pure
//           function of CPU available to a chromium main thread. Idle
//           machine -> a floor; contended machine -> a multiple of it.
//
//   zoomTbt the same zoom-out TBT perf-budget asserts on.
//
// If zoomTbt tracks cpuMs across iterations, the budget is measuring the
// desktop. If zoomTbt moves while cpuMs stays flat, it is measuring the
// app. Nothing here changes the app or the check; it only measures.
//
// Run: bun scripts/render-checks/diag-perf-attribution.ts [iterations]

import os from 'node:os'
import { chromium, type Browser, type Page } from 'playwright'
import { serveApp } from './lib/serve'
import { gotoView, setEngineView, waitForTilesSettled } from './lib/mapControl'

const CENTER = { lat: 37.7649, lng: -122.4294, zoom: 14 }
const TRAVEL_MODE = 'kid-confident'
const LONG_TASK_THRESHOLD_MS = 50

// Sized so an unloaded machine lands in the low hundreds of ms: big
// enough that scheduler noise does not dominate, small enough that the
// probe itself is not a load test. Integer-only so no GC or FP
// variability enters the number.
const CALIBRATION_ITERS = 12_000_000
const CALIBRATION_REPEATS = 3

/** Median wall time of a fixed integer workload, measured on about:blank
 *  in the same browser. Measures CPU available to a chromium main
 *  thread, with no app work in the page to confound it. */
async function measureCpuMs(browser: Browser): Promise<number> {
  const page = await browser.newPage()
  try {
    await page.goto('about:blank')
    const samples: number[] = await page.evaluate(
      ({ iters, repeats }: { iters: number; repeats: number }) => {
        const out: number[] = []
        for (let r = 0; r < repeats; r++) {
          const t0 = performance.now()
          let x = 0
          for (let i = 0; i < iters; i++) x = (x + i) % 1000003
          out.push(performance.now() - t0)
          if (x === -1) out.push(x) // keep the loop from being optimised away
        }
        return out
      },
      { iters: CALIBRATION_ITERS, repeats: CALIBRATION_REPEATS },
    )
    const sorted = [...samples].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
  } finally {
    await page.close()
  }
}

async function installLongTaskObserver(page: Page): Promise<void> {
  await page.addInitScript(() => {
    ;(window as unknown as { __longTasks: number[] }).__longTasks = []
    try {
      const obs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          ;(window as unknown as { __longTasks: number[] }).__longTasks.push(entry.duration)
        }
      })
      obs.observe({ entryTypes: ['longtask'] })
    } catch {
      /* unsupported -> empty list, same fail-open as perf-budget.ts */
    }
  })
}

const readLongTasks = (page: Page): Promise<number[]> =>
  page.evaluate(() => (window as unknown as { __longTasks?: number[] }).__longTasks ?? [])

const tbt = (durations: number[]): number =>
  durations.reduce((sum, d) => sum + Math.max(0, d - LONG_TASK_THRESHOLD_MS), 0)

interface Row {
  n: number
  cpuBeforeMs: number
  cpuAfterMs: number
  loadAvg1: number
  loadTbt: number
  loadTasks: number
  zoomTbt: number
  zoomTasks: number
}

async function oneIteration(browser: Browser, baseUrl: string, n: number): Promise<Row> {
  const cpuBeforeMs = await measureCpuMs(browser)
  const loadAvg1 = os.loadavg()[0]

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  try {
    await installLongTaskObserver(page)
    await gotoView(page, baseUrl, CENTER, { travelMode: TRAVEL_MODE })
    await waitForTilesSettled(page)
    const loadTasksArr = await readLongTasks(page)

    await page.evaluate(() => {
      ;(window as unknown as { __longTasks: number[] }).__longTasks = []
    })
    await setEngineView(page, { lat: CENTER.lat, lng: CENTER.lng, zoom: CENTER.zoom - 3 })
    await waitForTilesSettled(page)
    const zoomTasksArr = await readLongTasks(page)

    // After, not only before: a contender that arrived mid-iteration
    // would otherwise be invisible to the pairing.
    const cpuAfterMs = await measureCpuMs(browser)

    return {
      n,
      cpuBeforeMs,
      cpuAfterMs,
      loadAvg1,
      loadTbt: tbt(loadTasksArr),
      loadTasks: loadTasksArr.length,
      zoomTbt: tbt(zoomTasksArr),
      zoomTasks: zoomTasksArr.length,
    }
  } finally {
    await page.close()
  }
}

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx
    const b = ys[i] - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  return dx === 0 || dy === 0 ? NaN : num / Math.sqrt(dx * dy)
}

const iterations = Number(process.argv[2] ?? 5)

const app = await serveApp()
const browser = await chromium.launch()
const rows: Row[] = []
try {
  console.log(`serving: ${app.url} (${app.mode})`)
  console.log(`host: ${os.cpus().length} cpus, loadavg ${os.loadavg().map((l) => l.toFixed(2)).join(' ')}`)
  console.log(`calibration: ${CALIBRATION_ITERS.toLocaleString()} iters x ${CALIBRATION_REPEATS}, median\n`)

  for (let n = 1; n <= iterations; n++) {
    const row = await oneIteration(browser, app.url, n)
    rows.push(row)
    console.log(
      `#${row.n}  cpu ${row.cpuBeforeMs.toFixed(0)}->${row.cpuAfterMs.toFixed(0)}ms  ` +
        `load1 ${row.loadAvg1.toFixed(2)}  ` +
        `loadTbt ${row.loadTbt.toFixed(0)}ms/${row.loadTasks}  ` +
        `zoomTbt ${row.zoomTbt.toFixed(0)}ms/${row.zoomTasks}`,
    )
  }
} finally {
  await browser.close()
  await app.stop()
}

if (rows.length >= 3) {
  const cpu = rows.map((r) => (r.cpuBeforeMs + r.cpuAfterMs) / 2)
  console.log('\n--- attribution ---')
  console.log(`cpu       min ${Math.min(...cpu).toFixed(0)}ms  max ${Math.max(...cpu).toFixed(0)}ms  spread x${(Math.max(...cpu) / Math.min(...cpu)).toFixed(2)}`)
  const z = rows.map((r) => r.zoomTbt)
  const l = rows.map((r) => r.loadTbt)
  console.log(`zoomTbt   min ${Math.min(...z).toFixed(0)}ms  max ${Math.max(...z).toFixed(0)}ms  spread x${(Math.max(...z) / Math.min(...z)).toFixed(2)}`)
  console.log(`loadTbt   min ${Math.min(...l).toFixed(0)}ms  max ${Math.max(...l).toFixed(0)}ms  spread x${(Math.max(...l) / Math.min(...l)).toFixed(2)}`)
  console.log(`r(cpu, zoomTbt) = ${pearson(cpu, z).toFixed(3)}`)
  console.log(`r(cpu, loadTbt) = ${pearson(cpu, l).toFixed(3)}`)
  console.log('\nA high positive r means the budget is measuring the desktop, not the overlay.')
}

console.log('\n' + JSON.stringify(rows, null, 2))
