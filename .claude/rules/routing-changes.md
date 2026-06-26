# Routing Changes

Routing quality is our core product differentiator. Regressions are invisible
until a user notices their route got worse — and by then trust is lost. Treat
routing code as load-bearing.

## What counts as a nontrivial routing change

Any edit that could plausibly change the *set of routes returned*, the
*shape of chosen routes*, or the *cost of any edge*:

- `src/services/clientRouter.ts` — graph builder, A* distance fn, bridge-walk rule
- `src/data/modes.ts` — any `ModeRule` field, `applyModeRule`
- `src/utils/lts.ts` — LTS tier logic, `carFree` / `bikePriority` / `bikeInfra` flags
- `src/utils/classify.ts` — `isBadSurface`, `PROFILE_LEGEND`, `getDefaultPreferredItems`
- `src/services/overpass.ts` — `classifyOsmTagsToItem`, the Overpass query itself
- Any new region profile in `src/data/cityProfiles/`

A cosmetic rename or a pure comment edit in these files does not count.

## Diagnosing a reported regression

When a handoff, bug report, or user says "route X got worse," **isolate which
cost term is responsible before fixing — by ablation, not by trusting the
report's hypothesis.** Reproducing the route shows the symptom, not the cause.

1. Reproduce the regressed route(s) locally.
2. Ablate: zero each cost term in turn (turn penalty, signal/stop wait, ascent,
   distance/speed) and re-route. The term whose removal restores the expected
   route is the culprit.
3. Fix the implicated term, then run the benchmark gate below.

A named cause is a lead, not a diagnosis: on 2026-06-12 a handoff blamed turn
costs for two regressions; that fix was built and reverted — ablation showed
ascent cost was the real cause (PRs #203/#204).

## Required workflow

1. **Before merging**, run `bun scripts/benchmark-routing.ts` (add
   `--no-external` if you just need a quick client-only sanity check).
2. **Compare against the most recent benchmark** in
   `docs/research/YYYY-MM-DD-routing-benchmark-results.md`. If routes-found
   drops, avg-preferred-% drops by more than ~3pp, or a previously-passing
   pair now FAILs, stop and diagnose before shipping.
3. **Save a new result file** `docs/research/YYYY-MM-DD-routing-benchmark-results.md`
   with the current date, the before/after delta, and a short interpretation
   (why did things change, is the change intentional, are there follow-ups).
4. **Commit the result file with the code change**, not as a separate PR.
   The benchmark is the evidence the change is safe — it belongs next to
   the code.

## Why this rule exists

On 2026-04-16 the Layer 1.5 refactor shipped a regression that collapsed
kid-confident routing from 16/16 to 5/22 and broke kid-traffic-savvy
entirely. Production users noticed; nobody running the code had noticed
beforehand. The refactor was functionally correct per its tests but
destroyed the "bridge-walk across bad gaps" connectivity invariant — a
behaviour that had no unit test because it's an emergent property of the
graph, not a function contract. A benchmark run would have caught it in
30 seconds. See `docs/research/2026-04-16-routing-benchmark-results.md`.
