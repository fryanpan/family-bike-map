# Architecture & Product Decisions

## 2026-04-05: Classification audit tool with per-region rules

**Context**: OSM cycling tags vary in meaning across cities — the same `cycleway=track` tag represents world-class infrastructure in Copenhagen but often a narrow bumpy sidewalk in Berlin. Our hardcoded classifier can't handle regional variations.

**Decision**: Build an admin audit tool with server-side classification rules.
- Audit panel scans cities via Overpass, groups ways by tag pattern, shows Mapillary imagery
- Reviewers can override classifications per region
- Rules stored in Cloudflare KV, fetched on app load, checked before hardcoded logic
- Entry point: subtle gear icon on the map (admin-only by obscurity)

**Result**: Regional classification quality can improve without code deploys.

---

## 2026-04-04: Profile-independent Overpass tile cache

**Context**: The Overpass query is identical for all rider profiles — `buildQuery()` has no profile-specific logic. But the tile cache key included `profileKey` (e.g. `525:134:toddler`), and `classifyOsmTagsToItem()` baked profile-specific `itemName` values into stored `OsmWay` objects at fetch time. Switching travel modes discarded all cached tiles and re-fetched everything.

**Decision**: Make the tile cache profile-independent.
- `tileKey(row, col)` — no profileKey in the key
- `fetchBikeInfraForTile(row, col)` — no profileKey param; stores `itemName: null`
- `classifyOsmTagsToItem(tags, profileKey)` — exported; called at render time in `BikeMapOverlay`
- `OverlayController` — `useEffect` deps reduced to `[enabled]`; no reset on profile change
- Cloudflare edge cache key drops profile too — one entry per tile shared across all travel modes and users

**Result**: Travel mode switching is instant (just a re-render). Cloudflare cache is 3× more efficient (one entry per tile instead of one per tile-per-profile).

**Status**: Implemented. 89 tests pass.

---

## 2026-04-02: Tile-based bike map caching (BC-249)

**Context**: The bike infrastructure overlay fetched the entire visible viewport as a single Overpass request on every pan/zoom. This caused visible blank areas during the 1–2s Overpass round-trip. Cache key used exact bbox coordinates so any pan produced a cache miss.

**Decision**: Replace single-viewport fetching with fixed-size tile grid (0.1° × 0.1° tiles, ~74 km² each). Tiles are cached individually in memory.
- **Panning**: already-loaded tiles stay visible instantly; only new tiles fetch
- **Zooming**: all tiles for the new view pre-populate from cache if available; uncached tiles load in parallel
- **Profile change**: tile cache in overpass.ts (keyed by profile) is retained; component tracking resets and re-populates from cache instantly

**Error handling**: Added 1-retry-with-1.5s-delay on Overpass failures. "Could not load" error only shown if all visible tiles failed — partial failures silently succeed since other tiles are still shown.

**Data source**: Stays as overpass-api.de. Self-hosted Overpass could improve latency but adds operational complexity. Tile caching greatly reduces request volume, making the public API viable.

**Tile size rationale**: 0.1° → 2–4 tiles per typical viewport (zoom 13–14). Small enough for fast parallel fetches; large enough that panning a half-screen reuses 50%+ of loaded tiles.

**Status**: Implemented. 74 tests pass.

---

## 2026-04-01: Three-color status indicator system (BC-243)

**Context**: The map overlay and route polylines were showing 4 distinct colors (green, blue, amber, red) for the 4 internal SafetyClass levels, while the route quality bar and profile editor badges were already using a consistent 3-color system (green/amber/red).

**Decision**: Consolidate to a three-color display palette: green (good/great), amber (ok), red (bad). The 4-level `SafetyClass` type (`great`, `good`, `ok`, `avoid`) is preserved internally for routing logic, but `great` and `good` now share the same green color for display.

**Rationale**:
- `great` and `good` already mapped to the same `LegendLevel='great'` and `RouteQuality.great` — making them the same color on the map eliminates the visual inconsistency
- Simpler 3-color system is easier to understand at a glance (green = safe, amber = caution, red = avoid)
- A named `STATUS_COLOR` constant is exported from `classify.ts` as the single source of truth for all three colors

