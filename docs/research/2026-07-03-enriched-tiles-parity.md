# Enriched-tiles parity: real NorCal bake vs runtime production functions

**Date:** 2026-07-03
**Chunk:** C1 of the enriched-tiles plan (`docs/product/plans/enriched-tiles-plan.md`)
**Script:** `scripts/pipeline/diag-parity.ts` (new; reproducible with `--seed 42`)

## What ran

1. **Source data:** Geofabrik `norcal-latest.osm.pbf`, 646 MB, replication
   seq **2776**, timestamp **2026-07-03T04:51:13Z** (downloaded to `data/`,
   gitignored).
2. **Clip:** `osmium extract` to the SF Bay core bbox
   `37.2,-123.1,38.6,-121.6` (tile-aligned), `--strategy=complete_ways` —
   **6.2 s wall**, 218 MB output.
3. **Bake:** `bun scripts/pipeline/enrich-region.ts --pbf data/bayarea-core.osm.pbf
   --out data/tiles/bayarea-core --seq 2776 --built-at 2026-07-03T04:51:13Z`
   — **55.2 s wall**. Output:
   - **213 enriched tiles** (0.1°; the 14×15 bbox grid plus boundary
     overflow tiles, minus empty ocean tiles)
   - **203,501 ways** + **74,267 control nodes** (traffic_signals/stop)
   - DEM: **297 terrarium z=12 tiles fetched over HTTP, 2 disk-cache hits,
     0 voids** (cache under `data/dem-cache/`, so re-bakes are network-free)
4. **Parity diag:** `bun scripts/pipeline/diag-parity.ts --tiles
   data/tiles/bayarea-core --n 200 --seed 42` — **39 s wall** including all
   Mapbox z=12 fetches. Samples 200 of the 213 baked tiles, re-runs the
   production functions on the identical ways:
   - `overlayGradientPct` (src/services/elevation.ts) over the **Mapbox
     terrain-RGB** runtime source — the browser's current overlay path
     (pngjs decoder + prod Referer, per the benchmark-script pattern)
   - `classifyOsmTagsToItem` per mode over the baked tags
   - per-mode SHOW/HIDE verdicts at the production ceilings
     (`getOverlayMaxGradientPct`: 6/8/8/10/15)

Full-NorCal (unclipped) bake is a noted follow-up, not run here: the
Bay-core numbers were the goal, and the current OPL parse holds all node
coords of the coarse-filtered file in one Map — fine at 218 MB input,
untested at 646 MB (likely several GB of node coords; needs either a
node-location store or a per-subregion sweep before Phase 3).

## Sample

- 200 tiles → **193,476 unique real ways** (control nodes excluded,
  multi-tile ways deduped), of which **190,003 are painted candidates**
  (`isPaintedCandidate`: not LTS 4, not a crossing stub, not hidden-surface).
- Baked `demSource: terrarium-v1`; runtime source `mapbox-terrain-rgb`.

## Classification parity: exact

`classifyOsmTagsToItem` ran 967,380 times (5 modes × 193,476 ways) over the
baked tags with **0 errors**. Parity is exact **by construction**: enriched
tiles carry OSM tags verbatim and classification stays client-side (tiles
are mode-agnostic — plan decision), so enriched and Overpass tiles feed the
same classifier the same input. The way-*set* equivalence (PBF filter mirror
vs `buildQuery()`) is pinned verbatim by `tests/pipeline/filter.test.ts`.

Item distribution over the sample (kid-starting-out): Quiet street 111,287;
Bike path 37,473; Painted bike lane on major road 29,181; Shared use path
6,408; Painted bike lane on quiet street 6,136; Protected bike lane on major
road 1,674; others < 400 each; 372 classify to null (LTS 4, never painted).

## Gradient parity: coverage identical, values differ only by DEM source

Null/graded structure agrees perfectly — **zero one-sided nulls** in
193,476 ways:

| class | ways |
|---|---|
| both null (sub-40 m noise floor — geometry-determined, identical) | 43,044 |
| both graded | 150,432 |
| baked-only graded (mapbox void) | **0** |
| runtime-only graded (terrarium void) | **0** |

Where both DEMs grade, the value difference (painted candidates,
149,353 ways):

- |Δgradient|: **mean 0.65 pp, p50 0.02 pp, p90 1.80 pp, p99 8.27 pp, max 67.4 pp**
- within 0.5 pp: **74.6%** · within 1 pp: **83.3%** · within 2 pp: **91.1%**

## Mode-ceiling crossings (the number the chunk asked for)

Ways whose SHOW/HIDE verdict differs between DEMs (null fail-soft = shown),
painted candidates, N = 190,003:

