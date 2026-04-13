# Three-layer scoring architecture — implementation plan

Backed by [`docs/research/family-safety/`](../../research/family-safety/). Converts the current Berlin-biased classifier into a portable three-layer model without rewriting routing from scratch.

## Travel modes revealed in the UX

Five modes, ordered from most protective to least. The first four are the family product; the fifth is for the primary user's fitness riding and is explicitly secondary. See [`carrying-kid-hardware.md`](../../research/family-safety/carrying-kid-hardware.md) for why "Carrying kid" is one mode and not four.

| Order | Mode | Description | LTS target | Notes |
|---|---|---|---|---|
| 1 | **Kid starting out** (default) | Kid has some bike control (can stop to avoid danger) and needs **fully car-free pathways**. Balance bike → early pedaling, rare training wheels. ≤3 km continuous. | LTS 1, segregated variants only (cycleway, path, car-free Fahrradstraße, living_street with minimal cars). No painted-lane LTS 2. | **Default on first launch** — shows the safest infrastructure and how differentiated this product is from other maps. |
| 2 | **Kid confident** | Good bike control, basic road awareness, can stay right or in lane under parental command. Parent still needs time to correct mistakes — no split-second life-and-death decisions demanded of the kid. ≤8 km. | LTS 1 fully + selective LTS 2 (living streets, low-traffic residential in 30 km/h zones, Fahrradstraßen). Not painted lanes on busy roads. | |
| 3 | **Kid traffic-savvy** | Kid reads traffic, handles painted bike lanes, intersections, traffic signals, makes split-second decisions correctly. Still a kid — never LTS 4. ≤15 km. | LTS 1–2 fully, LTS 3 with care (painted lane on ≤50 km/h road with moderate traffic). | |
| 4 | **Carrying kid** | Adult pilots; kid is passenger (child seat, trailer, cargo/longtail/bucket). One mode collapses all hardware variants — Layer 3 prose refines when needed. Assume **no e-assist** by default. | LTS 1–2, willing to take LTS 3 for short unavoidable connectors. Never LTS 4. | Surface-strict (paving stones, sett, cobblestone avoided). |
| 5 | **Training** (secondary) | Adult fitness riding. Prioritize 30 km/h flow; still safety-conscious; avoid bumps/crowds. 20+ km. | LTS 1–3. | Explicitly deprioritized. Komoot exists. May be hidden behind an "advanced" toggle later. |

### Mode picker UX

- **Top-level and always visible.** Users will flip between modes while planning multi-leg trips (trailer leg, then kid-bike leg, compared separately). Large picker, not buried in a menu. Multi-modal trip planning is future; the visible picker is the seed.
- **Icons required** — all five need distinct custom icons; emoji distinctions are too subtle for scanning. See icon section below.
- **Default: Kid starting out** — shows the product at its most protective and most differentiated from Google/Apple Maps on first launch. User can change; preference is remembered.

### Mapping to Geller/Mekuria labels

For tooltips and research credibility — official labels from [`standards.md`](../../research/family-safety/standards.md):

| Our mode | Geller label | LTS target |
|---|---|---|
| Kid starting out | Children (strict) | LTS 1 (segregated only) |
| Kid confident | Children | LTS 1 + selective LTS 2 |
| Kid traffic-savvy | Between Children and Interested-but-Concerned | LTS 1–2, some LTS 3 |
| Carrying kid | — (adult-led) | LTS 1–2 |
| Training | Enthused and confident | LTS 1–3 |

### Sidewalk bridge-walk fallback

**Applies to all four kid modes.** If a route from A to B requires crossing a short bad-infra segment and there's no acceptable alternative, the router may **bridge** using a sidewalk at walking pace (3 km/h), with a heavy penalty on the bridged section. This handles the "Kid starting out" trap where strict LTS 1 filtering produces zero routes.

Mechanics:

- A bridged segment is marked `isWalking: true` (the existing `RouteSegment` field already supports this)
- Cost: walking-pace time (3 km/h) + a fixed penalty multiplier (tentatively ×10) applied to the segment
- UI: the walked portion is visually distinct (dashed red line, "walk the bike here" callout)
- Hard cap: bridges longer than X meters (tentatively 200 m) reject the route entirely — you're not walking a kid across a highway
- Only triggered when no fully-rideable LTS-valid alternative exists within a reasonable detour budget

Non-kid modes (Carrying, Training) don't use this — carrying-kid adults are fine on the adult walk, training mode isn't a family use case.

