# Path Categories + Progressive Kid Modes

**Date:** 2026-04-21
**Status:** Decisions finalized (see §8) — ready to implement
**Context:** Pre-launch classification overhaul. Current state: every "preferred" infra in kid-traffic-savvy renders the same green, which overstates the safety of plain residentials and painted lanes vs. cycleways. See conversation 2026-04-21 for the diagnosis.

## 1. Goal

Simplify the categorization system and legend display for launch to make it easier to explain what this app does.  The main benefit of the app is we offer more gradations of the LTS 1-2 categories to tailor to your kid's biking ability, and build a map that focuses on showing and routing based on these more kid-friendly categories.

Extend Furth's LTS framework with an `a`/`b` sub-tier that splits LTS 1 and LTS 2 by bike-infra presence. Six levels total: **LTS 1a, 1b, 2a, 2b, 3, 4**. Routing rules (mode acceptance + cost multipliers) and display (legend + line style) both key off the same classification.

Sub-tier semantics:
- **a** = physically car-free OR bike-prioritized by design (LTS 1) / has explicit bike infra on quiet streets (LTS 2)
- **b** = bike-infra-absent within the same LTS tier

Stays anchored to [Peter Furth's LTS page](https://peterfurth.sites.northeastern.edu/level-of-traffic-stress/) per `docs/process/learnings.md` — no parallel naming scheme.

Ship before launch (2026-04-21 EOD). Scope is bounded by the benchmark-parity requirement — no regressions vs. 2026-04-20 Berlin + SF baselines.

## 2. Path categories (display-facing)
| # | Category | Includes internal path types | Line style |
| --- | --- | --- | --- |
| LTS 1a | Car-free | Bike path, Shared foot path, Elevated sidewalk path | **solid** |
| LTS 1b | Bikeway with minimal cars | Fahrradstraße + Living street + Bike boulevard | **long dash** |
| LTS 2a | Bike route beside cars | Painted bike lane + Shared bus lane on quiet streets (maxspeed <= 30 km/h) | **dots** |
| LTS 2b | Other LTS 2 (e.g. quiet residential streets) | Quiet residentials (maxspeed ≤ 30 km/h AND lanes ≤ 2) | (none in kid modes — see §8 Q1) |
| LTS 3 | LTS 3 | Busy residentials, tertiary + painted lane on ≤50 km/h, etc. | n/a — routing-only |
| LTS 4 | LTS 4 | Primary, secondary at ≥50 km/h without bike infra, trunk | n/a — routing-only |

### Internal path types → level mapping

| Path type | Level | OSM match |
| --- | --- | --- |
| Bike path | 1a | `highway=cycleway` OR `highway=path` + `bicycle!=no` OR `highway=track` |
| Shared foot path | 1a | `highway=footway` + `bicycle=yes\ | designated` |
| Elevated sidewalk path | 1a | `cycleway=track` OR painted lane with physical separation |
| Fahrradstraße | 1b | `bicycle_road=yes` OR `cyclestreet=yes` |
| Living street | 1b | `highway=living_street` |
| Bike boulevard | 1b | `highway=residential` + `motor_vehicle=destination\ | permissive` (global pattern: SF Slow Streets, Berkeley BBs, Portland greenways, UK LTNs) |
| Painted bike lane (quiet) | 2a | `cycleway=lane\ | opposite_lane` + maxspeed ≤ 30 (no separation) |
| Shared bus lane (quiet) | 2a | `cycleway=share_busway` + maxspeed ≤ 30 |
| Other LTS 2 residential | 2b | `highway=residential` + no bike infra + (maxspeed ≤ 30 OR unset) + lanes ≤ 2 |
| LTS 3 (display as "Other road") | 3 | see `classifyEdge` in `src/utils/lts.ts` — incl. painted lane on maxspeed 31–50 |
| LTS 4 | 4 | see `classifyEdge` |

Rough surface (`surface ∈ ALWAYS_BAD_SURFACES` OR `smoothness ∈ BAD_SMOOTHNESS`) is a cross-cutting flag, not a level.

### Relationship to strict Furth

Furth treats quiet residential (≤30 km/h + ≤2 lanes + no parking issues) as **LTS 1**, and painted lanes up to ~48 km/h as LTS 2. Our model makes two departures:

- **Quiet residential → LTS 2b.** For kids, "quiet residential" without legal bike priority (no Fahrradstraße designation, no through-traffic diversion) is materially different from a bike boulevard where drivers yield as a matter of culture.
- **Painted lane on >30 km/h → LTS 3.** Furth allows up to ~48 km/h (30 mph). Our kid-first framing tightens the 2a cap to ≤30 km/h so LTS 2a genuinely represents "quiet street with bike infra." Painted lanes on faster roads demote to LTS 3 (accepted by carrying-kid with 2× multiplier, rejected by kid-traffic-savvy).

Both keep the "if it's green on the map, it has bike-specific design intent" mental model coherent.

## 3. Mode rules

Walking speed applies uniformly — same value whether the rider is using a sidewalk as primary infra (kid-starting-out / kid-confident) or as a last-resort bridge-walk across a gap (all modes).

| Mode | Accepts | Riding speed | Walking speed | Cost multipliers |
| --- | --- | --- | --- | --- |
| kid-starting-out | LTS 1a only | 5 km/h | 1 km/h | — |
| kid-confident | LTS 1a–1b | 10 km/h | 2 km/h | — |
| kid-traffic-savvy | LTS 1a–2a | 15 km/h | 3 km/h | LTS 2b accepted at × 1.5. No sidewalk riding — sidewalks only used as forced bridge-walks on LTS 3 gaps where a sidewalk exists. |
| carrying-kid | LTS 1a–2b | 20 km/h | 4 km/h | LTS 3 accepted at × 2.0 |
| training | LTS 1b–3 (no LTS 1a elevated paths; LTS 4 rejected) | 30 km/h | 5 km/h | — |

**Universal:** Rough surface → accepted speed unchanged, cost × 5.0.

**Bridge-walks preserved:** per `.claude/rules/routing-changes.md`, hard-rejection is reserved for motorway/trunk and `sidewalk=no`. All other rejected edges re-enter the graph as bridge-walks at `walkingSpeedKmh` so A* can use them as last-resort crossings. This preserves the April-16-regression-preventing connectivity invariant.

## 4. Legend UI

Two modes, user-selectable, persisted in `localStorage`:

**Simple** (default) — 3 visible levels: Car-free (LTS 1a), Bikeway with minimal cars (LTS 1b), Bike route beside cars (LTS 2a). Same line style rules (solid/long-dash/dots).

**By Path Type** — every path type in a distinct color. Line style still follows the parent level (so a Fahrradstraße and a Bike boulevard both long-dash but with different hues). Power-user mode.

**No floating legend panel.** Instead:

- **Map mode**: per viewport, pick one edge of each level that's present and label it inline on the map. Stable across small pans; re-picks on major viewport change. Levels not present in the viewport get no label. Tap-any-edge → popup with level + path type as the always-available fallback.
- **Routing mode**: route path renders with the selected legend directly on the drawn route. No per-edge labels.

Toggle placement: in the settings panel next to the travel-mode selector, not on the map itself.

## 5. Benchmark evaluation

Per `.claude/rules/routing-changes.md`, every nontrivial routing change requires a benchmark run. This change qualifies.

**Metrics (already computed or to add):**

| Metric | Already in harness | Needs work |
| --- | --- | --- |
| % routes-found (per mode) | ✓ | — |
| Avg distance km | ✓ | — |
| Avg time min | ✓ | — |
| % on preferred | ✓ | Split into LTS-1a %, LTS-1b %, LTS-2a % |
| % walking (bridge-walk) | ✓ | — |
| Route cost (self-reported by each router) | — | Add: each router's total cost for same pair |
| Normalized cost | — | Add: distance / mode's riding speed as cross-router proxy |

**Cross-router comparison:**
- clientRouter vs. Valhalla vs. BRouter on the same (origin, dest, mode).
- Our router's self-cost is `sum(distance / speed)` already.
- Valhalla and BRouter report their own cost functions — log them alongside and interpret relative to distance.

**Evaluation cities:**
- Berlin (existing 22 routes × 5 modes)
- San Francisco (new: 17 routes × 5 modes, origin = 120 Hancock St). See `scripts/benchmark-routing.ts` SF config.

## 6. Implementation order

1. **Destination wiring** (task #93) — update `scripts/benchmark-routing.ts` SF config to 17 destinations + single origin. No behavior change.
2. **Baseline benchmark** (task #94) — `bun scripts/benchmark-routing.ts --no-external --city=sf` and same for Berlin. Snapshots current numbers pre-overhaul.
3. **Add \****`pathLevel`***\* to \****`LtsClassification`** — in `src/utils/lts.ts`, add `pathLevel: PathLevel` field where `PathLevel = '1a' | '1b' | '2a' | '2b' | '3' | '4'`. Derive from existing `carFree`, `bikePriority`, `bikeInfra` flags plus the LTS tier. Purely additive; doesn't change routing yet.
4. **Unify display classifier** — rewrite `classifyOsmTagsToItem` in `src/services/overpass.ts` to return `{ level, pathType }`. Delete the parallel string-matching logic.
5. **Extend \****`PROFILE_LEGEND`** — add `level` field on items. Add Bike boulevard item (level 1b). Add `'Other road'` item (level 3 or 4 depending on road class).
6. **Rewrite mode rules** — in `src/data/modes.ts`, replace `ltsAccept` + `ltsConditions` with `acceptedLevels: PathLevel[]` + `levelMultipliers: Record<PathLevel, number>`. Keep bridge-walk behavior.
7. **Update \****`clientRouter.ts`** — consume `levelMultipliers` when computing edge cost. Cost = `distance / speed × (multiplier for level) × (5.0 if rough surface else 1.0)`.
8. **Legend rewrite** — Simple / By Path Type toggle, localStorage persistence, inline per-tile labels. Delete floating legend panel.
9. **Re-run benchmark** — both cities. Compare %-by-level, route cost, walk %, routes-found. Diff against baseline.
10. **Write results doc** — `docs/research/2026-04-21-path-categories-benchmark.md` with before/after delta and interpretation per `.claude/rules/routing-changes.md`.
11. **Commit plan + code as one PR**.

## 7. Risks

- **Bridge-walk connectivity invariant** (highest risk). The April 16 regression dropped kid-confident from 16/16 to 5/22 when rejected edges stopped becoming bridge-walks. New mode-rule model must preserve this. Test: `clientRoute(LTS-4-crossing-pair, kid-confident)` must return a route, not fail.
- **Multiplier tuning.** 1.5× (LTS 2b for traffic-savvy) / 2.0× (LTS 3 for carrying-kid) / 5.0× (rough surface) are initial guesses. Benchmark will tell us if any produce weird detours. Plan is to ship these numbers and tune in a follow-up if benchmarks diverge.
- **Per-viewport label UX.** Leaflet has no native collision avoidance. One label per level per viewport keeps clutter low but may leave labels stuck near a map edge after panning. Acceptable for launch; tap-any-edge popup covers the discoverability gap.
- **Training mode change.** Excluding elevated bike paths is new behavior — could drop some Berlin training routes that used curb-separated sidewalk tracks. Accepted intentionally, verified by benchmark.
- **OSM data completeness.** Bike boulevards depend on `motor_vehicle=destination` tagging. OSM coverage is uneven; some real-world Slow Streets may not be tagged and will fall into LTS 2b. Accept as known limitation; document.
- **Departure from strict Furth.** Quiet residential moves from Furth's LTS 1 → our LTS 2b; painted lane on >30 km/h moves from LTS 2 → our LTS 3. Documented in §2 and aligned with the product's kid-first framing.

## 8. Decisions

**D1. LTS 2b rendering on the map for kid modes.** No overlay line in kid modes — LTS 2b appears only as the base OSM tile color. Carrying-kid + training show LTS 2b in a 4th style (e.g. gray dotted).

**D2. Walking speed.** Unified per mode — same value whether used as primary sidewalk infra or as a bridge-walk across an unavoidable gap. Values: kid-starting-out 1 km/h, kid-confident 2 km/h, kid-traffic-savvy 3 km/h, carrying-kid 4 km/h, training 5 km/h. Captured in §3.

**D3. Inline label placement.** One label per level per viewport. Re-pick on major viewport change. Tap-any-edge popup is the universal identification fallback.

**D4. Legend persistence + default.** Default to Simple. Persist user's choice in `localStorage` under `legendMode: 'simple' | 'by-path-type'`. Toggle lives in the settings panel next to the travel-mode selector.

**D5. ****`carrying-kid`**** display label.** Stays "Carrying Kid" (not "Biking with trailer"). Internal `RideMode` key also stays `carrying-kid`.

## 9. Files affected

- `src/utils/lts.ts` — add `pathLevel: PathLevel` to `LtsClassification`; export `PathLevel` type
- `src/utils/classify.ts` — legend `level` field, new items, `PATH_LEVELS` constant
- `src/services/overpass.ts` — `classifyOsmTagsToItem` returns `{ level, pathType }`
- `src/data/modes.ts` — replace `ltsAccept` + `ltsConditions` with level-based model
- `src/services/clientRouter.ts` — consume `levelMultipliers`; rough-surface 5× multiplier
- `src/services/routerBenchmark.ts` — `%-by-level`, route cost fields
- `scripts/benchmark-routing.ts` — SF config update; cross-router cost logging
- `src/components/Legend.tsx` (and/or `BikeMapOverlay.tsx`) — UI rewrite, inline labels, style-by-level
- `src/components/Map.tsx` — route rendering with new line styles
- Deleted: binary preferred/other legend code paths

## 10. Task tracking

- #93 Replace SF benchmark destinations with Bryan's 17-pair list
- #94 Run SF baseline benchmark before classifier fix
- #97 Re-run SF benchmark + write results doc
- #98 Add `pathLevel` (1a–4) to `LtsClassification`
- #99 Unify display classifier on path-level model
- #100 Rewrite `PROFILE_LEGEND` with level field + Bike boulevard
- #101 Rewrite mode rules in path-level model
- #102 Wire levelMultipliers + rough-surface 5× into clientRouter cost
- #103 Legend UI rewrite: Simple vs By Path Type + inline labels
- #104 Extend benchmark harness: %-by-level + cross-router cost