| ceiling | modes | verdict agreement | crossings | hidden by bake only | hidden by runtime (mapbox) only |
|---|---|---|---|---|---|
| 6% | kid-starting-out | **96.61%** | 6,450 | 1,923 | 4,527 |
| 8% | kid-confident, carrying-kid | **97.37%** | 5,000 | 1,543 | 3,457 |
| 10% | kid-traffic-savvy | **97.86%** | 4,063 | 1,285 | 2,778 |
| 15% | training | **99.02%** | 1,858 | 592 | 1,266 |

(All-ways numbers are within 0.05 pp of these.)

## Interpretation

1. **Same-input parity is exact.** The plan's >99% target (measurable
   outcome 4) is about the bake reproducing the production functions on
   identical input — that is exact by construction and pinned by unit tests
   (`computeWayGradientPct` is the single formula behind both
   `overlayGradientPct` and the bake; the classifier is the same import).
   This diag deliberately crosses DEM *sources* to quantify the divergence
   class the plan called expected.

2. **The DEM-source delta is real but bounded, and asymmetric in the good
   direction.** 3.4% of painted candidates change verdict at the strictest
   ceiling (6%), falling to 1.0% at 15%. At every ceiling the runtime
   (Mapbox) side hides ~2.3× more ways than the bake — Mapbox z=12 reads
   *steeper*.

3. **Spot-probing the worst divergences shows Mapbox noise, not bake error.**
   The top-10 |Δ| ways are all short (41–100 m, just above the 40 m floor).
   Per-vertex probe of the worst (way 8929270, Amhurst Ct, Daly City,
   53 m residential): terrarium reads a smooth 156.8→157.3→157.3→159.0 m
   (0.45% after cutoff); Mapbox reads 113.5→136.4→136.4→151.6 m — ±15–23 m
   jumps between vertices ~15 m apart, i.e. 67.8% "grade" on a street that
   is actually near-flat along its axis on a steep hillside. Same pattern on
   way 546971895 (Fairmont Dr, secondary): terrarium smooth 101.5→104.8,
   Mapbox oscillating 112→97→100→91. This is the known encoded-DEM
   inter-pixel-noise artifact class (see learnings 2026-05-26: MapTiler
   z=12 noise faking 12% grades on flat Berlin streets). In the US,
   terrarium is NED/3DEP-derived (10 m source) vs Mapbox's coarser global
   composite at z=12 — the baked values are the more trustworthy side of
   every large divergence we probed.

4. **Consequence for rollout:** when the client flips to enriched tiles,
   up to ~3.4% of painted candidates change display verdict for
   kid-starting-out, dominated by ways that Mapbox noise was wrongly
   *hiding* becoming shown. That is the Phase-2 "unify elevation on the
   open DEM" delta arriving early for the overlay, in the direction that
   removes false hides. The ROUTER still reads Mapbox at runtime until the
   DEM-swap benchmark gate (plan scope item 2) — that comparison
   ("DEM swap ascent comparison" in the test plan) is a separate, routing-
   gated exercise.

5. **`accessGradientPct` coverage observation:** 30.7% of sampled ways are
   topologically connected to the region-wide mainland seed (largest
   baseline-passable component); the rest bake `null` (fail-soft shown —
   no display regression vs today). The disconnection is the known
   bike-filtered-graph gap class (arterials without bike tags aren't
   fetched, so distant towns/subnets don't link to the Bay-core mainland).
   Worth revisiting when wiring the client gate (chunk for client
   consumption): a per-component seed (as the runtime viewport-local
   mainland effectively had) would make the moat gate active outside the
   primary component. `componentPaintedLenM` covers 98.2% of ways (null =
   not a painted candidate, correct).

## Reproduce

```sh
# bake (needs data/norcal-latest.osm.pbf + osmium-tool)
osmium extract -b -123.1,37.2,-121.6,38.6 --strategy=complete_ways \
  data/norcal-latest.osm.pbf -o data/bayarea-core.osm.pbf -O
bun scripts/pipeline/enrich-region.ts --pbf data/bayarea-core.osm.pbf \
  --out data/tiles/bayarea-core --seq 2776 --built-at 2026-07-03T04:51:13Z
# parity (needs VITE_MAPBOX_TOKEN in .env)
bun scripts/pipeline/diag-parity.ts --tiles data/tiles/bayarea-core --n 200 --seed 42
```

## Follow-ups

- **Full-NorCal bake** (Phase 3 prep): bound the OPL-parse node-coord map
  (node-location store or per-subregion sweep) before running the 646 MB
  unclipped file.
- **DEM-swap routing benchmark** (plan scope item 2): the overlay evidence
  here (Mapbox z=12 noise inflating short-way grades) predicts the swap
  will *reduce* spurious ascent cost; run the full routing-changes.md gate.
- **Per-component access seeds** for `accessGradientPct` (see §5) — decide
  when wiring the client arithmetic gate.