**Status**: Implemented. All 65 tests pass.

---

## 2026-04-01: avoid_bad_surfaces calibration (Engeldam / Fahrradstraße routing)

**Context**: Route from Dresdener Straße 112 → Schillingbrücke was not using the Fahrradstraße or the dirt path through the Engeldam park. Investigation confirmed this is a routing weight issue, not missing OSM data (Berlin OSM coverage for bike infra and park paths is excellent).

**Root cause**: `avoid_bad_surfaces = 1.0` (toddler) and `0.9` (trailer) caused Valhalla to heavily penalise any surface that isn't smooth pavement — including compacted/dirt park paths like Engeldam (surface quality ~0.7–0.9 in Valhalla's model). The parameter was intended to avoid cobblestones (quality ~0.3), but it was too aggressive.

**Decision**: Lower `avoid_bad_surfaces` to `0.5` for both toddler and trailer profiles.
- `0.5` still strongly penalises cobblestones/sett (quality ~0.3) — effectively avoided
- `0.5` allows compacted/dirt park paths (quality ~0.7–0.9) — unlocks Engeldam and similar
- The `gravel` entry in our display `BAD_SURFACES` set is separate and unchanged (display only)

**Status**: Implemented. Tests added for `classifyEdge` covering this scenario.

---

## 2026-03-31: Multi-City Vision

**Context**: Long-term product direction clarification from user.

**Decision**: Design architecture from day one to support multiple cities, with Berlin as initial launch city.

**Vision**:
- Today: Help learn bike routes around Berlin quickly
- Future: Expand to San Francisco and any city visited with bikes
- Ultimate: Worldwide crowdsourced kid-friendly bike infrastructure map

**Architectural Implications**:
- ✅ Valhalla supports multi-region routing (can load multiple OSM extracts)
- ✅ OSM data is worldwide and consistent
- Database schema needs city/region field
- UI needs city selector
- Feedback aggregation needs to be city-aware
- Quality may vary by OSM data completeness per city

**Implementation Path**:
1. Phase 1: Single-city (Berlin) to validate routing logic
2. Phase 2: Add 2nd city (e.g., SF) to validate multi-city architecture
3. Phase 3: Open up to community contributions for any city

**Trade-offs**:
- ✅ Future-proofed architecture
- ✅ Bigger addressable market
- ❌ More complex data management
- ❌ Quality consistency challenges across cities

**Status**: Approved. Architecture designed for multi-city from start.

---

## 2026-03-31: Initial Architecture

**Context**: Setting up project and choosing technical approach for bike routing.

**Decision**: Use Valhalla as routing engine with custom costing profiles.

**Rationale**:
- **Dynamic Costing**: Can adjust preference weights at query time without rebuilding graph — critical for iterating on safety preference model
- **Bike-Specific Features**: Built-in support for bike infrastructure types, surface quality, hill penalties
- **Production Ready**: Battle-tested by Mapbox and Komoot
- **OSM Native**: Works directly with OpenStreetMap data
- **Multi-Region Support**: Can load multiple city/region datasets
- **Flexible**: Can implement custom costing functions for our specific safety model

**Alternatives Considered**:
- **GraphHopper**: Strong alternative, but less flexible dynamic costing (requires graph rebuild for profile changes)
- **OSRM**: Very fast but limited bike-specific customization
- **BRouter**: Excellent bike routing but GPL license and less flexible than Valhalla
- **Pyroutelib3**: Good for prototyping but not production-ready

**Trade-offs**:
- ✅ Flexibility to iterate on routing logic
- ✅ Comprehensive bike features
- ✅ Multi-city support
- ❌ Higher resource requirements (~4GB RAM per major city)
- ❌ C++ means harder to modify core routing logic (vs pure Python)

**Status**: Approved for MVP. Will validate with proof-of-concept.

---

## 2026-03-31: API Server Language

**Context**: Choosing language for API server that wraps Valhalla.

**Decision**: Recommend Go, but keep Node.js and Python as acceptable alternatives.

