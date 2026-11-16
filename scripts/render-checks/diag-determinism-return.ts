#!/usr/bin/env bun
// DIAGNOSTIC for the determinism FAIL: the pan-away-and-return leg settles
// at ~11.3k painted px against the cold load's ~31.5k. `screenshotWhenPaintSettles`
// already requires 3 consecutive identical counts, so the shortfall is not an
// early screenshot — but "converged" could still be a state that resolves
// later. This samples the painted count for 90s past convergence on BOTH legs
// and counts the tile requests each leg makes, so the shortfall is attributed
// to one of: (a) paint arrives late, (b) the app never re-requests the tiles,
// (c) the app requests them and does not paint the answer.
import { chromium, type Page } from 'playwright'
import { serveApp } from './lib/serve'
import { gotoView, panAwayAndReturn, waitForTilesSettled } from './lib/mapControl'
import { screenshotMapCanvas } from './lib/screenshot'
import { paintedMask, countPainted } from './lib/pixels'

const TARGET = { lat: 37.7649, lng: -122.4294, zoom: 14 }
const MODE = 'kid-confident'
const SAMPLE_MS = 5000
const SAMPLES = Number(process.env.DIAG_SAMPLES ?? 18) // 18 x 5s covers the 90s tail; set DIAG_SAMPLES=3 once the tail is known flat

type Req = { url: string; status: number | null }

function instrument(page: Page): Req[] {
  const reqs: Req[] = []
  page.on('response', (r) => {
    const u = r.url()
    if (u.includes('/api/overpass') || u.includes('/api/overview')) reqs.push({ url: u, status: r.status() })
  })
  return reqs
}

// Per-URL statuses. The distinct-status set is not enough: leg B's "elsewhere"
// viewport sits at z10, where the app uses /api/overview, and a local
// wrangler-dev R2 has no overview objects — so a 404 there is an artifact of
// the harness, not of the return. Attributing the shortfall needs to know
// WHICH request 404'd, split before vs after the return.
function report(label: string, reqs: Req[], splitAt: number): void {
  const show = (rs: Req[], when: string) => {
    if (rs.length === 0) return
    const byKey = new Map<string, number>()
    for (const r of rs) {
      const u = new URL(r.url)
      const key = `${u.pathname} ${r.status}`
      byKey.set(key, (byKey.get(key) ?? 0) + 1)
    }
    console.log(`  ${label} ${when}:`)
    for (const [k, n] of [...byKey].sort()) console.log(`      ${k} x${n}`)
    for (const r of rs) {
      if (r.status !== 200) console.log(`      non-200: ${r.status} ${r.url}`)
    }
  }
  show(reqs.slice(0, splitAt), 'before return')
  show(reqs.slice(splitAt), splitAt === 0 ? 'all requests' : 'during/after return')
}

async function sample(page: Page, label: string): Promise<number[]> {
  const counts: number[] = []
  for (let i = 0; i < SAMPLES; i++) {
    const n = countPainted(paintedMask(await screenshotMapCanvas(page)))
    counts.push(n)
    console.log(`  ${label} t+${(i * SAMPLE_MS) / 1000}s  painted ${n}`)
    if (i < SAMPLES - 1) await page.waitForTimeout(SAMPLE_MS)
  }
  return counts
}

const app = await serveApp()
const browser = await chromium.launch()
try {
  console.log('--- leg A: cold load straight to target ---')
  const a = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const reqA = instrument(a)
  await gotoView(a, app.url, TARGET, { travelMode: MODE })
  await waitForTilesSettled(a)
  const countsA = await sample(a, 'A')
  console.log(`  A tile requests: ${reqA.length}`)
  report('A', reqA, 0)
  await a.close()

  console.log('--- leg B: load elsewhere, pan away, return to target ---')
  const b = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const reqB = instrument(b)
  const elsewhere = { lat: TARGET.lat + 0.3, lng: TARGET.lng - 0.3, zoom: 10 }
  await gotoView(b, app.url, elsewhere, { travelMode: MODE })
  const beforeReturn = reqB.length
  await panAwayAndReturn(b, TARGET)
  await waitForTilesSettled(b)
  const countsB = await sample(b, 'B')
  console.log(`  B tile requests total: ${reqB.length}  (before return: ${beforeReturn}, during/after return: ${reqB.length - beforeReturn})`)
  report('B', reqB, beforeReturn)
  await b.close()

  const fin = (c: number[]) => ({ first: c[0], max: Math.max(...c), last: c[c.length - 1] })
  console.log('\n=== verdict input ===')
  console.log('A', JSON.stringify(fin(countsA)))
  console.log('B', JSON.stringify(fin(countsB)))
} finally {
  await browser.close().catch(() => {})
  await app.stop()
}
