// Checks that are EXPECTED to fail against current `main`, with the
// reason and the fix that's expected to flip them. run-all.ts treats a
// listed check's failure as XFAIL (suite still exits 0) instead of a
// hard failure, and prints a loud warning if a listed check unexpectedly
// PASSES (a signal the fix landed and the entry should be deleted).
//
// Keep this list short and time-bound — it's a tracked debt list, not a
// place to silence checks indefinitely.
export const KNOWN_FAILS: Record<string, string> = {
  'always-visible': [
    'Overlay does not guarantee a minimum painted pixel count at citywide',
    'zoom (z11-z12) on current main — sibling PR feat/always-visible-overlay',
    'fixes this. Delete this entry once that PR merges and this check',
    'passes for real.',
  ].join(' '),
}
