# Routing benchmark — 2026-07-03 (DEM swap gate: mapbox → terrarium) — GATE FAILED, DEFAULT NOT FLIPPED

Gate run for **enriched-tiles plan scope item 2**: flip the router's runtime
DEM from Mapbox terrain-RGB to AWS Terrain Tiles (terrarium) so routing, the
overlay, and the offline bake all read the same open DEM. Client-only runs
(`--no-external`), standard tile cache (no `TILE_BUST` — `buildQuery`
unchanged, so tile content is identical to the 2026-06-26 baseline and the
comparison isolates the DEM source).

**Verdict: the gate FAILED on SF carrying-kid (48% → 41% preferred, −7pp,
outside the ~3pp band). The default flip was REVERTED per the plan's
no-tuning rule. The terrarium capability (decoder, fetch path,
`setElevationSource('terrarium')`) remains in place and benchmark-gated
tooling can exercise it; the runtime default stays `mapbox-terrain-rgb`.**

## What was tested

The only change between BEFORE and AFTER was
`DEFAULT_ELEVATION_SOURCE: 'mapbox-terrain-rgb' → 'terrarium'` in
`src/services/elevation.ts`. Same graph builder, same mode rules, same cost
model, same OSM tiles. Terrarium is token-free open data (US coverage is
NED/3DEP-derived, 10 m source); the parity diag
(`docs/research/2026-07-03-enriched-tiles-parity.md`) had shown Mapbox z=12
reads noisier per-way gradients (±15–23 m inter-vertex jumps on flat
hillside streets), predicting the swap would mostly *remove* spurious
ascent cost.

BEFORE runs reproduced the 2026-06-26 baseline **exactly** in both cities
(same routes-found, same per-mode preferred-%), confirming a stable
comparison base.

## Per-mode summary

Avg preferred-% (higher = more time on family-preferred infra). Routes-found
at full coverage for every mode in both cities, before AND after — the swap
never broke connectivity.

### Berlin (22 pairs)

| Mode | Found | Preferred (mapbox → terrarium) | Δ |
|------|-------|-------------------------------|---|
| kid-starting-out  | 22/22 | 50% → 52% | +2 |
| kid-confident     | 22/22 | 66% → 68% | +2 |
| kid-traffic-savvy | 22/22 | 67% → 69% | +2 |
| carrying-kid      | 22/22 | 56% → 58% | +2 |
| training          | 22/22 | 46% → 48% | +2 |

Berlin also shed walking-%: kid-starting-out 43%→40%, kid-confident
31%→28% — consistent with phantom Mapbox grades having triggered
unnecessary caution.

### SF (17 pairs)

| Mode | Found | Preferred (mapbox → terrarium) | Δ |
|------|-------|-------------------------------|---|
| kid-starting-out  | 17/17 | 28% → 28% | 0 |
| kid-confident     | 17/17 | 41% → 41% | 0 |
| kid-traffic-savvy | 17/17 | 49% → 50% | +1 |
| carrying-kid      | 17/17 | 48% → 41% | **−7 (GATE FAIL)** |
| training          | 17/17 | 42% → 42% | 0 |

## The failing mode, per route (SF carrying-kid)

No pair went to FAIL (all 17 still route); the damage is preferred-%
concentrated on short, flat Mission-corridor trips:

| Pair | mapbox | terrarium | Δ |
|------|--------|-----------|---|
| Tartine (600 Guerrero) | 39% | 11% | −28 |
| 16th St Mission BART | 35% | 0% | −35 |
| Dumpling Story (694 Valencia) | 42% | 26% | −16 |
| Lands End | 63% | 58% | −5 |
| Sunset Dunes | 84% | 80% | −4 |
| Lung Fung Bakery | 59% | 54% | −5 |
| Dragon Beaux | 62% | 57% | −5 |
| (10 other pairs) | — | — | ±2 or 0 |

## Interpretation

1. **The DEM itself is better, and Berlin proves it**: +2pp preferred across
   every mode, less bridge-walking, no lost routes. The parity diag's
   prediction (Mapbox z=12 noise inflates grades; terrarium is smoother and
   more trustworthy) is confirmed on the routing side too.

2. **The SF carrying-kid regression is a cost-balance side effect, not DEM
   error.** The drops are on *flat* Mission trips where elevation should be
   irrelevant. Under Mapbox, phantom ascent noise on the direct flat streets
   apparently added enough cost to tip carrying-kid onto the (longer)
   Valencia-corridor preferred infra; with clean terrarium elevations that
   phantom cost vanishes, pure time cost wins, and `carFreeBonus` 0.7 alone
   doesn't hold the preference on these pairs. I.e. the mode's
   family-preference tuning was quietly leaning on DEM noise. This is a
   hypothesis from the per-route pattern — per the ablation rule
   (`.claude/rules/routing-changes.md`), it needs a proper cost-term
   ablation before anyone acts on it.

3. **Per the gate + the plan's explicit instruction ("if the gate fails:
   revert the flip, keep the capability, do not tune anything"), the default
   flip was reverted.** No cost constants were touched.

## Consequence for the enriched-tiles rollout

- The Phase-1 "temporary divergence" persists: the bake/overlay enriched
  tiles carry terrarium-derived gradients while the runtime router keeps
  reading Mapbox. That divergence was already logged as expected in the
  plan and the parity doc; it remains display-vs-routing only.
- Local-dev terrain blackout (Referer-restricted Mapbox token, learnings
  2026-07-02) also persists for the router until the swap lands.

## Follow-ups

1. **Ablate, then re-tune, then re-run this gate.** Reproduce the SF
   carrying-kid Mission routes under both DEMs with cost-term ablation
   (`scripts/diag-turn-cost-ablate.ts` pattern) to confirm the
   phantom-ascent-was-load-bearing hypothesis. If confirmed, the principled
   fix is adjusting carrying-kid's preference terms (e.g. `carFreeBonus`,
   per the 2026-06-26 note "lower/raise per-mode bonus rather than removing
   it") as its own benchmark-gated change, then retry this flip.
2. Kept from this attempt (no behavior change at the mapbox default):
   `scripts/benchmark-routing.ts` now logs the active DEM source and
   auto-enables elevation prefetch when the source is terrarium (token-free);
   `scripts/pipeline/diag-parity.ts` pins `mapbox-terrain-rgb` explicitly
   instead of relying on the module default, so a future default flip can't
   silently turn it into terrarium-vs-terrarium.

## Reproduce

```sh
# BEFORE (default = mapbox; VITE_MAPBOX_TOKEN via .env)
bun scripts/benchmark-routing.ts --no-external              # Berlin
bun scripts/benchmark-routing.ts --no-external --city=sf
# AFTER: set DEFAULT_ELEVATION_SOURCE = 'terrarium' in src/services/elevation.ts,
# then re-run both commands.
```
