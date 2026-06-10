# Architecture & Product Decisions

## 2026-05-25: Split "Protected bike lane on major road" from "Elevated sidewalk path"

**Context**: SF streets like 17th and Folsom (curb-separated cycle tracks on tertiary/secondary roads) were being labelled "Elevated sidewalk path" — same legend item as a separated track on a quiet residential street. In OSM both share `cycleway=track` / `cycleway:right=track` tags, so `classifyOsmTagsToItem` lumped them together. The lived experience is different: a separated track next to a 50 km/h secondary road is loud, fume-y, and stressful for younger kids, while the same tagging on a residential street is genuinely calm. Bryan's framing: *not appropriate for kid-confident, but fine for kid-traffic-savvy.*

**Decision**:
- Differentiate by `trafficDensity` of the host road (already computed in `classifyEdge` from `highway`):
  - `low` (residential, living-street, unclassified) → keep "Elevated sidewalk path"
  - `moderate` / `high` (tertiary/secondary/primary/trunk) → new item **"Protected bike lane on major road"**
- Both stay at `pathLevel='1a'` — physical car-separation is real, the routing graph doesn't reject. The legend item flips between preferred and non-preferred per mode, and `clientRouter`'s existing "light user-preference nudge" drops non-preferred items to `slowSpeedKmh` so the router prefers alternatives when one exists, without bridge-walking.
- Preferred per mode (mirrors Bryan's framing):
  - kid-starting-out / kid-confident: **not preferred** (orange on route, ~2× cost, hidden from overlay)
  - kid-traffic-savvy / carrying-kid / training: **preferred** (green, normal cost, visible on overlay)
- `BikeMapOverlay` visibility check moves from level-level to item-level. Previously the overlay highlighted any way at a preferred LEVEL even when the specific item was opted-out for the mode — so e.g. `carrying-kid` saw Elevated sidewalk paths painted as preferred 1a-green despite being in the non-preferred legend group. Now the overlay respects per-item membership, which both fixes that pre-existing inconsistency and gives the new item the correct visual treatment for kid-confident.

**Result**: The OSM-tag → legend-item layer now expresses "separated track + busy host road" as a distinct condition. Kid-confident routes through SF will downgrade Folsom/17th, prefer parallel quiet streets when available, and keep using protected lanes when no alternative exists. Carrying-kid and training (which previously routed via "Elevated sidewalk path" as non-preferred / rejected) now treat Protected-on-major as preferred — closer to how an adult cyclist actually rides those corridors.

**Status**: Implemented. Benchmark: [docs/research/2026-05-25-routing-benchmark-results.md](../research/2026-05-25-routing-benchmark-results.md).

---

## 2026-05-10: Gradient gate via MapTiler terrain-RGB

**Context**: Family-bike routing had per-mode `gradientCapPct` field scaffolded in `ModeRule` and `RegionRule` (from the 2026-04-13 three-layer plan) but no elevation pipeline and no consumer. SF and Mexico City profiles call out gradient as load-bearing; Berlin is mostly flat so the gap had been invisible there.

**Decision**:
- Elevation source: **MapTiler terrain-RGB tiles at z=12**. We already pay MapTiler for the basemap, so no new vendor; `~9–25 tiles/request` for a typical urban corridor. Decoded once per session and cached in `src/services/elevation.ts`.
- Thresholds keyed off AASHTO/CROW shared-use-path guidance (5% sustained, 8% short burst):
  - kid-starting-out / kid-confident: **5%** (≈2.9°)
  - kid-traffic-savvy / carrying-kid: **7%**
  - training: **8%**
- Over-cap behavior: **bridge-walk** at `walkingSpeedKmh`, not hard-reject. Mirrors the existing "rejected edges become bridge-walks" pattern from `learnings.md` — kids dismount on steep hills naturally; the graph stays connected, and A* only chooses the walk when there's no flatter alternative.
- Per-way gradient (`end-to-end Δele / wayLength * 100`), not per-segment. Per-segment is noise-dominated at terrain-RGB pixel resolution. Ways under 30 m bypass the gate entirely (signal-to-noise too low).
- Fails soft: if MapTiler is unreachable, tiles 404, or the key is missing, `lookupElevation` returns null and the gate is skipped. Routes still compute; gradient just isn't enforced.

**Result**: A previously-fictional config field is now real. Hilly SF routes that previously chased the steepest direct path now route via shallower contours or convert the climb to a bridge-walk segment. Berlin routes are largely unchanged (mostly flat). Benchmark results: [docs/research/2026-05-10-routing-benchmark-results.md](../research/2026-05-10-routing-benchmark-results.md).

**Status**: Implemented.

---

## 2026-05-05: Plausible for analytics; Sentry stays for errors; PostHog removed

**Context**: Bryan greenlit a fleet-wide standardization on personal sites: Plausible (cookieless aggregate analytics, EU-hosted, no consent banner) for usage stats, Sentry for error tracking. Bike-map already had Sentry but was also running PostHog with autocapture. PostHog overlapped with Plausible's scope (pageviews) and added ~60 KB plus an ad-blocker target, with no custom `posthog.capture()` calls anywhere in the codebase to justify keeping it.

**Decision**:
- Remove PostHog entirely (`src/posthog.ts`, `posthog-js` dep, GitHub secret env vars). No event-level or session-replay use case currently exists.
- Add Plausible script to `index.html`, gated to `bike-map.fryanpan.com` so localhost / Tailscale dev doesn't pollute the property. Standard `plausible.io` script for now; the ad-blocker-resistant CF Worker proxy variant (per <https://plausible.io/docs/proxy/introduction>) is a follow-up if data quality drops.
- Sentry config tightened to fleet defaults: `sendDefaultPii: false`, `tracesSampleRate: 0.1` (Core Web Vitals coverage), `replaysOnErrorSampleRate: 0`, `replaysSessionSampleRate: 0`.
- Bryan adds `bike-map.fryanpan.com` as a site at <https://plausible.io/sites> separately — script is a no-op until then.

**Result**: Lighter prod bundle, single privacy-preserving analytics surface, error tracking unchanged. No build-time secrets needed for Plausible (script loaded statically); only `VITE_SENTRY_DSN` remains in deploy env.

**Status**: Implemented. Tests pass.

---

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

## 2026-06-02: Elevation-aware overlay (gradient gate + crossing hide)

**Context**: Bryan browsing SF kid-confident saw (a) steep hiking trails on
Mt Davidson / Glen Canyon still painted as preferred green, and (b) "weird
short path segments all over SF." Diagnosed with the real classify/elevation
functions over central-SF OSM. See
[`../research/2026-06-02-overlay-gradient-results.md`](../research/2026-06-02-overlay-gradient-results.md).

**Findings**:

- The BRouter-style ascent cost (PR #192) shipped to **routing only**. The
  browse overlay had **zero** elevation awareness — so 19–26% `highway=path`
  trails rendered as preferred "Bike path."
- "Short segments now" had a clear cause: PR #175 (2026-05-03) removed the
  `OVERLAY_MIN_RENDER_ZOOM = 12` floor, so at city-overview zoom every tiny
  crossing/path stub now paints. ~190 of them in central SF are crossing /
  traffic-island stubs (one per intersection).

**Decisions**:

1. **Hide crossing/traffic-island stubs from the overlay** (`isOverlayCrossing`
   in `overpass.ts`): `footway=crossing`, `cycleway=crossing`,
   `footway=traffic_island`, `highway=crossing`. Display-only; routing keeps
   them (they connect the network).

2. **Per-mode overlay steepness gate** (`getOverlayMaxGradientPct` in
   `classify.ts`; `overlayGradientPct` in `elevation.ts`). A shown way whose
   gross gradient exceeds the mode's threshold is hidden. Thresholds:
   starting-out 6%, confident 8%, carrying-kid 8%, traffic-savvy 10%,
   training 15% — monotonic with capability, preserving the kid-skill
   superset invariant. Fails soft (null gradient → shown) so the overlay is
   never blocked on elevation tiles.

3. **One source of "uphill": `wayAscentMeters` in `elevation.ts`.** Extracted
   from `clientRouter`'s inline ascent sum; the router (A* cost) and the
   overlay (steepness gate) now share it, so display and routing can't drift
   on what counts as a climb. Refactor is behavior-preserving — full
   benchmark reproduces PR #192's SF + Berlin numbers exactly.

4. **Did NOT touch `classifyEdge`'s bare-`highway=path` handling.** Bryan's
   pick was the slope gate, not a classification change. The gate catches the
   *steep* trails; flat no-bike-tag park paths still show. Changing the
   classifier affects routing and would need its own benchmark — deferred.

**Performance** (Bryan asked): prefetch ~300 ms one-time (≈ a dozen z=12
tiles, shared with the router); per-way gradient ~31 ms for 1638 ways.

**Verification**: 320 tests pass (11 new); `bunx tsc --noEmit` clean; build
succeeds; SF + Berlin benchmark match PR #192 to the digit; overlay renders
in-browser (Berlin) without regression; SF effect measured at the data layer
(1638 → 1360 shown, −203 crossings, −75 steep trails).

**Status**: Shipped.

## 2026-06-06: Mapillary fallback when Street View has no coverage

**Context**: The segment popup (routing mode) and the browse-overlay way /
rough-surface popups all showed a single Google Street View static image.
Where Google has no coverage (alleys, paths, newer developments — common in
SF), the Static API returns a generic gray "no imagery" tile (HTTP 200), so
the user just saw a blank. Mapillary infra already existed (`getStreetImage`
+ Worker proxy) but was admin-audit-only.

**Decisions**:

1. **Detect coverage via the Street View *metadata* API**, not the image.
   The Static image can't reveal a gap (gray tile is HTTP 200). The metadata
   endpoint returns `{status: "OK" | "ZERO_RESULTS"}` and is **free** (not
   billed), so the check adds no Google cost. New Worker route
   `/api/streetview/metadata` mirrors the image proxy (server-side key, 30-day
   edge cache, re-serialized to just `{status}` so the key-bearing upstream
   URL never leaks). Same key + same Street View Static API enablement as the
   existing image proxy — no new API to enable.

2. **Fallback order: Street View → Mapillary → nothing.** Pure resolver
   `resolveStreetImagery` (`src/services/streetImagery.ts`): coverage OK →
   Street View; else nearest Mapillary image (already widens 100→250→500 m);
   else a subtle "No street imagery here" note. Any failure (unconfigured
   key → 503, network error, ZERO_RESULTS) degrades to the next source.

3. **Two render surfaces, one resolver.** Routing-mode popup uses a React
   `<StreetImagery>` component; the imperative overlay popups
   (`BikeMapOverlay`) call the same resolver via a `fillPopupImagery` helper
   that re-checks the popup is still active before updating (async coverage
   check; user may have clicked away). Mapillary images get a "via Mapillary"
   attribution caption; Street View carries Google's own baked-in watermark
   so no caption there.

**Cost / latency**: covered points now cost one extra metadata round-trip
(free, edge-cached per location) before the image; popup shows immediately
with a "Loading street view…" placeholder. Not a routing change — no
`clientRouter`/`modes`/`lts`/`classify`/`overpass`-query edits, so no
benchmark gate.

**Status**: Shipped.

## 2026-06-10: Fetch car-free bike-designated pedestrian promenades (JFK Promenade class)

**Context**: A route 118 Hancock St → Hook Fish Co (Outer Sunset) came out
8.4 km / 70% non-preferred and did **not** use the car-free JFK Promenade
through Golden Gate Park, even though that is exactly the kind of segment the
router should prefer. Reported by Bryan.

**Root cause**: The JFK Promenade — the entire car-free spine through Golden
Gate Park — is tagged `highway=pedestrian` + `bicycle=designated`
(+ `motor_vehicle=bus|no`). `buildQuery()` in `overpass.ts` fetched cycleway,
residential/path/track, footway (bike-access), living_street and cycleway-lane
ways, but **never `highway=pedestrian`**. So the promenade never entered the
routing graph and the router couldn't use it — it detoured onto non-preferred
surface streets. Same bug class as the long-standing "streets without bike tags
aren't in the graph at all" note in `learnings.md`. Everything downstream
already handled pedestrian ways correctly: `classifyEdge` marks `highway=
pedestrian` car-free LTS 1, and `isWalkingOnly`/`isBridgeWalkable` in
`clientRouter` ride bike-designated pedestrian ways rather than walking them.

**Decisions**:

1. **Fetch `highway=pedestrian` only with explicit bike access**
   (`bicycle=yes|designated`), mirroring the existing `highway=footway` rule.
   This pulls in shared-use promenades that allow cycling (JFK Promenade) while
   deliberately NOT admitting plain pedestrian zones (shopping streets, plazas)
   where bikes aren't designated — those would over-paint as car-free bike infra
   on the browse overlay. Display: such ways classify as "Shared use path"
   (added `highway=pedestrian` to that branch in `classifyOsmTagsToItem`).
   Note: `classifyEdge` treats `highway=pedestrian` as car-free LTS 1
   regardless of `motor_vehicle=bus`, so a bike-designated transit mall
   (Market-St-class) classifies as preferred. Intentional — the
   `bicycle=designated` fetch gate already excludes plain transit malls, and a
   genuinely bus-heavy corridor is demoted via the per-region overlay
   (`cityProfiles/overlay.ts`), the same escape hatch used for Oranienstraße.
   JFK Promenade is `motor_vehicle=bus|no` with negligible bus presence.

2. **Bump tile-cache versions so the fix reaches existing tiles.** All three
   tile caches (Worker edge cache, client IndexedDB, in-memory) key on row/col
   only — query-independent — so a `buildQuery` change would otherwise serve
   30-day-stale tiles. Bumped the Worker cache key `/v1/`→`/v2/` and the client
   IndexedDB `DB_VERSION` 1→2 (clears the store on upgrade). One-time refetch;
   it's a cache, not a source.

**Evidence** (`docs/research/2026-06-10-routing-benchmark-results.md`): SF
benchmark, all 5 modes still 17/17 routes found; avg-preferred up or flat
(kid-starting-out +8pp, carrying-kid +5pp, kid-traffic-savvy +3pp, others flat).
The Hancock→Hook Fish corridor now runs ~25% on the JFK Promenade across all
modes (was 0%); kid-starting-out walking dropped 78%→27%. Purely additive to the
graph — routes-found cannot decrease.

**Deliberately scoped OUT — Berlin park bare footways**: Bryan also reported
Treptower Park foot paths "no longer marked bike friendly." Investigation
(production overlay pipeline over real OSM + Mapbox elevation) showed this is NOT
the same fix and NOT the elevation/steepness gate (that gate drops only 9 of
9403 ways region-wide, all genuinely steep or `surface=ground`). Treptower's
visible path grid is `highway=footway` with **no bicycle tag** (and ~⅓ tagged
`bicycle=no`, i.e. cycling explicitly forbidden). The bike-access-tagged park
paths already render green. Admitting bare footways is a genuine cross-city
policy decision (SF street sidewalks are the same `highway=footway` tag;
`footway=sidewalk` does not cleanly separate them — SF has 421 standalone
`footway` ways including pedestrian-only and Lands End hiking segments Bryan
wants EXCLUDED). Surfaced to the fleet for a scoped follow-up rather than
greening all footways globally. **Status of this entry: Shipped (JFK pedestrian
fetch). Treptower footway policy: open follow-up.**
