# Routing Benchmark Results — 2026-04-16

## Context
Run after two routing fixes:

1. **Bridge-walking restored** (`src/services/clientRouter.ts`). The Layer 1.5
   refactor had turned `applyModeRule`'s rejects into hard drops, destroying
   connectivity. Now rejected-for-riding edges enter the graph at
   `walkingSpeedKmh` with `isWalking: true` — except for motorway/trunk and
   roads explicitly tagged `sidewalk=no`. This restores the core innovation:
   "any bad segment is still connected by walking the bike on the sidewalk,
   highly penalized by the walking-speed cost."
2. **Mode-rule fixes** (`src/data/modes.ts`). `kid-confident` now rides
   Fahrradstraßen at full riding speed (not `slowSpeedKmh`).
   `kid-traffic-savvy` LTS 2 speed cap raised 30 → 50 km/h to match
   Furth's painted-lane criterion and admit Berlin's untagged tertiary
   streets.

## Setup
- **Modes:** all 5 (kid-starting-out, kid-confident, kid-traffic-savvy, carrying-kid, training)
- **City:** Berlin
- **Engine:** client-side ngraph.path A* on Overpass tile data (external
  engines skipped with `--no-external`)
- **Test routes:** 22 pairs (Home/School × 10 destinations + 2 extras)
- **Scoring:** Preferred % = route distance on each mode's preferred
  infrastructure; Walk % = route distance the rider walks the bike

## Summary

| Mode | Routes found | Avg distance | Avg time | Avg preferred | Avg walk | Graph nodes | Graph edges |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| kid-starting-out | 20/22 | 5.6 km | 101 min | 52% | 39% | 634K | 1.21M |
| kid-confident | 20/22 | 5.9 km | 63 min | 44% | 10% | 672K | 1.29M |
| kid-traffic-savvy | 20/22 | 5.5 km | 27 min | **88%** | 3% | 671K | 1.29M |
| carrying-kid | 20/22 | 5.8 km | 26 min | **89%** | 6% | 665K | 1.28M |
| training | 20/22 | 5.9 km | 17 min | **89%** | 6% | 665K | 1.28M |

The 2 failing pairs (`SSE Schwimmhalle` × 2) are outside the Berlin tile
bbox the benchmark fetches — not a routing problem.

## vs. 2026-04-11 (pre-Layer-1.5 `toddler` mode)

| Engine | Routes found | Avg preferred % |
|--------|:-----------:|:---------------:|
| Old client (toddler) | 16/16 | 54% |
| New client (kid-confident, closest analog) | 20/22 | 44% |
| New client (kid-traffic-savvy) | 20/22 | 88% |

Kid-confident is ~10pp lower than the old toddler preferred % because
it's a legitimately narrower mode (LTS 1 only), while the old toddler
mode effectively mixed behaviors from several of the new modes. The
relevant reference for "same coverage as before" is kid-traffic-savvy,
which beats the old toddler benchmark substantially.

## vs. broken-state earlier today (before bridge-walk restoration)

| Mode | Before | After | Δ routes |
|------|:---:|:---:|:---:|
| kid-starting-out | 0/22 | 20/22 | +20 |
| kid-confident | 5/22 | 20/22 | +15 |
| kid-traffic-savvy | 13/22 | 20/22 | +7 |
| carrying-kid | 8/22 | 20/22 | +12 |
| training | 8/22 | 20/22 | +12 |

## Per-route × mode (preferred %)

| Pair | kid-starting-out | kid-confident | kid-traffic-savvy | carrying-kid | training |
|---|:---:|:---:|:---:|:---:|:---:|
| Home → Berlin Zoo | 76% | 62% | 79% | 96% | 96% |
| Home → Hamburger Bahnhof | 51% | 31% | 88% | 96% | 96% |
| Home → Alexanderplatz | 29% | 33% | 97% | 96% | 95% |
| Home → Fischerinsel | 34% | 33% | 98% | 97% | 97% |
| Home → Humboldt Forum | 26% | 33% | 98% | 98% | 98% |
| Home → Nonne und Zwerg | 53% | 51% | 89% | 88% | 88% |
| Home → Stadtbad Neukölln | 76% | 71% | 93% | 77% | 77% |
| Home → Garten der Welt | 77% | 44% | 85% | 81% | 82% |
| Home → SSE Schwimmhalle | FAIL | FAIL | FAIL | FAIL | FAIL |
| Home → Ararat Bergmannstr | 70% | 62% | 94% | 74% | 58% |
| School → Berlin Zoo | 74% | 65% | 81% | 94% | 94% |
| School → Hamburger Bahnhof | 44% | 26% | 88% | 93% | 93% |
| School → Alexanderplatz | 21% | 22% | 90% | 91% | 91% |
| School → Fischerinsel | 0% | 20% | 94% | 93% | 93% |
| School → Humboldt Forum | 6% | 22% | 93% | 93% | 93% |
| School → Nonne und Zwerg | 72% | 70% | 87% | 80% | 80% |
| School → Stadtbad Neukölln | 67% | 56% | 93% | 88% | 87% |
| School → Garten der Welt | 72% | 38% | 83% | 75% | 76% |
| School → SSE Schwimmhalle | FAIL | FAIL | FAIL | FAIL | FAIL |
| School → Ararat Bergmannstr | 69% | 62% | 93% | 91% | 90% |
| Brandenburger Tor → Berlin Zoo | 58% | 52% | 82% | 89% | 89% |
| Thaipark → Tranxx | 67% | 35% | 60% | 95% | 98% |

## Interpretation
- **kid-starting-out**: 39% walking is expected — this mode is strict
  (car-free or bike-prioritized only) and central Berlin lacks enough
  such infra to ride end-to-end. The router walks the kid across
  Hauptstraßen and then resumes riding.
- **kid-confident**: 10% walk is a healthy mix — rides full LTS 1
  (including quiet residential) end-to-end where possible, walks the
  occasional arterial crossing.
- **kid-traffic-savvy**: only 3% walk, 88% preferred. The LTS 2 unlock
  means Berlin's painted-lane tertiary network connects cleanly.
- **carrying-kid / training**: the 94%+ single-route preferred % on long
  runs (Alexanderplatz, Humboldt Forum, etc.) shows the speed-based
  costing is routing onto the high-quality Radverkehrsnetz instead of
  primary arterials.
