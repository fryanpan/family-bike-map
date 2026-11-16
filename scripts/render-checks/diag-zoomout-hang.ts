#!/usr/bin/env bun
// DIAG — perf-budget's zoom-out phase TIMEOUTs at 30s (2026-11-14 suite run,
// and the same hang recorded 2026-07-11). This splits that phase into its
// four sub-calls and bounds each one separately, so the output says WHICH
// call waits and for how long, rather than that the phase as a whole did.
//
// The suspicion the perf-budget comment records is `page.evaluate` waiting on
// a blocked main thread. That is a hypothesis; this measures it. A
// requestAnimationFrame heartbeat installed before the zoom records the
// longest gap between frames, which is the main thread's block length as the
// page itself sees it — independent of anything Playwright can observe.

import { chromium, type Page } from 'playwright'
import { serveApp } from './lib/serve'
import { gotoView, setEngineView } from './lib/mapControl'
import { closeBrowser } from './lib/bounds'

const CENTER = { lat: 37.7649, lng: -122.4294, zoom: 14 }
const TRAVEL_MODE = 'kid-confident'
const ITERS = Number(process.env.ITERS ?? 2)

async function timed<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T | null> {
  const t0 = Date.now()
  try {
    const out = await Promise.race([
      fn(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('CAP')), ms)),
    ])
    console.log(`    ${label}: ${Date.now() - t0}ms`)
    return out as T
  } catch (err) {
    const why = (err as Error).message === 'CAP' ? `HUNG past ${ms}ms` : (err as Error).message.split('\n')[0]
    console.log(`    ${label}: ${Date.now() - t0}ms  ${why}`)
    return null
  }
}

/** Longest gap between animation frames = how long the main thread was
 *  blocked, measured inside the page. Survives a blocked thread because it
 *  only reports after the thread frees up. */
async function installFrameHeartbeat(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __maxFrameGap: number; __lastFrame: number }
    w.__maxFrameGap = 0
    w.__lastFrame = performance.now()
    const tick = () => {
      const now = performance.now()
      const gap = now - w.__lastFrame
      if (gap > w.__maxFrameGap) w.__maxFrameGap = gap
      w.__lastFrame = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

async function oneIteration(baseUrl: string, n: number): Promise<void> {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
    await page.addInitScript(() => {
      const w = window as unknown as { __longTasks: number[] }
      w.__longTasks = []
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) w.__longTasks.push(e.duration)
        }).observe({ entryTypes: ['longtask'] })
      } catch { /* no longtask support */ }
    })

    console.log(`\n[${n}] load`)
    await gotoView(page, baseUrl, CENTER, { travelMode: TRAVEL_MODE })
    await timed('load: indicator attached', 5000, () =>
      page.waitForSelector('.tile-loading-boxes', { state: 'attached', timeout: 4000 }))
    await timed('load: indicator hidden', 20000, () =>
      page.waitForSelector('.tile-loading-boxes', { state: 'hidden', timeout: 15000 }))
    await timed('load: readLongTasks', 20000, () =>
      page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks.length))

    console.log(`[${n}] zoom out to z${CENTER.zoom - 3}`)
    await page.evaluate(() => { (window as unknown as { __longTasks: number[] }).__longTasks = [] })
    await installFrameHeartbeat(page)
    await setEngineView(page, { lat: CENTER.lat, lng: CENTER.lng, zoom: CENTER.zoom - 3 })

    await timed('zoom: indicator attached', 5000, () =>
      page.waitForSelector('.tile-loading-boxes', { state: 'attached', timeout: 4000 }))
    await timed('zoom: indicator hidden', 20000, () =>
      page.waitForSelector('.tile-loading-boxes', { state: 'hidden', timeout: 15000 }))
    await timed('zoom: waitForTimeout(500)', 10000, () => page.waitForTimeout(500))
    const tasks = await timed('zoom: readLongTasks', 90000, () =>
      page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks))
    const gap = await timed('zoom: maxFrameGap', 30000, () =>
      page.evaluate(() => (window as unknown as { __maxFrameGap: number }).__maxFrameGap))

    if (tasks) {
      const sorted = [...(tasks as number[])].sort((a, b) => b - a)
      const tbt = (tasks as number[]).reduce((s, d) => s + Math.max(0, d - 50), 0)
      console.log(`    zoom tasks ${sorted.length}  tbt ${tbt.toFixed(0)}ms  longest ${sorted.slice(0, 3).map((d) => d.toFixed(0)).join(', ')}ms`)
    }
    if (gap != null) console.log(`    longest frame gap: ${(gap as number).toFixed(0)}ms`)
  } finally {
    await closeBrowser(browser)
  }
}

const app = await serveApp()
console.log(`serving: ${app.url}`)
console.log(`host: ${navigator.hardwareConcurrency} cpus, loadavg ${(await Bun.$`sysctl -n vm.loadavg`.text()).trim()}`)
try {
  for (let i = 1; i <= ITERS; i++) await oneIteration(app.url, i)
} finally {
  await app.stop()
}
