# Architecture & Product Decisions

## 2026-04-04: Profile-independent Overpass tile cache

**Context**: The Overpass query is identical for all rider profiles — `buildQuery()` has no profile-specific logic. But the tile cache key included `profileKey` (e.g. `525:134:toddler`), and `classifyOsmTagsToItem()` baked profile-specific `itemName` values into stored `OsmWay` objects at fetch time. Switching modes discarded all cached tiles and re-fetched everything.

**Decision**: Make the tile cache profile-independent.
- `tileKey(row, col)` — no profileKey in the key
- `fetchBikeInfraForTile(row, col)` — no profileKey param; stores `itemName: null`
- `classifyOsmTagsToItem(tags, profileKey)` — exported; called at render time in `BikeMapOverlay`
- `OverlayController` — `useEffect` deps reduced to `[enabled]`; no reset on profile change
- Cloudflare edge cache key drops profile too — one entry per tile shared across all modes and users

**Result**: Mode switching is instant (just a re-render). Cloudflare cache is 3× more efficient (one entry per tile instead of one per tile-per-profile).

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
