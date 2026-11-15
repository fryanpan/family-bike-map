// Checks that are EXPECTED to fail against current `main`, with the
// reason and the fix that's expected to flip them. run-all.ts treats a
// listed check's failure as XFAIL (suite still exits 0) instead of a
// hard failure, and prints a loud warning if a listed check unexpectedly
// PASSES (a signal the fix landed and the entry should be deleted).
//
// Keep this list short and time-bound — it's a tracked debt list, not a
// place to silence checks indefinitely.
export const KNOWN_FAILS: Record<string, string> = {
  // RE-ADDED 2026-11-14, having been deleted on 2026-10-20 in 823fd03 on a
  // diagnosis that does not hold. Tracked as t-HFGfwaDxcWgh.
  //
  // What is measured today, hermetic build, SF kid-confident:
  //   37.7649,-122.4294 z14   cold 31473 px   return 11342 px   ratio 0.36
  //   37.7638,-122.4152 z14   cold 27918 px   return 15246 px   ratio 0.55
  //
  // It is a real product behaviour, and it is not an early screenshot:
  // diag-determinism-return.ts samples the returned viewport every 5 s for
  // 85 s and reads 11342 on all 18 samples, and diag-determinism-settle.ts
  // reads growth 1.00x on both legs. The mechanism as far as it is
  // measured: the cold load issues 10 /api/overpass requests and the return
  // leg issues 4, never requesting the other six.
  //
  // 823fd03 deleted this entry because diag-determinism-settle.ts then read
  // the return climbing 11540 -> 27510 (growth 2.38x, +18.8 s), i.e. "the
  // tiles arrive, just after the check gives up". Run unmodified today the
  // same script on the same branch reads growth 1.00x. The gap between the
  // two runs is unexplained and no mechanism is offered for it here.
  //
  // This entry exists so one known product bug does not make the whole
  // suite red for every other change. Delete it when t-HFGfwaDxcWgh lands —
  // do NOT widen MAX_DIVERGENT_PIXEL_RATIO to make it green.
  determinism:
    'A returning viewport paints 0.36-0.55 of a cold load and does not recover: ' +
    'the return leg requests 4 of the 10 tiles the cold load requests. ' +
    'Measured 2026-11-14 on two viewports. Tracked as t-HFGfwaDxcWgh.',
}
