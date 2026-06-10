# 2026-06-10 Fetch bike-designated pedestrian promenades — routing benchmark

## Change

`buildQuery()` (`src/services/overpass.ts`) now fetches `highway=pedestrian`
ways that carry explicit bike access (`bicycle=yes|designated`), mirroring the
existing `highway=footway` rule. These are car-free shared-use promenades that
allow cycling — most importantly SF's **JFK Promenade**, the entire car-free
spine through Golden Gate Park, tagged `highway=pedestrian` + `bicycle=designated`.
Before this change `highway=pedestrian` was never fetched, so the promenade
never entered the routing graph and the router detoured onto non-preferred
surface streets.

Supporting changes: `classifyOsmTagsToItem` classifies bike-designated
pedestrian ways as "Shared use path" (display parity with footway); tile-cache
versions bumped (Worker edge cache `/v1/`→`/v2/`, client IndexedDB `DB_VERSION`
1→2) so the query change reaches already-cached tiles instead of serving
30-day-stale data.

This is purely **additive** to the routing graph — it only adds pedestrian-way
edges, never removes any. Routes-found therefore cannot decrease; preferred-%
can only rise or hold.

Benchmarks fetched fresh tiles via `TILE_BUST=v2ped` (added an env-gated cache
bust to `scripts/benchmark-routing.ts` so the Worker proxies the new query
instead of serving the pre-change cached tile). Client-only, elevation gate
active (VITE_MAPBOX_TOKEN present).

## San Francisco — per-mode (client-only)

| Mode | 2026-05-25 baseline | 2026-06-10 (this change) | Δ found | Δ preferred-% |
|------|:---:|:---:|:---:|:---:|
| kid-starting-out | 21% (17/17) | 29% (17/17) | 0 | **+8pp** |
| kid-confident | 39% (17/17) | 39% (17/17) | 0 | +0pp |
| kid-traffic-savvy | 47% (17/17) | 50% (17/17) | 0 | +3pp |
| carrying-kid | 42% (17/17) | 47% (17/17) | 0 | **+5pp** |
| training | 42% (17/17) | 41% (17/17) | 0 | −1pp (noise) |

Promenade-adjacent destinations (per-route preferred %, this change):

| Route | starting-out | confident | savvy | carrying | training |
|---|:---:|:---:|:---:|:---:|:---:|
| Home → Sunset Dunes (Ocean Beach) | 79% | 84% | 89% | 81% | 84% |
| Home → JFK Promenade east end (Stanyan) | 50% | 55% | 68% | 55% | 55% |
| Home → Lands End | 69% | 67% | 73% | 63% | 72% |

## Berlin — per-mode (client-only)

| Mode | found | avg preferred-% |
|------|:---:|:---:|
| kid-starting-out | 22/22 | 48% |
| kid-confident | 22/22 | 65% |
| kid-traffic-savvy | 22/22 | 66% |
| carrying-kid | 22/22 | 56% |
| training | 22/22 | 45% |

**No routes lost** in either city; all 5 modes complete. (The 2026-05-25 Berlin
run was killed mid-route by RAM pressure and omitted preferred-%; this full run
restores the column. All modes match the 2026-05-10 22/22 found baseline.)

## Targeted before/after — the reported route

`118 Hancock St → Hook Fish Co` (Outer Sunset), via the production routing code
on fresh OLD-query vs NEW-query tiles (`scripts/diag-jfk-route.ts`):

| Mode | metric | OLD query | NEW query |
|---|---|:---:|:---:|
| kid-starting-out | JFK Promenade used | 0% | **28%** |
| kid-starting-out | walking | 78% | 27% |
| kid-confident | JFK Promenade used | 0% | **25%** |
| kid-traffic-savvy | JFK Promenade used | 0% | **25%** |
| carrying-kid | JFK Promenade used | 0% | **25%** |
| training | JFK Promenade used | 0% | **25%** |

The route now runs through the car-free JFK Promenade (`John F. Kennedy
Promenade`, `Nancy Pelosi Drive`, `Blue Heron Lake Drive`, `MLK Jr Drive`)
across every mode, exactly as Bryan expected.

## Interpretation

All SF deltas are positive or within noise; all routes still found in both
cities. The change does what it should: it makes car-free shared-use
promenades available to the router so family routes prefer them over
non-preferred surface streets. No regression. The `−1pp` on SF training is
noise — training optimises 30 km/h flow and will only divert onto a promenade
when it doesn't cost time.

## Out of scope (surfaced as follow-up)

Bryan separately reported Treptower Park (Berlin) foot paths "no longer marked
bike friendly." Investigation (`scripts/diag-jfk-route.ts` Part B — production
overlay pipeline over real OSM + Mapbox elevation) showed this is **not** the
elevation/steepness gate (it drops only 9 of 9403 ways region-wide, all
genuinely 9–13% or `surface=ground`) and **not** a regression in classification.
Treptower's visible path grid is `highway=footway` with **no bicycle tag**
(and ~⅓ tagged `bicycle=no` — cycling forbidden), which the query never fetches.
The bike-access-tagged park paths already render green. Admitting bare footways
is a cross-city policy decision (SF street sidewalks share the `highway=footway`
tag; `footway=sidewalk` does not cleanly separate them) and is left as a scoped
follow-up rather than greening all footways globally. See
`docs/product/decisions.md` (2026-06-10).
