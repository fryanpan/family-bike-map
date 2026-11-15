# Routing benchmark — 2026-10-18 — read every cycleway side

Gate for the per-side cycleway fix in `classifyEdge` **and** for the display-side
drift the first review pass found in `classifyOsmTagsToItem`. **PASS.**
Routes-found holds at 22/22 (Berlin) and 17/17 (SF) on every mode. No mode lost
preferred-%; five of ten mode/city figures rose by 1pp and the rest are unchanged.

## Baseline

Compared against `2026-10-18-routing-benchmark-results.md`, measured earlier
today on the commit this branch sits on. Same-day baseline, so two months of
live OSM drift is removed as a confound — unlike that file, which had to
reason about drift against an August run.

## What the change does

Two bugs, both "a facility exists on a side the code cannot see".

**Routing.** `classifyEdge` never read `cycleway:left`, and the `??` chain it
used stopped at any key that was merely *present* — so a `cycleway:right=no`
("explicitly nothing on this side", very commonly tagged) masked a real facility
on another side.

**Display.** `classifyOsmTagsToItem` did read all four sides, but it tested
`opposite_track` / `opposite_lane` on the plain `cycleway` key only. Once
`classifyEdge` read `opposite_*` on every side the two disagreed: a residential
`cycleway:left=opposite_track` scored as a curb-separated track in routing while
the overlay labelled it **"Bike path"** — `defaultPreferred: true` for every
mode, where the correct "Elevated sidewalk path" is not preferred for
carrying-kid or training. 4 such ways in central SF, 0 in central Berlin. Per
the comment at `overpass.ts`, a non-preferred item also drops the segment to
`slowSpeedKmh`, so the mislabel was not cosmetic.

Both classifiers now read the sides through one exported helper
(`anyCyclewaySide`) over one exported set of facility values, so neither can
drift from the other by reading a different set of sides or a different set of
values. That replaces a comment asking the next reader to keep them in step.

### Scale, measured on live Overpass

`scripts/diag-cycleway-left.ts` reconstructs the old `??` chain locally instead
of calling the current `classifyEdge`, so it reports the same delta whether it
runs before or after the fix. Of the ways `buildQuery()` already fetches
(1,108 SF / 2,021 Berlin), the facility was hidden from the old chain on **98 in
central SF and 64 in central Berlin**. **167 ways change pathLevel** once every
side is read — 108 SF, 59 Berlin:

| SF | n | | Berlin | n |
|---|---|---|---|---|
| 2b → 2a | 32 | | 2b → 2a | 24 |
| 4 → 1a | 32 | | 1b → 1a | 10 |
| 3 → 2a | 14 | | 4 → 3 | 9 |
| 2b → 1a | 9 | | 3 → 1a | 7 |
| 2a → 1a | 6 | | 2b → 3 | 3 |
| 3 → 1a | 5 | | 2b → 1a | 3 |
| 4 → 3 | 5 | | 4 → 1a | 2 |
| 1b → 1a | 2 | | 2a → 1a | 1 |
| 4 → 2a | 2 | | | |
| 2b → 3 | 1 | | | |

Not every move is an upgrade: 1 SF and 3 Berlin ways go **2b → 3**. Those are
painted lanes on streets above the 2a speed ceiling — previously invisible as
bike infra and therefore scored as ordinary quiet street, now correctly
recognised as a lane on a road too fast to count as calmed. That demotion is
the kid-first framing working, not a regression, and `tests/lts.test.ts` pins it
so a future 2a-ceiling edit cannot silently undo it.

## SF (17 pairs)

| Mode | Found | Preferred | Walk |
|------|-------|-----------|------|
| kid-starting-out  | 17/17 → 17/17 | 28% → 28% | 60% → 60% |
| kid-confident     | 17/17 → 17/17 | 41% → **42%** | 49% → 49% |
| kid-traffic-savvy | 17/17 → 17/17 | 61% → **62%** | 1% → 1% |
| carrying-kid      | 17/17 → 17/17 | 54% → **55%** | 2% → **1%** |
| training          | 17/17 → 17/17 | 51% → **52%** | 0% → 0% |

## Berlin (22 pairs)

| Mode | Found | Preferred | LTS 2a |
|------|-------|-----------|--------|
| kid-starting-out  | 22/22 → 22/22 | 52% → 52% | 4% → 4% |
| kid-confident     | 22/22 → 22/22 | 66% → 66% | 4% → 4% |
| kid-traffic-savvy | 22/22 → 22/22 | 68% → **69%** | 5% → 5% |
| carrying-kid      | 22/22 → 22/22 | 60% → 60% | 5% → 5% |
| training          | 22/22 → 22/22 | 46% → 46% | 6% → 6% |

Both cities were re-run after the display-side fix landed and returned figures
identical to the run before it — expected, since that fix changes an item *name*
and the four affected ways are in SF and on none of the 17 sampled pairs.

## Reading the size of the effect

167 ways change tier but the route figures move by at most 1pp, which is the
expected shape rather than a sign the fix did nothing. The newly-visible ways
are scattered one-sided segments; A* only takes one where it already lies on a
good path. The benchmark measures 39 fixed origin-destination pairs, so it
samples a thin slice of the corpus. The browse overlay is where a user meets
the rest, and it has no equivalent metric.

## Limits of this run

- `--no-external`, so Valhalla and BRouter were skipped. They are benchmark-only.
- **No overlay verification.** This changes what the browse map paints for 167
  ways across two cities and `.claude/rules/rendering-changes.md` applies, but
  the harness that would check it is itself under repair in #232 — it can
  report green against a map that never rendered. Prod spot-checks on this
  branch are not possible before merge; the honest statement is that the
  rendering side is unverified, not that it is fine. Performance was not
  measured.
- **The baked enriched tiles are now stale and the incremental updater will not
  notice.** `isPaintedCandidate` (`scripts/pipeline/lib/graph.ts`) and
  `isOverviewCandidate` (`scripts/pipeline/bake-overview.ts`) both call
  `classifyEdge`, and their output is baked into R2 (`componentPaintedLenM`,
  overview membership). `apply-diff.ts` dirties a way when its OSM *content*
  changes, not when classifier *code* changes, so only a full `enrich-region`
  re-bake picks these 167 ways up. Severity is contained — a promoted way's
  baked `componentPaintedLenM` is `null` and `enrichedWayVerdict` only hides on
  a non-null value, so promoted ways fail soft to *shown* and nothing vanishes.
  What can still be wrong is a short neighbour staying hidden because its
  component's baked length is understated, plus low-zoom overview
  under-inclusion. Re-bake tracked separately, since it writes to production R2.
- Graph edge counts move slightly (Berlin kid-traffic-savvy 1,293,643 →
  1,293,657) because edges that stop being bridge-walks re-enter as ridable.

## Also run

`bunx tsc --noEmit` clean. `bun test` 810 pass / 0 fail, including 14 new cases:
per-side reads on both classifiers, the `=no` masking case in both directions,
the deliberate `shared_lane` exclusion, the intentional `2b → 3` demotion,
per-side `share_busway`, and a routing↔display agreement check over per-side
`opposite_*` that fails on the pre-fix `overpass.ts`.