**Rationale**:
- **Go**: Fast, efficient concurrency, single binary deployment, good Valhalla clients
- **Node.js**: Fast iteration, familiar to many developers, good for MVP
- **Python**: Excellent GIS ecosystem (GeoPandas, Shapely), but slower

**Trade-offs**:
- Go: Learning curve if team unfamiliar, but best for production
- Node.js: Fastest to MVP, but potentially higher resource usage
- Python: Great for geospatial work, but performance considerations

**Status**: Soft recommendation for Go. Final decision during implementation based on team preference.

---

## 2026-03-31: Data Source

**Decision**: Use OpenStreetMap extracts from Geofabrik.

**Rationale**:
- Comprehensive and up-to-date
- Free and open
- Community-maintained (including Berlin cyclists, SF bike advocates, etc.)
- Has all tags we need (bicycle_road, cycleway types, surfaces)
- **Worldwide coverage** — critical for multi-city vision

**Update Frequency**: Monthly initially, can increase if needed.

**Multi-City Approach**: Download separate extracts per city/region, load into Valhalla.

**Status**: Approved.

---

## 2026-03-31: MVP Scope

**Decision**: Focus MVP on core routing with 2-3 preset profiles for Berlin. Defer feedback system to Phase 2.

**In Scope (MVP)**:
- Route between two points in Berlin
- 2-3 rider profiles (family with trailer, confident solo, child riding)
- Route preview with safety segment colors
- Basic route metadata (distance, time, safety score)

**Out of Scope (Phase 2)**:
- Segment feedback and crowdsourced quality ratings
- Route tweaking (avoid/prefer)
- Route saving and sharing
- Custom profile creation
- Additional cities (SF, etc.)

**Rationale**: Validate core routing logic and preference model in one city before building feedback infrastructure and expanding.

**Status**: Approved.

---

## 2026-03-31: No User Accounts for MVP

**Decision**: Start with anonymous usage for MVP.

**Rationale**:
- Lower barrier to entry
- Faster MVP development
- Can add authentication later when we add saved routes (Phase 2)

**Trade-offs**:
- ✅ Faster to market
- ✅ No GDPR/privacy compliance burden initially
- ❌ Can't attribute feedback to users
- ❌ No saved routes

**Multi-City Implication**: When we add auth, users can save routes across cities.

**Status**: Approved for MVP. Revisit for Phase 2.

---

## 2026-03-31: Crowdsourced Data Model (Future)

**Context**: Long-term vision includes worldwide crowdsourced kid-friendly infrastructure data.

**Decision**: Phase 3 feature. Design feedback schema to be city-agnostic and aggregatable.

**Approach**:
- Segment feedback includes geolocation (works anywhere)
- Tag system language-agnostic where possible
- Quality scores normalized across cities
- Community moderation needed for scale

**Open Questions**:
- How to bootstrap new cities? (Cold start problem)
- Moderation model as we scale?
- Language localization for feedback tags?

**Status**: Deferred to Phase 3. Document for future reference.

---

## 2026-04-13: Region model — defer sub-municipal and cross-boundary handling

**Context**: Family bike routing profiles need to attach to *something* — a city, a metro area, a borough? Governance structures vary by country (German Gemeinde, US city, London borough, Tokyo ku, Barcelona district) and bike infrastructure quality tracks governance. No single OSM admin_level captures "the right unit" globally.

**Decision**: V1 uses one profile per route, keyed by the origin's reverse-geocoded city name. Assume most family trips are <15 km and stay within one administrative region. Defer sub-municipal profiles (Waltham Forest, Setagaya), cross-boundary route splitting (Berlin → Potsdam), and Wikidata-keyed filenames until real user complaints surface.

**See**: [`region-model.md`](./region-model.md) for full thinking, governance table, and triggers to revisit.

**Status**: Deferred. Documented and punted until v2.

---

## 2026-04-13: 5-mode picker, drop Valhalla and BRouter from main app

**Context**: Mode rebuild + router consolidation, executed in one pass against the three-layer scoring plan ([`plans/2026-04-13-three-layer-scoring-plan.md`](./plans/2026-04-13-three-layer-scoring-plan.md)).