**Open question**: should "Carrying kid" also use this? Probably yes for short unavoidable connectors, since the alternative is "no route," but with an even shorter hard cap (say 100 m) because dismounting a loaded bakfiets is annoying.

## Goal

## Goal (original)

Separate global baseline (research-backed) from per-city calibration from per-family preferences, so that:

- Adding a new city is a ~25-minute data task, not a code change
- Copenhagen-accurate scoring and SF-accurate scoring can coexist in one codebase
- Family preference sliders (Layer 3) plug in later without touching Layers 1–2

## Where each layer lives in the code

```
src/
  data/
    cityProfiles/
      index.ts              — registry + types + lookup
      berlin.ts             — one file per city
      copenhagen.ts
      ...
      _default.ts           — fallback when no city matches
  utils/
    lts.ts                  — Layer 1: pure LTS classification (global)
    classify.ts             — edge → legend item; takes CityProfile
    cityDetection.ts        — NEW: lat/lng → city key
  services/
    routeScorer.ts          — applies SiN multiplier + weakest-link penalty
    routing.ts              — passes CityProfile into classifier + costing
```

## Layer 1 — Global baseline

**Stays in `src/utils/lts.ts`.** Already research-shaped (LTS 1–4, weakest-link `familySafetyScore`). Needed changes:

1. Fix thresholds to match [`standards.md`](../../research/family-safety/standards.md):
   - Mixed traffic LTS 1 needs both speed ≤30 km/h AND volume proxy (no `highway=primary/secondary/trunk`)
   - Keep LTS 2 calibrated to "most adults" (CROW-compatible)
   - Intersection scoring as separate step (see new helper below)
2. Add `computeIntersectionStress(crossings)` — weakest-link over route's intersections, mirrors Mineta LTS rules
3. Export `computeLts` unchanged; it's the global reference. Anything city-specific is forbidden here — no `Fahrradstrasse` hardcoding, no German tag names. Use pure OSM tags only.

**Test hook:** `tests/lts.test.ts` gets a table-driven test using tag snippets from each city profile's "beloved route" and "avoided route" lists, asserting the global classifier puts them in the right tier.

## Layer 2 — Per-city profile

### Type

```ts
// src/data/cityProfiles/index.ts
export interface CityProfile {
  key: string                    // 'berlin', 'copenhagen', ...
  displayName: string
  country: string                // ISO
  archetype: Archetype           // union of 7 archetypes
  bbox: [number, number, number, number]  // for detection
  modeShare: number              // 0-1
  sinMultiplier: number          // precomputed (m_ref / m) ^ 0.25

  // Which OSM tag patterns locally count as trustworthy protection
  protectedDefinition: {
    accept: TagPattern[]         // e.g. ['cycleway=track', 'bicycle_road=yes']
    reject: TagPattern[]         // e.g. ['cycleway=lane']  (Berlin: door zone)
  }

  // Legend item overrides — how the classifier maps edges in *this* city
  itemOverrides: Partial<Record<LegendItemName, 'boost'|'demote'|'reject'>>

  // Surface penalty calibration (child bikes, not adult)
  surfacePenalties: {
    alwaysBad: Set<string>       // falls back to global ALWAYS_BAD_SURFACES
    citySpecificBad: Set<string> // e.g. Berlin adds paving_stones when wet
  }

  // Named corridor overrides — small list, reviewed by human
  namedOverrides: {
    boost: NamedCorridor[]       // 'Mauerweg', 'JFK Promenade'
    avoid: NamedCorridor[]       // 'Kantstrasse', 'Valencia Street'
  }

  // Optional extra dimensions — only cities that need them set these
  extraDimensions?: {
    aqi?: boolean                // CDMX
    winterPlowed?: string[]      // Montreal: list of REV axes
    timeOfWeek?: TimeWindow[]    // Bogotá Ciclovía, Paris rue aux écoles
    enforcementReliability?: Map<OsmId, number>  // CDMX per-corridor
  }

  sources: string[]              // URLs for the md profile
}
```

### Data — one TS file per city

