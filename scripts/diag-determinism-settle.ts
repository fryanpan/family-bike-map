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

// Imported, not copied: this script spent three weeks explaining the
// determinism check's result while pointing at 37.7638,-122.4152, which is
// not the viewport that check asserts on.
import { TARGET_VIEW, TRAVEL_MODE } from './render-checks/checks/determinism'

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
  // The verdict has to read BOTH numbers. The first version branched only on
  // whether the old method still reproduced the shortfall and then asserted
  // "paint arrives late" — a claim about growth, which it never consulted. On
  // 2026-11-14 it printed exactly that against a measured growth of 1.00x.
  const settledRatio = returned.settled / cold.settled
  const growth = returned.early === 0 ? Infinity : returned.settled / returned.early
  if (settledRatio >= 0.9) {
    console.log(`VERDICT: the return recovers once paint is allowed to settle (ratio ${settledRatio.toFixed(2)}, growth ${growth.toFixed(2)}x).`)
    console.log('         The shortfall under the old method was an early screenshot.')
  } else if (growth >= 1.2) {
    console.log(`VERDICT: paint DOES arrive late (growth ${growth.toFixed(2)}x) but not enough — the return still ends at ratio ${settledRatio.toFixed(2)}.`)
    console.log('         Late arrival is real AND something is missing. Do not treat a long wait as the whole fix.')
  } else {
    console.log(`VERDICT: the return does NOT recover (ratio ${settledRatio.toFixed(2)}) and paint is NOT arriving late (growth ${growth.toFixed(2)}x).`)
    console.log('         "Arrives late" is ruled out by this run. Look at whether the tiles are requested at all —')
    console.log('         diag-determinism-return.ts prints per-URL request counts for both legs.')
  }
} finally {
  await browser.close()
  await app.stop()
}
