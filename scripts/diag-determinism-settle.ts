#!/usr/bin/env bun
// Does the pan/return viewport genuinely paint a third of a cold load, or
// was that reading the screenshot arriving before the tiles did?
//
// known-fails.ts records determinism failing at 31399 -> 10968 px (SF z14)
// and blames "abandoned tile fetches that are never retried". That
// diagnosis was made when the check shot the canvas immediately after
// waitForTilesSettled. #232 replaced that with screenshotWhenPaintSettles,
// which polls for 3 consecutive identical painted counts over up to 60s —
// so a PASS now could mean the bug is fixed OR that the tiles always
// arrived late and the old shot was simply early.
//
// Both readings, same page, same run: `early` is the old method's frame,
// `settled` is the new one's. If early ~= settled, paint really was done
// and the regression is gone. If early << settled, the tiles arrive late
// and the known-fail's "never retried" is wrong — it was never retried
// WITHIN THE WINDOW THE CHECK ALLOWED.
import { chromium } from 'playwright'
import { serveApp } from './render-checks/lib/serve'
import { gotoView, panAwayAndReturn, waitForTilesSettled } from './render-checks/lib/mapControl'
import { screenshotMapCanvas, screenshotWhenPaintSettles } from './render-checks/lib/screenshot'
import { paintedMask, countPainted } from './render-checks/lib/pixels'

const TARGET_VIEW = { lat: 37.7638, lng: -122.4152, zoom: 14 }
const TRAVEL_MODE = 'kid-confident'

async function readBoth(page: import('playwright').Page, label: string) {
  await waitForTilesSettled(page)
  const t0 = Date.now()
  const early = countPainted(paintedMask(await screenshotMapCanvas(page)))
  const settledImg = await screenshotWhenPaintSettles(page)
  const settled = countPainted(paintedMask(settledImg))
  const waitedMs = Date.now() - t0
  const growth = early === 0 ? Infinity : settled / early
  console.log(
    `${label.padEnd(16)} early=${String(early).padStart(6)}  settled=${String(settled).padStart(6)}  ` +
    `growth=${growth.toFixed(2)}x  extra wait=${(waitedMs / 1000).toFixed(1)}s`,
  )
  return { early, settled }
}

const app = await serveApp()
console.log(`serving via ${app.mode} at ${app.url}\n`)
const browser = await chromium.launch()
try {
  const pageA = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await gotoView(pageA, app.url, TARGET_VIEW, { travelMode: TRAVEL_MODE })
  const cold = await readBoth(pageA, 'cold load')
  await pageA.close()

  const pageB = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await gotoView(pageB, app.url, { lat: 37.8044, lng: -122.2712, zoom: 14 }, { travelMode: TRAVEL_MODE })
  await panAwayAndReturn(pageB, TARGET_VIEW)
  const returned = await readBoth(pageB, 'pan/return')
  await pageB.close()

  console.log('')
  console.log(`old method  (early  vs early ): ${cold.early} -> ${returned.early}   ratio ${(returned.early / cold.early).toFixed(2)}`)
  console.log(`new method  (settled vs settled): ${cold.settled} -> ${returned.settled}   ratio ${(returned.settled / cold.settled).toFixed(2)}`)
  console.log('')
  console.log(returned.early / cold.early < 0.6
    ? 'VERDICT: the old method still reproduces the shortfall -> paint arrives late; "never retried" is the wrong diagnosis.'
    : 'VERDICT: the old method no longer reproduces it -> the underlying behaviour changed on main.')
} finally {
  await browser.close()
  await app.stop()
}