```ts
// src/data/cityProfiles/berlin.ts
export const berlin: CityProfile = {
  key: 'berlin',
  displayName: 'Berlin',
  country: 'DE',
  archetype: 'berlin',
  bbox: [13.0884, 52.3382, 13.7611, 52.6755],
  modeShare: 0.18,
  sinMultiplier: 1.11,
  protectedDefinition: {
    accept: ['bicycle_road=yes', 'cycleway=track', 'highway=living_street'],
    reject: ['cycleway=lane'],  // door zone
  },
  itemOverrides: {
    'Fahrradstrasse': 'boost',
  },
  surfacePenalties: {
    alwaysBad: new Set(),  // inherit global
    citySpecificBad: new Set(['sett', 'cobblestone']),  // child-bike penalty
  },
  namedOverrides: {
    boost: [{ name: 'Mauerweg', osmRelation: 12345 }],
    avoid: [{ name: 'Kantstrasse', way: [67890, 67891] }],
  },
  sources: ['https://.../berlin.md'],
}
```

**Why TS not YAML:** type-safe, tree-shakeable, no runtime parser, no validation step, same review workflow as code. The authoritative long-form research stays in `docs/research/family-safety/city-profiles/<city>.md`.

### City detection

`src/utils/cityDetection.ts` picks a profile from origin+destination coordinates:

1. If both endpoints fall in the same city bbox → that profile
2. If different cities (rare) → use origin city, log the crossing
3. If no match → `_default.ts` profile (pure global baseline, SiN = 1.0)

Route boundary crossings (Berlin ↔ Potsdam) need attention but are a v2 problem — v1 uses origin.

### Classifier integration

`classifyEdgeToItem(edge, profileKey, cityProfile)` — same signature plus the city profile. Flow:

1. Run current global rules from `classify.ts`
2. Check `cityProfile.protectedDefinition.reject` — if edge matches, return `null` (not protected here)
3. Check `cityProfile.itemOverrides` — apply boost/demote/reject
4. Check `cityProfile.surfacePenalties.citySpecificBad` — add to rough-surface check
5. Return the resulting legend item name

Named corridor overrides handled in `routing.ts` as post-processing on the returned segments — match OSM way ID against `namedOverrides` and relabel.

## Layer 3 — Family preferences (scaffolding only, not built yet)

Keep the existing `PROFILE_LEGEND` (toddler/trailer/training) as the starting Layer 3. Reframe it as:

```ts
interface FamilyPreferences {
  baseProfile: 'toddler' | 'trailer' | 'training'  // existing

  // Future sliders (not wired yet)
  maxGradient?: number          // %
  maxContinuousDistance?: number  // km — 5yo stamina cap
  cobbleTolerance?: 'low' | 'medium' | 'high'
  plasticPostTrust?: 'none' | 'some' | 'full'  // Valencia lesson
  aqiCeiling?: number           // CDMX
  preferSchoolHours?: boolean   // Paris rue aux écoles
}
```

**Key constraint:** Layer 3 only reweights Layers 1+2; never overrides LTS 4 exclusions for a route with kids.

For v1, hook `preferredItemNames` from Layer 3 into the `itemOverrides` merge. Current `getCostingFromPreferences` becomes `getCostingFromAllLayers(global, city, family)`.

## SiN multiplier — where it applies

Applied in `routeScorer.ts` *after* per-edge classification, before computing `familySafetyScore`:

```ts
const raw = familySafetyScore(breakdown)
const adjusted = raw / cityProfile.sinMultiplier
```

Dividing (not multiplying) because higher multiplier = more risk = lower score. City-level only — never per-edge.

**This is a tiebreaker between otherwise-comparable routes, not an override.** A route with LTS 4 stays bad in Copenhagen.

## Migration order

1. **Extract global rules.** Strip German-specific bits from `classify.ts` into `lts.ts`. `classify.ts` gets a pure "tag → tier" function with no legend names.
2. **Add `CityProfile` type + `_default.ts`.** Default profile is the global baseline with no overrides. Wire it through `classifyEdgeToItem` and `routing.ts`. Routes must be identical to current behavior — this is a refactor, not a feature change.
3. **Write `berlin.ts`** encoding the current Berlin-biased behavior explicitly. Again, route output unchanged.
4. **Add `cityDetection.ts`** and route the profile selection through the worker request handler. Now switching cities changes behavior.
5. **Add SiN multiplier** in `routeScorer.ts`.
6. **Port remaining 14 cities** (copenhagen, potsdam, sf, …) from the research markdown. Start with ones we have users/test routes for (Berlin, Potsdam, SF).
7. **Expand Layer 3** when we add the first new slider (probably `cobbleTolerance` for Bea in Potsdam old town).

Each step is independently shippable and reversible. Steps 1–3 must produce byte-identical route output to prove the refactor is clean.

## Test strategy

