// Checks that are EXPECTED to fail against current `main`, with the
// reason and the fix that's expected to flip them. run-all.ts treats a
// listed check's failure as XFAIL (suite still exits 0) instead of a
// hard failure, and prints a loud warning if a listed check unexpectedly
// PASSES (a signal the fix landed and the entry should be deleted).
//
// Keep this list short and time-bound — it's a tracked debt list, not a
// place to silence checks indefinitely.
//
// Empty as of 2026-10-20. The one entry it held (`determinism`) was
// deleted when scripts/diag-determinism-settle.ts falsified its stated
// cause — see docs/process/learnings.md, "Render-check harness". Short
// version: the shortfall was the screenshot firing before paint
// finished, not tiles being abandoned, and this check now measures the
// invariant honestly rather than carrying a wrong diagnosis.
export const KNOWN_FAILS: Record<string, string> = {}
