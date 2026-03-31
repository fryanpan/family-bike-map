# OSM-Based Routing Engines Research

Research on open-source routing engines that can power bike-specific routing with custom preference weighting.

## Top Candidates

### 1. Valhalla ★ Recommended
- **Source**: https://github.com/valhalla/valhalla
- **Maintainer**: Mapbox (originally), now open-source community
- **Language**: C++
- **License**: MIT

**Strengths:**
- Multimodal routing (pedestrian, bike, auto, transit)
- Excellent bike-specific features:
  - Multiple bike profiles (road, mountain, hybrid, cross)
  - Customizable costing models per profile
  - Road surface, grade, traffic signal penalties
  - Bike lane/path preference weighting
- Dynamic costing: Can adjust preferences at query time without rebuilding graph
- Time-aware routing support
- Active development and production-ready (used by Mapbox, Komoot)
- Good documentation and APIs

**Bike-Specific Capabilities:**
- `use_roads`: Willingness to use roads (0.0-1.0)
- `use_hills`: Willingness to tolerate hills (0.0-1.0)
- `cycling_speed`: Expected speed affects time estimates
- `bicycle_type`: Road, hybrid, cross, or mountain
- Surface type penalties (smooth vs rough)
- Can heavily penalize busy roads and reward separated infrastructure

**Considerations:**
- Larger resource requirements (RAM for graph data)
- C++ means harder to modify/extend compared to pure Python
- Requires pre-processing OSM data into Valhalla tiles

**Verdict:** Best choice for production. Flexible costing model enables all our preference requirements.

---

### 2. GraphHopper
- **Source**: https://github.com/graphhopper/graphhopper
- **Language**: Java
- **License**: Apache 2.0

**Strengths:**
- Mature, production-ready
- Custom profiles via JSON configuration
- Good bike routing support
- Active development

**Bike-Specific Capabilities:**
- Custom weighting for bike infrastructure types
- Surface type consideration
- Speed profiles
- Turn costs

**Considerations:**
- Java ecosystem (if team prefers Python/JS/Go)
- Less flexible dynamic costing than Valhalla
- Profile changes may require graph rebuild

**Verdict:** Strong alternative to Valhalla, especially if Java experience available.

---

### 3. OSRM (Open Source Routing Machine)
- **Source**: https://github.com/Project-OSRM/osrm-backend
- **Language**: C++
- **License**: BSD-2-Clause

**Strengths:**
- Very fast routing
- Low memory footprint
- Well-documented
- Production-ready (used by many services)

**Limitations:**
- Limited bike-specific customization
- Profiles baked into pre-processed data (requires rebuild for changes)
- Fewer bike-specific features compared to Valhalla/GraphHopper

**Verdict:** Fast but less flexible. Not recommended for this use case.

---

### 4. Pyroutelib3
- **Source**: https://github.com/MKuranowski/pyroutelib3
- **Language**: Python
- **License**: GPL-3.0

**Strengths:**
- Pure Python, easy to modify
- Lightweight
- Simple API
- Can work with OSM XML directly

**Limitations:**
- Not production-ready for large-scale routing
- Performance limitations
- No advanced bike-specific features
- Limited to basic A* routing

**Verdict:** Good for prototyping, not for production.

---

### 5. BRouter
- **Source**: https://github.com/abrensch/brouter
- **Language**: Java
- **License**: GPL-3.0

**Strengths:**
- Specifically designed for bike and hiking routing
- Very detailed bike-specific profiles
- Used by OsmAnd and Locus Map
- Efficient offline routing

**Bike-Specific Capabilities:**
- Extensive profile system for different bike types
- Surface quality weighting
- Traffic level consideration
- Hill climbing preferences

**Considerations:**
- Profile format is powerful but complex
- Less flexible than Valhalla for dynamic adjustments
- GPL license may be restrictive

**Verdict:** Strong contender for bike-specific use case. Consider if routing logic needs to be very cycling-specific.

---

## Recommendation: Valhalla

**Rationale:**
1. **Dynamic Costing**: Adjust preferences at query time without rebuilding graph — critical for testing different preference weightings
2. **Bike Features**: Comprehensive bike-specific options align with our safety preference model
3. **Production Ready**: Battle-tested by major services
4. **Flexible API**: Can build custom costing functions for our specific needs
5. **Time-Aware**: Supports time-of-day routing for future phases

**Implementation Path:**
1. Deploy Valhalla instance with Berlin OSM extract
2. Create custom costing profiles for rider types:
   - `family_with_trailer`: Heavily weight Fahrradstrasse/separated paths
   - `confident_solo`: More tolerant of bus lanes and busy streets
   - `child_riding`: Balance between family and solo profiles
3. Map OSM tags to preference weights:
   - `bicycle_road=yes` (Fahrradstrasse): 0.1x cost
   - `cycleway=track`: 0.2x cost
   - `cycleway:lane`: 0.5x cost
   - Quiet residential: 0.7x cost (time-aware)
   - Busy roads: 2.0-5.0x cost
4. Build API layer to translate user preferences to Valhalla costing

**Alternative if Valhalla is too heavy:** BRouter for bike-specific routing, but sacrifice some flexibility.

## Data Source: OpenStreetMap

All engines use OSM data. Key Berlin OSM tags for our use case:
- `bicycle_road=yes`: Fahrradstrasse
- `cycleway=track`: Separated bike path
- `cycleway=lane`: Painted bike lane
- `cycleway:surface=*`: Surface quality
- `highway=cycleway`: Dedicated cycle path
- `traffic_calming=yes`: Verkehrsberuhigung
- `maxspeed=*`: For identifying quiet streets

Extract: Download from Geofabrik (https://download.geofabrik.de/europe/germany/berlin.html)