- **Unit**: `tests/lts.test.ts` table-driven from research city profiles (beloved → LTS 1, avoided → LTS 3+)
- **Integration**: `tests/routing.integration.test.ts` runs same route through Berlin profile and Copenhagen profile, asserts different scoring where expected
- **Regression**: a "golden routes" set for Berlin — these must stay identical through steps 1–3 of migration
- **Schema**: zod or similar on `CityProfile` shape to catch broken profiles at CI time

## Region model

See [`docs/product/region-model.md`](../region-model.md) for the full thinking on governance boundaries, Wikidata-keyed profiles, and sub-municipal variation. **V1 assumption**: most family trips are <15 km and stay within one administrative region. One profile per route, chosen by origin reverse-geocode. No cross-boundary splitting; no sub-municipal profiles. Filenames are human-readable keys (`berlin.md`) until we outgrow them.

## Open questions

1. **City detection UX.** Auto-detect silently, or show "Biking in Berlin ▼" picker? Auto + override is probably right.
2. **Multi-city routes (Berlin → Potsdam).** v1: use origin. Deferred, see `region-model.md`.
3. ~~**Is Valhalla staying?**~~ Resolved: out of main app, retained in benchmark only. `useRoads` cleanup is unblocked.
4. **Bridge-walk cap for "Carrying kid" mode.** Enable short bridges (~100 m) or reject entirely? Current v1 proposal: enable, matching the kid modes but with a shorter cap.
5. **E-assist as a binary toggle alongside "Carrying kid."** Deferred — users can express it in Layer 3 prose for now. Reconsider when SF/CDMX users complain about gradient caps.
6. **Should "Training" be hidden by default?** Bryan's mode; he says secondary. Tuck it behind a small "also show adult modes" toggle, or leave visible?
3. **Named overrides storage.** Small lists inline in the TS file, or a separate `named-corridors/<city>.json`? Probably inline until it hurts.
4. **Community-sourced overrides** — out of scope for v1 but the `namedOverrides` shape is designed to be mergeable from a user-contributed layer later.
5. **Where `sinMultiplier` is precomputed vs computed from `modeShare`.** Precomputing feels dumb but it's one line. Keep both fields, derive if absent.
6. **Valhalla costing — does this all run client-side?** Looks like yes (`clientRouter.ts` exists). Confirm the costing options we pass are city-aware.

## Cleanup debt — confirmed scope

**Main web app uses `clientRouter` only. Valhalla and BRouter are retained in benchmark code only for comparison.**

Files to purge from the main app path:

1. **`src/App.tsx`** — remove imports of `getRoute` (routing.ts / Valhalla) and `getBRouterRoutes` (brouter.ts). `getBRouterRoutes` is already dead-gated behind `false &&` at line 516 — trivial. `getRoute` at line 460 is still called alongside `clientRoute` — needs behavior verification that `clientRoute` provides full parity before removal.
2. **`src/components/AuditEvalTab.tsx`** — remove `getBRouterRoutes` usage; if the audit eval flow needs a multi-router comparison, refactor to pull from `routerBenchmark.ts` instead.
3. **`src/utils/classify.ts`** — strip `useRoads` from `LegendItem`, `LegendGroup`, and `getCostingFromPreferences`. It's Valhalla-specific and has no consumer after step 1. `PROFILE_LEGEND` keeps its other fields.

Files that **stay** (retained for benchmark/comparison only):

- **`src/services/routing.ts`** — move to `src/services/benchmark/valhalla.ts` to make intent obvious; imported only by `routerBenchmark.ts`.
- **`src/services/brouter.ts`** — move to `src/services/benchmark/brouter.ts`; imported only by `routerBenchmark.ts`.
- **`src/services/routerBenchmark.ts`** — unchanged, imports from the new benchmark/ subdirectory.

Other cleanups to ride alongside:

4. **German-specific legend names** (`Fahrradstrasse`) in `classify.ts`. As part of the Layer 1 extraction, push these to the city profile layer and keep `classify.ts` global.

## Non-goals for v1

- Time-of-week edges (Bogotá Ciclovía, Paris rue aux écoles) — future
- AQI cost layer (CDMX) — future
- Winter-plowed flag (Montreal) — future
- Enforcement-reliability per-corridor (CDMX) — future
- Floodgate transfer nodes (Taipei) — future, probably needs a routing-engine change
- Crowd-sourced corridor overrides — future

These are all modeled as `extraDimensions` on `CityProfile` precisely so they can be added without schema churn.