**Decisions**:

1. **Five top-level modes** (was three): `kid-starting-out` (default), `kid-confident`, `kid-traffic-savvy`, `carrying-kid`, `training`. The previous `toddler` → `kid-starting-out`, `trailer` → `carrying-kid`, `training` unchanged. Two new kid modes capture the developmental progression from "needs car-free paths" → "can handle painted lanes." Geller / Mekuria labels added to `LTS_LABELS` for tooltips.

2. **Default mode = kid-starting-out** on first launch, to surface the product's most-protective routing immediately.

3. **Single source of truth for `DEFAULT_PROFILES`** is now `src/data/profiles.ts`; `src/utils/format.ts` holds the format helpers. Both are imported by the main app and re-exported from `src/services/benchmark/valhalla.ts` for benchmark consumers.

4. **Valhalla and BRouter removed from the main web app routing path.** The main app now routes through `clientRouter` only, with multi-leg waypoint chaining done inline. Both Valhalla (`src/services/benchmark/valhalla.ts`) and BRouter (`src/services/benchmark/brouter.ts`) are retained for benchmark and audit-eval comparisons via `routerBenchmark.ts` and `AuditEvalTab.tsx`.

5. **`useRoads` removed.** The Valhalla-specific `useRoads` field on `LegendItem` and the `getCostingFromPreferences` helper are gone. Mode → routing behavior is now fully expressed by `PROFILE_LEGEND` defaults + per-mode tables in `clientRouter.ts`.

6. **Sidewalk bridge-walk fallback** is implemented for all kid modes (`KID_MODES` set in `clientRouter.ts`) at 3 km/h, heavily penalized so the router only uses it as a last resort to bridge unavoidable bad-infra gaps. `kid-traffic-savvy` is more permissive about tertiary roads with sidewalks than the stricter kid modes.

**Verification**: 204/204 tests pass; `bunx tsc --noEmit` clean; production build succeeds.

**Status**: Shipped.

---

## 2026-04-22: Surface roughness — single binary classifier

**Context**: We had two parallel surface lists: `BAD_SURFACES` for the display overlay and a separate routing penalty knob via Valhalla's `avoid_bad_surfaces`. They drifted — the display flagged paving_stones as rough but the router still picked routes through them, frustrating the "what you see is what you ride" invariant.

**Decision**: One binary `isRoughSurface(tags, profileKey)` function in `overpass.ts` answers both questions. `paving_stones` is OK for slow kid modes (kid-starting-out, kid-confident), rough for higher-speed modes. `cobblestone`/`gravel`/`dirt`/`sand` are universally rough. `smoothness=horrible|very_bad|bad` rejects regardless of `surface=*`. Router applies a 5× cost multiplier to rough edges; overlay greys them out for higher-speed modes.

**Status**: Shipped. Single source of truth.

---

## 2026-04-23: Width / est_width tags too sparsely tagged to filter on

**Context**: Bryan asked whether kid-starting-out should reject narrow cycleways via OSM `width` / `est_width` tags. Spot-checks of Berlin's cycleway corpus showed single-digit percent of ways with a `width=*` tag.

**Decision**: Keep width unread by the router. A filter would only catch the small minority of narrow ways that *are* tagged narrow, create visible "this unmarked one is fine but that 1.2m one is rejected?" inconsistency, and drive very little routing change. Revisit only if OSM coverage materially improves.

**Status**: Deferred. See `docs/process/learnings.md` ("OSM tag coverage").

---

## 2026-04-24: Versioning, frozen benchmarks, /version.json

**Context**: Pre-launch we needed (a) Sentry source-map releases to line up across both stacks, (b) benchmark folders traceable to the exact bundle that produced them, (c) blog-post screenshots that don't drift when the live app keeps getting deployed.

**Decisions**:

1. **Version semantics**: CI builds tag with `0.1.<github_run_number>` via `VITE_APP_VERSION`. Local dev gets `0.1.0-dev-<sha>[-dirty]`. Same constant `APP_VERSION` exported from `src/version.ts`, threaded into Sentry release tags, PostHog `app_version` superproperty, Userback `custom_data.app_version`.
2. **`/version.json` emitted at site root** by a Vite plugin, so any tool can ask "what's deployed?" without downloading the main bundle. Benchmark scripts read this to prefix locally-generated folders with the *live prod* version (`<prod-version>-local-<sha>`) instead of a dev sha — less confusing.
3. **Benchmark folder = `<YYYY-MM-DD>-<version>`**. Each run writes to its own folder under `public/route-compare/`. Old folders are never overwritten.
4. **Launch reference is frozen**: `2026-04-24-0.1.184-local-5478dd5-dirty/` is pinned to the launch blog post; future runs go to fresh folders. Live-current admin view is fine to drift; the post's screenshots stay in lockstep with the version that produced them. Live "always current" benchmark page is deferred to "if users care" (see `docs/process/learnings.md` → "Frozen artifacts").

**Status**: Shipped.

---

## 2026-04-24: findNearestNode role-aware + reachability-restricted

**Context**: Client router was failing 45/195 benchmark samples (23% — 41% of SF) returning null, even when a viable endpoint sat 20–100 m away. Two bugs: (i) end-snap could land on the upstream terminus of a one-way (1 outgoing, 0 incoming edges); (ii) snap could pick a node on a tiny directed island unreachable from the start.

**Decision**: Make `findNearestNode` role-aware (`role: 'start' | 'end'`) and reachability-restricted. Pre-compute the directed-reachable set from the start node via BFS (O(V+E), ~10 ms) and constrain the end-snap to that set. Cap max snap distance at 1 km (the disconnected-graph test relies on null when the endpoint is genuinely off the network).

**Result**: Client router success rate 77% → 100% (Berlin: 91% → 100%, SF: 59% → 100%). Berlin preferred-% essentially unchanged on previously-passing routes (compositional shift only on newly-successful routes).

