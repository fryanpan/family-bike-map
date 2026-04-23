# 2026-04-23 Smoothness-aware routing benchmark

## Change

`applyModeRule` now treats `smoothness ∈ {bad, very_bad, horrible,
very_horrible, impassable}` as rough — same 5× cost penalty as cobble /
gravel / mud surfaces. Prior behaviour: smoothness was only consulted
for **overlay-hide**; the router happily rode asphalt-but-potholed bike
paths at full speed because `surface=asphalt` passed the rough-check.

Bryan triggered this after spotting single-track bike paths in the
Berlin admin tool tagged `smoothness=bad` / `horrible` still showing
as preferred on kid-starting-out routes.

Explicit rule (from Bryan): `intermediate` is OK, `bad` and worse are
not. Matches `BAD_SMOOTHNESS` already defined in `classify.ts`.

## Scope

- `src/utils/lts.ts` — add `smoothness: string | null` to `LtsClassification`.
- `src/data/modes.ts` — new `BAD_SMOOTHNESS` set (mirrors classify.ts,
  duplicated for the same cycle-avoidance reason as `ROUGH_SURFACES`);
  `applyModeRule` now triggers `roughSurfaceMultiplier` when surface OR
  smoothness is bad.
- `tests/modes.test.ts` — new focused unit tests (+8 tests).
- `tests/overlay.test.ts`, `tests/preferenceParser.test.ts` — add
  `smoothness: null` to fixtures to satisfy the new required field.

## Berlin — per-mode (client-only)

| Mode | Pre-fix (2026-04-22) | Post-fix | Δ |
|------|:---:|:---:|:---:|
| kid-starting-out | 57% (20/22) | 57% (20/22) | — |
| kid-confident | 68% (20/22) | 68% (20/22) | — |
| kid-traffic-savvy | 65% (20/22) | 64% (20/22) | −1pp |
| carrying-kid | 52% (20/22) | 52% (20/22) | — |
| training | 49% (20/22) | 49% (20/22) | — |

No routes dropped. The −1pp on kid-traffic-savvy is plausibly the
router now detouring off a previously-cheap-but-sketchy edge onto a
slightly-less-preferred alternative — exactly the intended behaviour.
Well under the 3pp regression threshold in `.claude/rules/routing-changes.md`.

## San Francisco — per-mode (client-only)

| Mode | Pre-fix | Post-fix | Δ |
|------|:---:|:---:|:---:|
| kid-starting-out | 32% (9/17) | 32% (9/17) | — |
| kid-confident | 51% (9/17) | 51% (9/17) | — |
| kid-traffic-savvy | 52% (9/17) | 52% (9/17) | — |
| carrying-kid | 35% (9/17) | 35% (9/17) | — |
| training | 35% (9/17) | 35% (9/17) | — |

Unchanged. SF has sparser smoothness tagging in OSM than Berlin, so the
fix has nothing to act on for the benchmark corridors.

## Interpretation

The fix is surgical by construction: it only fires on edges that have
explicit `smoothness=bad/…/impassable` tags. Most bike paths don't,
which is why the global preferred-% is essentially flat. The value is
in the specific user-reported case: a cycleway tagged
`smoothness=horrible` now costs 5× and the router picks an alternative
if one exists within that budget.

What this **doesn't** address (noted, not in scope):
- Width filtering. `width` / `est_width` remain unread. Bryan asked
  about them; the honest answer is "we aren't applying a min-width
  check." Adding one is straightforward but was left pending his
  decision on the threshold (1.0m? 1.5m? penalty vs reject?).
- Single-track detection without tagged width. OSM doesn't have a
  clean "single-track" tag for paved bike paths; inferring from
  `highway=path` alone would sweep up too many legitimate paths.

## Test count

`bun test` → 257 pass / 0 fail (was 249 — +8 from new `modes.test.ts`).

## Raw output

- `/tmp/bench-berlin-smoothness.log`
- `/tmp/bench-sf-smoothness.log`
