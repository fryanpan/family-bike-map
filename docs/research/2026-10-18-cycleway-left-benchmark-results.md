# Routing benchmark — 2026-10-18 — read every cycleway side

Gate for the `classifyEdge` per-side cycleway fix. **PASS.** Routes-found holds
at 22/22 (Berlin) and 17/17 (SF) on every mode. No mode lost preferred-%;
five of ten mode/city figures rose by 1pp and the rest are unchanged.

## Baseline

Compared against `2026-10-18-routing-benchmark-results.md`, measured earlier
today on the commit this branch sits on. Same-day baseline, so two months of
live OSM drift is removed as a confound — unlike that file, which had to
reason about drift against an August run.

## What the change does

`classifyEdge` never read `cycleway:left`, and the `??` chain it used stopped
at any key that was merely *present* — so a `cycleway:right=no` masked a real
facility on another side. Each side is now tested independently.

Measured on live Overpass before touching the code
(`scripts/diag-cycleway-left.ts`): of the ways `buildQuery()` already fetches,
**98 in central SF and 63 in central Berlin** had their only facility on a side
`classifyEdge` could not see. 149 change pathLevel once it can:

| SF | n | | Berlin | n |
|---|---|---|---|---|
| 2b → 2a | 32 | | 2b → 2a | 24 |
| 4 → 1a | 32 | | 1b → 1a | 10 |
| 3 → 2a | 14 | | 4 → 3 | 9 |
| 2b → 1a | 9 | | 2b → 3 | 3 |
| 4 → 3 | 5 | | 2b → 1a | 3 |
| other | 6 | | 4 → 1a | 2 |

Not every move is an upgrade: 1 SF and 3 Berlin ways go **2b → 3**. Those are
painted lanes on streets above the 2a speed ceiling — previously invisible as
bike infra and therefore scored as ordinary quiet street, now correctly
recognised as a lane on a road too fast to count as calmed. That demotion is
the kid-first framing working, not a regression.

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

## Reading the size of the effect

161 ways change tier but the route figures move by at most 1pp, which is the
expected shape rather than a sign the fix did nothing. The newly-visible ways
are scattered one-sided segments; A* only takes one where it already lies on a
good path. The benchmark measures 39 fixed origin-destination pairs, so it
samples a thin slice of the corpus. The browse overlay is where a user meets
the other 160 ways, and it has no equivalent metric.

## Limits of this run

- `--no-external`, so Valhalla and BRouter were skipped. They are benchmark-only.
- **No overlay verification.** This changes what the browse map paints for 161
  ways across two cities and `.claude/rules/rendering-changes.md` applies, but
  the harness that would check it is itself under repair in #232 — it can
  report green against a map that never rendered. Prod spot-checks on this
  branch are not possible before merge; the honest statement is that the
  rendering side is unverified, not that it is fine.
- Graph edge counts move slightly (Berlin kid-traffic-savvy 1,293,643 →
  1,293,657) because edges that stop being bridge-walks re-enter as ridable.

## Also run

`bunx tsc --noEmit` clean. `bun test` 806 pass / 0 fail, including 10 new cases
pinning per-side reads, the `=no` masking case, and the deliberate
`shared_lane` exclusion.
