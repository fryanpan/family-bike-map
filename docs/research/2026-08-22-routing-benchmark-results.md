# Routing benchmark — 2026-08-22 (maxspeed units + calmed-street ceiling) — GATE PASSED

Gate run for the fix to Bryan's report that **Folsom St and 17th St were missing
from the SF Mission overlay** for kid-traffic-savvy. The change is in
`src/utils/lts.ts`: parse `maxspeed` units properly, introduce
`QUIET_STREET_MAX_KMH = 40` as the pathLevel-2a ceiling (was a bare `30`), and
drop the untagged road-class speed guess for `tertiary` from 50 to 40.

Client-only runs (`--no-external`), both cities, **0 failed tiles on every run
reported here**. See "Runs that were discarded" below — this took six attempts
and the discards are the interesting part.

## Verdict

**PASS.** Berlin is byte-identical. SF improves on every mode that accepts
pathLevel 2a and is unchanged on the two that don't. Routes-found holds at
22/22 (Berlin) and 17/17 (SF) on both sides. No mode lost preferred-%.

## Berlin (22 pairs) — zero delta

`diff` of the full summary, level-breakdown, AND per-route × mode tables between
`main` and the branch reports **no differences at all**. Every figure matches:
routes found, distance, time, preferred-%, walk-%, turns, graph nodes, graph
edges, and all six LTS columns.

| Mode | Found | Preferred (main → branch) | LTS 2a |
|------|-------|---------------------------|--------|
| kid-starting-out  | 22/22 → 22/22 | 52% → 52% | 4% → 4% |
| kid-confident     | 22/22 → 22/22 | 66% → 66% | 4% → 4% |
| kid-traffic-savvy | 22/22 → 22/22 | 67% → 67% | 5% → 5% |
| carrying-kid      | 22/22 → 22/22 | 57% → 57% | 5% → 5% |
| training          | 22/22 → 22/22 | 46% → 46% | 6% → 6% |

This is the predicted result and the reason a single **global** 40 km/h ceiling
was chosen over a per-city threshold. A full-corpus classify over live OSM found
only **3 of 40,600** central-Berlin highway ways change pathLevel, because
Berlin streets are posted 30 or 50 and nothing sits between — so raising the
ceiling from 30 to 40 admits nothing new there. None of those 3 ways falls on a
benchmarked route.

The clean `main` run also reproduces the recorded 2026-07-03 baseline
(50/66/67/56/46 → 52/66/67/57/46), confirming a stable comparison base.

## SF (17 pairs) — large gain, exactly where predicted

| Mode | Found | Preferred (main → branch) | Δ | Walk-% | LTS 2a | LTS 3 |
|------|-------|---------------------------|---|--------|--------|-------|
| kid-starting-out  | 17/17 → 17/17 | 28% → 28% | 0 | 60% → 60% | 5% → 16% | 12% → 2% |
| kid-confident     | 17/17 → 17/17 | 41% → 41% | 0 | 49% → 49% | 3% → 15% | 13% → 1% |
| kid-traffic-savvy | 17/17 → 17/17 | 50% → 61% | **+11** | 5% → 1% | 10% → 17% | 4% → 1% |
| carrying-kid      | 17/17 → 17/17 | 48% → 54% | **+6** | 5% → 2% | 13% → 18% | 3% → 2% |
| training          | 17/17 → 17/17 | 42% → 51% | **+9** | 0% → 0% | 9% → 19% | 11% → 3% |

Graph sizes differ by <0.05% between the two sides, so this is the classifier
change and nothing else.

**Why the split is exactly right.** The three modes that gain (+11/+6/+9) are
precisely the three whose legend marks `2a` — "Painted bike lane on quiet
street" — as preferred. kid-starting-out (`acceptedLevels: ['1a']`) and
kid-confident (`['1a','1b']`) don't accept 2a and don't count it as preferred,
so their preferred-% is unchanged. The mode-selectivity is the signal that this
is the intended effect rather than noise.

**Those two modes still show 2a rising 5%→16% and 3%→15%** with distance, time
and walk-% held *exactly* constant (5.6 km / 216 min / 60% for kid-starting-out).
That is not a route change — it's the same physical route relabelled. Edges
their mode rule rejects become bridge-walks rather than being dropped, so they
still appear in the level breakdown; the reclassification moved those walked
segments out of '3' and into '2a'.

**LTS 3 collapses across the board** (12→2, 13→1, 4→1, 3→2, 11→3). Routes are
no longer being scored as running on "painted lane on major road" because those
segments were never major roads — they were calmed streets misread through a
km/h comparison against an mph tag. Walk-% also drops for kid-traffic-savvy
(5%→1%) and carrying-kid (5%→2%): fewer forced dismounts once the streets are
classified as rideable.

## Runs that were discarded, and why that matters

Six benchmark runs were needed. The first three were measuring an Overpass
outage, not the code, and two harness defects made that hard to see:

| Run | Failed tiles | Graph (mode 1) | Routes found | Status |
|-----|--------------|----------------|--------------|--------|
| branch, Berlin | many (untracked) | 62k nodes | **0/22** | discarded — outage |
| main, Berlin | 9 | 470k nodes | 19/22 | discarded — outage |
| branch, Berlin | 2 | 636k nodes | 20/22 | discarded — warmer cache than control |
| main, Berlin | 0 | 634k nodes | 22/22 | **baseline** |
| branch, Berlin | 0 | 634k nodes | 22/22 | **reported** |
| main/branch, SF | 0 | ~100k nodes | 17/17 | **reported** |

**A failed tile silently caches as `[]` and the run continues**
(`benchmark-routing.ts:156`). During the outage this produced a confident-looking
all-FAIL table — every pair `FAIL`, every mode `0/22` — from an infrastructure
problem, with the only evidence being warning lines scrolled far above the
summary. A gate that cannot distinguish "the router broke" from "the network
broke" is a gate you cannot act on.

**Tile-loss variance exceeds the gate's own detection band.** The 9-tile-loss
control read kid-confident at 57% against a true value of 66% — a 9pp error,
where the gate is specified to trigger on a ~3pp drop. Nothing in the output
reports whether the fetch was complete, so a degraded run is indistinguishable
from a real regression at a glance.

Both are worth fixing: the summary should carry a completeness figure, and a run
with any failed tile should refuse to print a comparison table.

The Worker edge-caches tiles for 30 days, so retrying is productive rather than
merely hopeful — each partial success warms the cache and later runs lose fewer
tiles. That is what eventually produced the two clean Berlin runs.

## The SF gate had been dead for six weeks

`--city=sf` crashed on `main` before this branch:
`TypeError: undefined is not an object (evaluating 'data.elements.filter')`.

The Worker serves two payload shapes on `/api/overpass` — the raw Overpass
proxy response and the enriched `{meta, ways}` R2 shape. The production client
detects the shape per response; the benchmark only understood the raw one.
Enriched tiles were activated for the SF Bay core on **2026-07-11**; the last
recorded SF numbers are from **2026-07-03**. Nothing caught it because the
script defaults to Berlin and only `--city=sf` reaches the crash.

Fixed in this branch using the production `isEnrichedTilePayload` /
`parseEnrichedTileResponse` helpers, so there is no second parser to drift and
the benchmark measures the same enriched data SF users are served.

## Follow-ups

1. Report tile-fetch completeness in the summary; refuse to print comparison
   tables when any tile failed.
2. Consider running `--city=sf` in the same command as Berlin so the SF half
   cannot silently rot again.
3. Memory grows steeply with tile completeness — a full Berlin fetch reached
   1.2 GB RSS / 1.6 GB heap by the third mode. Not yet a failure, but thin.
