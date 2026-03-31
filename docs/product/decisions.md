# Architecture & Product Decisions

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
