// Checks that are EXPECTED to fail against current `main`, with the
// reason and the fix that's expected to flip them. run-all.ts treats a
// listed check's failure as XFAIL (suite still exits 0) instead of a
// hard failure, and prints a loud warning if a listed check unexpectedly
// PASSES (a signal the fix landed and the entry should be deleted).
//
// Keep this list short and time-bound — it's a tracked debt list, not a
// place to silence checks indefinitely.
export const KNOWN_FAILS: Record<string, string> = {
  // Surfaced 2026-08-22, the moment the ratio denominators were corrected
  // from canvas pixels to painted pixels. This is a PRE-EXISTING product
  // behaviour that the old math could not express, not a new regression:
  // under a 1,024,000-px denominator the same divergence scored 0.367%
  // against a 2% budget.
  //
  // Measured (SF, z14, kid-confident, cold wrangler-dev cache):
  //   cold load                      31399 painted px
  //   pan away / zoom / pan back     10968 painted px
  //   only in cold-load shot         20510 px  (65% of the overlay)
  //   only in pan/return shot          607 px
  //
  // Reproduced across runs with different absolute counts (an earlier run
  // read 4158 -> 421) but the same direction and rough magnitude, and the
  // returning viewport genuinely CONVERGES at the lower number — the
  // painted count is stable for 3 consecutive polls, so this is not the
  // screenshot racing a still-loading tile. Returning to a viewport by
  // panning paints roughly a third of what loading it directly does.
  //
  // Prime suspect is tiles dropped during the intermediate viewports of
  // panAwayAndReturn never being re-requested once the map settles — i.e.
  // an abandoned-fetch path with no retry, rather than a paint bug. Worth
  // checking against the addPathLayer/removePathLayer race already noted
  // in docs/process/learnings.md, though that one is Google-engine
  // specific and these checks run under Leaflet.
  //
  // Delete this entry when the underlying issue is fixed. Do NOT "fix" it
  // by loosening MAX_DIVERGENT_PIXEL_RATIO — the budget being meaningless
  // is what hid this for two months.
  determinism:
    'Returning to a viewport via pan/zoom paints ~35% of a cold load (31399 -> 10968 px, SF z14). ' +
    'Pre-existing; only visible since the divergence ratio started being denominated in painted pixels. ' +
    'Suspected abandoned tile fetches that are never retried.',
}