**Status**: Shipped (PR #138). Benchmark in `docs/research/2026-04-24-findnearestnode-reachability-fix.md`.

---

## 2026-04-26: Sentry on the Worker — one project, runtime-tagged

**Context**: A "routes broken" episode mid-launch-week produced zero Sentry signal because the Cloudflare Worker had no error reporting. Bryan asked whether Worker errors should land in the same Sentry project as the frontend or a separate one.

**Decision**: **Same Sentry project, distinguished by `tags.runtime: 'worker' | 'browser'`**, not by environment. Wins on: cross-stack correlation (browser + Worker errors under the same release), one DSN to rotate, shared release semantics — both stacks deploy from the same commit so `release: APP_VERSION` lines up.

**Wiring**: `@sentry/cloudflare`'s `withSentry()` wraps the Worker default export; auto-captures uncaught throws. `Sentry.captureException` added to the silent /api/route-log D1 catch. Bundle: 460 KiB (well under the 1 MiB free-tier limit). Existing `VITE_SENTRY_DSN` GitHub secret reused as the Worker's `SENTRY_DSN` (DSNs are public client-keys per Sentry docs); CI passes `--var APP_VERSION:0.1.<run_number>` to wrangler so the Worker's release matches the frontend bundle.

**Status**: Shipped (PR #141).

---

## 2026-04-26: Quality bar — distance-weighted, not coord-count

**Context**: Bryan reported a Berlin route showing mostly green on the polyline but 53% non-preferred in the route panel bar. `computeRouteQuality` was summing per-segment `coordinates.length - 1` as a length proxy. OSM way vertex density varies wildly: straight cycleways often have 4–5 coords for 800 m, while curvy residential streets pack 10+ coords into 200 m. Coord-count weighting systematically over-counted curvy non-preferred segments.

**Decision**: Switch the in-app `computeRouteQuality` to actual on-the-ground haversine distance. The benchmark's `scorePreferred` was already distance-weighted, so the shipped benchmark numbers were always correct; only the in-app bar was biased. After this fix the two methodologies are consistent.

**Status**: Shipped (PR #140).

---

## 2026-04-28: One legend table, one display-tier helper

**Context**: Audit found three sites that drifted on tier display props — CSS rules redefining tier colors a different shade from the JS constants (`.qb-other` was `#fb923c` while the route polyline used `#f97316` for the same "non-preferred" concept); SimpleLegend's `SIMPLE_TIERS` had its own tier titles/descriptions that differed from `PATH_LEVEL_LABELS`'; admin-settings tier defaults inlined the same hex codes a second time.

Worse: four display surfaces (legend, overlay, route polyline, quality bar) used **different sources of truth** for "what tier color does this way render at?" — the legend used `PROFILE_LEGEND[item].level`, while overlay/painter/bar used `classifyEdge.pathLevel`. These two classifiers diverge for the same OSM way in edge cases (residential streets with cycleway lanes, default-speed handling), so the same way could render one color in the legend swatch and a different color on the route polyline.

**Decisions**:

1. **`PATH_LEVEL_LABELS` in `utils/lts.ts` is the single legend table.** Carries `short`, `legendTitle`, `description`, `displayDescription`, `defaultColor`, `defaultWeight` per `PathLevel`. `DEFAULT_SETTINGS.tiers` and `SIMPLE_TIERS` derive from it. CSS rules that redefined tier colors were removed; DirectionsPanel inlines colors from constants.
2. **`getDisplayPathLevel(itemName, mode, fallback)` is the single display-tier helper.** When an OSM way maps to a known legend item, the legend's level is canonical; else fall back to `classifyEdge`. Used by `clientRouter` (when setting `seg.pathLevel`) and `BikeMapOverlay` (when computing per-way color).
3. **`classifyEdge` (LTS-tier) is now strictly the routing classifier.** `applyModeRule` reads it for accept/reject + cost decisions. Display surfaces never call it directly except via `getDisplayPathLevel`'s fallback.
4. **`PREFERRED_COLOR` / `OTHER_COLOR` / `WALKING_COLOR`** in `classify.ts` are the source of truth for non-tier categorization colors.

After this: same way renders the same color in legend, overlay, route polyline, and bar. The architectural rule from `learnings.md` ("one classifier drives both display and routing") is restored — display ⇒ `getDisplayPathLevel`; routing ⇒ `classifyEdge` + `applyModeRule`; bridging ⇒ `getDisplayPathLevel`'s legend lookup.

**Status**: Shipped (PRs #145, #150). Architecture documented in `architecture.md`.

---

## 2026-04-28: Mode-switch state hygiene — sync clear + async generation guard

**Context**: After the 2026-04-28 single-display-tier refactor, Bryan still saw stale colors when switching travel modes while a route was on screen. Two distinct bugs.

**Decisions**:

1. **Synchronous fix**: `handleProfileChange` clears `routes` and `selectedRouteIndex` immediately, before calling `computeRoute`. Even when start/end are unset (so `computeRoute` is skipped), the old route's segments don't linger with the new mode's `preferredItemNames`.
2. **Async fix (generation guard)**: `routeRequestRef` is a monotonic counter. Each `computeRoute` bumps the ref at start and captures its own id. Before each setState that mutates shared route state (`setRoutes`, `setError`, `setIsLoading`), check the ref hasn't moved past — bail silently if a newer request is in flight. Suppresses superseded request's error toasts and loading spinner too.

The async race only fires when two computes overlap (mode-switch while previous still running). PR #151 covered the sync case; PR #153 closes the async case.

**Status**: Shipped (PRs #151, #153).

---

## 2026-04-28: Userback hostname gate — drop in favor of dashboard

**Context**: Userback widget had a parallel hostname allowlist in client code (only `bike-map.fryanpan.com` would init the SDK), redundant with Userback's dashboard `allowed-domains` setting. Bryan asked why both — the answer was "no reason."

**Decision**: Drop the client gate. Single source of truth = Userback's dashboard. The `VITE_USERBACK_TOKEN` unset check still acts as a kill switch (matches the Sentry / PostHog gate pattern). Bonus: localhost / Tailscale dev hosts now load the widget too, useful for testing without a deploy.

**Status**: Shipped (PR #147).
