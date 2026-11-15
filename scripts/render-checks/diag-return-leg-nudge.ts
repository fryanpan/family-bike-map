#!/usr/bin/env bun
// DIAGNOSTIC for the determinism shortfall (t-HFGfwaDxcWgh): returning to a
// viewport paints ~36% of what loading it directly paints, and it never
// recovers on its own (18 identical readings over 85 s).
//
// Ablation, not inspection. Two candidate causes predict different
// outcomes for the same cheap intervention:
//
//   (a) TILES MISSING  — the return leg never fetched six of the ten tiles,
//       so the data is not in the page. Forcing a re-render cannot invent
//       it: paint stays at ~11k.
//   (b) PAINT STALE    — the data is there but drawn at a simplification or
//       layer state left over from an intermediate zoom. Forcing a
//       re-render redraws it: paint jumps toward the cold-load figure.
//
// So: drive the return leg, read settled paint, nudge the zoom by a hair
// (14 -> 14.0001 -> 14, below the check's 0.5 tolerance and below any
// plausible tile-level change), read settled paint again.
//
// A jump falsifies (a). A flat reading falsifies (b).

import { chromium, type Page } from 'playwright'
import { serveApp } from './lib/serve'
import { gotoView, panAwayAndReturn, setEngineView, waitForTilesSettled } from './lib/mapControl'
import { screenshotMapCanvas } from './lib/screenshot'
import { paintedMask, countPainted } from './lib/pixels'

// Mirrors checks/determinism.ts. Duplicated rather than imported so this probe
// runs unchanged on any branch, including one where the check does not export
// them — a probe that only builds on the branch carrying the fix cannot
// measure the before arm.
const TARGET_VIEW = { lat: 37.7649, lng: -122.4294, zoom: 14 }
const TRAVEL_MODE = 'kid-confident'

/** Painted-pixel count, read once the figure stops moving (or the cap hits). */
async function paintWhenSettled(page: Page, capMs = 25000): Promise<number> {
  const started = Date.now()
  let last = -1
  for (;;) {
    const n = countPainted(paintedMask(await screenshotMapCanvas(page)))
    if (n === last) return n
    last = n
    if (Date.now() - started > capMs) return n
    await page.waitForTimeout(2000)
  }
}

function trace(page: { on: (e: string, f: (m: { text(): string }) => void) => void }, label: string): string[] {
  const lines: string[] = []
  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('[DIAG') || t.includes('failed:')) lines.push(t)
  })
  void label
  return lines
}


/** Dismiss the IntroCard before any app script runs. The overlay paints under
 *  it otherwise and every pixel reading is degenerate. Done here rather than
 *  in lib/mapControl so this probe runs unchanged on any branch. */
async function newPage(browser: { newPage: (o: unknown) => Promise<Page> }): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => {
    try { localStorage.setItem('bike-route-intro-dismissed', '1') } catch { /* first-party only */ }
  })
  return page
}

import { createServer } from 'node:net'

/** An unused TCP port. serveApp's default (8793) is squatted on this machine
 *  by another local service, and main's serveApp has no free-port search. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))))
    })
  })
}

const app = await serveApp({ port: await freePort(), workerPort: await freePort() })
const browser = await chromium.launch()
try {
  // Reference: cold load straight to the viewport.
  const pageA = await newPage(browser)
  const traceA = trace(pageA, 'cold')
  await gotoView(pageA, app.url, TARGET_VIEW, { travelMode: TRAVEL_MODE })
  await waitForTilesSettled(pageA)
  const cold = await paintWhenSettled(pageA)
  await pageA.close()

  // Return leg, then the nudge.
  const pageB = await newPage(browser)
  const traceB = trace(pageB, 'return')
  const elsewhere = { lat: TARGET_VIEW.lat + 0.3, lng: TARGET_VIEW.lng - 0.3, zoom: 10 }
  await gotoView(pageB, app.url, elsewhere, { travelMode: TRAVEL_MODE })
  await panAwayAndReturn(pageB, TARGET_VIEW)
  await waitForTilesSettled(pageB)
  const before = await paintWhenSettled(pageB)

  await setEngineView(pageB, { ...TARGET_VIEW, zoom: TARGET_VIEW.zoom + 0.0001 })
  await pageB.waitForTimeout(1500)
  await setEngineView(pageB, TARGET_VIEW)
  await waitForTilesSettled(pageB)
  const after = await paintWhenSettled(pageB)

  // Second intervention, in case a sub-tolerance nudge is too small to
  // retrigger whatever is stale: a full re-render via a real zoom step out
  // and back in, still landing on the same viewport.
  await setEngineView(pageB, { ...TARGET_VIEW, zoom: TARGET_VIEW.zoom + 1 })
  await pageB.waitForTimeout(2000)
  await setEngineView(pageB, TARGET_VIEW)
  await waitForTilesSettled(pageB)
  const afterStep = await paintWhenSettled(pageB)
  await pageB.close()

  console.log('\n--- cold leg, last 4 paint traces ---')
  for (const l of traceA.filter((l) => l.includes('DIAG2')).slice(-4)) console.log(`  ${l}`)
  console.log('--- return leg, last 8 paint traces ---')
  for (const l of traceB.filter((l) => l.includes('DIAG2')).slice(-8)) console.log(`  ${l}`)
  const fails = traceB.filter((l) => l.includes('failed:'))
  console.log(`--- return leg, tile fetch failures (${fails.length}) ---`)
  for (const l of fails) console.log(`  ${l}`)

  const pct = (n: number) => (cold === 0 ? 'n/a' : `${((n / cold) * 100).toFixed(1)}% of cold`)
  console.log(`\ncold load                     ${cold} px`)
  console.log(`return leg, settled           ${before} px  (${pct(before)})`)
  console.log(`+ hairline zoom nudge         ${after} px  (${pct(after)})`)
  console.log(`+ full zoom step out and in   ${afterStep} px  (${pct(afterStep)})`)
  const moved = Math.max(after, afterStep) - before
  console.log(
    `\nVERDICT: ${moved > before * 0.2
      ? 'PAINT STALE — a re-render recovered the shortfall, so the data was in the page'
      : 'TILES MISSING — no re-render recovered it, so the data was not in the page'}` +
    ` (re-render recovered ${moved} px)`,
  )
} finally {
  await browser.close()
  await app.stop()
}
