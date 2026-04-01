# BC-239: Map Data Sources & Routing Layer Review

*Reviewed: 2026-04-01*

---

## 1. Data Sources

### Primary: OpenStreetMap (OSM)
The **sole map data source** is OpenStreetMap. Berlin data is sourced from:
- **Geofabrik Berlin extract**: https://download.geofabrik.de/europe/germany/berlin.html
- **Update cadence**: Monthly (per architecture decision 2026-03-31)

### Three OSM services are used:

| Service | URL | Purpose |
|---------|-----|---------|
| **Valhalla** (public OSM instance) | `valhalla1.openstreetmap.de` | Route calculation + per-edge attributes |
| **Overpass API** | `overpass-api.de` | Map overlay: bike infrastructure visualization |
| **Nominatim** | `nominatim.openstreetmap.org` | Geocoding / address search |

**Important**: The project currently uses the **public shared Valhalla instance** (`valhalla1.openstreetmap.de`) — not a self-hosted instance. This means data freshness is not directly controlled by the project and depends on that server's update schedule.

---

## 2. Routing Engine: Valhalla

Valhalla is used with the `bicycle` costing mode. Three rider profiles are defined:

| Profile | `use_roads` | `avoid_bad_surfaces` | `use_hills` | Bike Type |
|---------|-------------|----------------------|-------------|-----------|
| Toddler | 0.0 (avoid roads entirely) | 0.5 | 0.1 | Hybrid |
| Bike Trailer | 0.15 | 0.5 | 0.15 | Hybrid |
| Fast Training | 0.6 | 0.4 | 0.9 | Road |

### Edge attributes available to routing logic (via `trace_attributes`)

| Field | Values | Meaning |
|-------|--------|---------|
| `edge.use` | 0=road, 18=living_street, 20=cycleway, 25=path | Way type |
| `edge.cycle_lane` | 0=none, 1=sharrow, 2=painted, 3=separated, 4=share_busway | Bike lane type |
| `edge.road_class` | 0=motorway … 4=tertiary, 5=unclassified, 6=residential, 7=service | Road hierarchy |
| `edge.bicycle_road` | true/false | Fahrradstrasse (`bicycle_road=yes` in OSM) |
| `edge.bicycle_network` | 0=none, 1=national, 2=regional, 4=local | Network membership |
| `edge.surface` | `asphalt`, `cobblestone`, `compacted`, etc. | Surface type |

---

## 3. Path Type Analysis

### Berlin-Specific Path Types

#### ✅ Mauerweg (separate recreational path)
- **OSM tags**: `highway=cycleway` (dedicated cycle track)
- **Valhalla**: `edge.use = 20` (cycleway) or `25` (path)
- **Classification**: **GREAT** for all profiles
- **Status**: Fully supported. Berlin's Mauerweg is well-mapped in OSM.

#### ✅ Elevated bikeway beside sidewalk (Hochbordradweg)
- **OSM tags**: `cycleway=track` on the road way, or separate `highway=cycleway` way
- **Valhalla**: `edge.cycle_lane = 3` (separated)
- **Classification**: **GOOD** for all profiles
- **Status**: Well supported. The `cycleway=track` tag maps directly to the "separated" classification.

#### ✅ Bike lane beside car traffic, no separation (painted line)
- **OSM tags**: `cycleway=lane`
- **Valhalla**: `edge.cycle_lane = 2` (dedicated/painted)
- **Classification**:
  - Toddler: **AVOID** ("no better than a road without a bike path")
  - Trailer/Training: **OK**
- **Status**: Correctly handled with profile-aware logic.

#### ⚠️ Bike lane beside car traffic WITH separation (bollards/bumpers)
- **OSM tags**: Typically `cycleway=track`, sometimes `cycleway=lane` + `cycleway:separation=flex_post` or `cycleway:buffer=*`
- **Valhalla**: `edge.cycle_lane = 3` if tagged as track, `2` if tagged as lane
- **Classification**: **GOOD** if `cycleway=track`, but...
- **Gap**: The granular `cycleway:separation` and `cycleway:buffer` tags are **not used** in the classification logic. A bollard-protected lane may be tagged as `cycleway=lane` with separation tags, which would be classified as merely **OK** (or AVOID for toddler) rather than **GOOD**. Whether this matters in practice depends on how Berlin mappers tag such infrastructure.

#### ✅ Fahrradstrasse (bicycle priority roads, cars must defer)
- **OSM tags**: `bicycle_road=yes`
- **Valhalla**: `edge.bicycle_road = true`
- **Classification**: **GREAT** for all profiles
- **Important fix**: Earlier code incorrectly used `edge.bicycle_network` (which tracks NCN/RCN/LCN route memberships) instead of `edge.bicycle_road`. Most Berlin Fahrradstrassen are NOT in a named cycling network, so they were misclassified. This is now corrected.
- **Status**: Correctly handled. `use_living_streets: 1.0` on toddler profile also strongly incentivizes Valhalla to prefer these roads during routing.

#### ✅ Dirt paths in parks (e.g., Engeldam)
- **OSM tags**: `highway=path` with `surface=dirt` or `surface=compacted`
- **Valhalla**: `edge.use = 25` (path)
- **Classification**: **GREAT** (use=25 → great), no surface penalty for `dirt`/`compacted` since those are not in the `BAD_SURFACES` set
- **Status**: Accessible and correctly routed. The `avoid_bad_surfaces=0.5` setting was specifically calibrated (2026-04-01 decision) to avoid cobblestones (surface quality ~0.3) while allowing compacted/dirt park paths (quality ~0.7–0.9).
- **Note**: The Engeldam route (Dresdener Str → Schillingbrücke) was confirmed to use the park dirt path correctly after this calibration.

#### ✅ Paved paths in parks
- **OSM tags**: `highway=path` or `highway=cycleway` with `surface=asphalt` or `surface=paving_stones:smooth`
- **Valhalla**: `edge.use = 20` or `25`
- **Classification**: **GREAT** for all profiles
- **Status**: Fully supported. Smooth surfaces, no penalty.

#### ✅ Dirt paths along canals and rivers (e.g., Spree, Teltow Canal)
- **OSM tags**: `highway=path` with `surface=compacted` or `surface=fine_gravel`
- **Classification**: **GREAT** base; `fine_gravel` is not in BAD_SURFACES so no penalty
- **Status**: Generally accessible. `gravel` IS in classify.ts BAD_SURFACES (one class worse), but `fine_gravel` and `compacted` are not.

#### ✅ Highways (Autobahn, trunk roads)
- **OSM tags**: `highway=motorway`, `highway=trunk`
- **Valhalla**: `edge.road_class = 0` or `1`
- **Classification**: **AVOID** for all profiles (road_class < 4 → avoid)
- **Status**: Correctly excluded from all routes.

#### ✅ Multi-lane stroads (Hauptstraßen)
- **OSM tags**: `highway=primary`, `highway=secondary` (often without protected bike infra)
- **Valhalla**: `edge.road_class = 2` or `3`
- **Classification**: **AVOID** for all profiles (road_class < 4 → avoid in base case)
- **Status**: Correctly handled. If a stroad has `cycleway=track`, it would be classified as GOOD (the track, not the road itself).

#### ✅ Quieter residential streets (Nebenstraßen)
- **OSM tags**: `highway=residential`, `highway=service`
- **Valhalla**: `edge.road_class = 6` or `7`
- **Classification**: **ACCEPTABLE** for all profiles
- **Status**: Well handled. With `use_roads=0.0`, toddler profile will strongly prefer to avoid even residential streets if a cycle path alternative exists.

---

## 4. Data Completeness & Currency for Berlin

### What's well-covered in Berlin OSM
- **Fahrradstrassen**: Berlin has ~100+ designated Fahrradstrassen; OSM coverage is comprehensive
- **Cycleway tracks/lanes**: Berlin's main arterials (Bergmannstr, Oranienstr, etc.) are well mapped
- **Park paths**: Tiergarten, Volkspark Friedrichshain, Treptower Park, Tempelhof paths are mapped
- **Canal paths**: Spree, Landwehrkanal, Teltowkanal towpaths are mapped
- **Mauerweg**: Fully mapped as a named long-distance cycle route

### Data currency caveats
- **Monthly updates** from Geofabrik are planned, but the **public Valhalla instance** has its own update schedule (not controlled by this project)
- New construction (e.g., newly-painted lanes or new Fahrradstrassen) may lag by weeks/months
- Surface quality tags (`surface=*`) are not always kept up-to-date by contributors
- The `cycleway:separation` and `cycleway:buffer` tags (fine-grained protection) are sparsely applied in Berlin OSM compared to the `cycleway=track/lane` primary tags

---

## 5. What Data Is Available to the Routing Engine

### Valhalla has access to (used in costing):
| Available | Used in routing | Used in display |
|-----------|----------------|-----------------|
| `edge.use` (cycleway/path/road) | ✅ Yes (via costing) | ✅ Yes (classifyEdge) |
| `edge.cycle_lane` (none/sharrow/painted/separated/busway) | ✅ Yes | ✅ Yes |
| `edge.road_class` (motorway→service) | ✅ Yes | ✅ Yes |
| `edge.bicycle_road` (Fahrradstrasse) | ✅ Yes (`use_living_streets`) | ✅ Yes |
| `edge.surface` (asphalt/cobblestone/etc.) | ✅ Yes (`avoid_bad_surfaces`) | ✅ Yes |
| `edge.bicycle_network` (NCN/RCN/LCN) | ❌ Not in routing cost | ❌ Not used in display |
| `cycleway:separation`, `cycleway:buffer` | ❌ Not exposed by Valhalla API | ❌ Not used |
| `maxspeed` | ✅ Yes (internal to Valhalla) | ❌ Not in our display |
| `incline`/`smoothness` tags | ✅ Partial (via `avoid_bad_surfaces`) | ❌ Not in our display |

### Overpass map overlay has access to:
The overlay queries these tags directly from OSM:
- `highway=cycleway`
- `bicycle_road=yes`
- `cycleway=track/lane/opposite_track/opposite_lane/share_busway`
- `highway=living_street`
- `highway=residential` (where `bicycle!=no`)

---

## 6. Gaps & Recommendations

### Current gaps:

1. **Separation quality not granular**: `cycleway=track` covers both a 2-metre elevated path AND a bollard-protected painted lane. The `cycleway:separation=flex_post` tag exists in OSM but is not used. This matters for toddler/trailer profiles where the distinction is meaningful.

2. **BAD_SURFACES inconsistency**: `classify.ts` includes `gravel` and `unpaved` in its bad surface set; `overpass.ts` does not. This means the route overlay and the map background overlay classify `gravel` surfaces differently.

3. **Public Valhalla instance dependency**: Data freshness is not controlled by the project. Newly built infrastructure may not appear in routing.

4. **No time-of-day routing**: Residential streets are rated ACCEPTABLE at all times. In reality, a quiet residential street at 8am on a weekday is different from Sunday morning. (Planned for Phase 2.)

5. **Cycleway on footway**: Paths tagged `highway=footway` + `bicycle=designated` are not in the Overpass query. These are valid cycling surfaces (some park shared paths) and could be missed from the overlay.

### Recommendations:

- Consider moving to a self-hosted Valhalla instance with controlled update schedule
- Add `cycleway:separation` awareness — at minimum, map `flex_post`/`separation_kerb` to a better safety class
- Align `BAD_SURFACES` between `classify.ts` and `overpass.ts`
- Add `highway=footway` + `bicycle=designated` to Overpass query for map overlay
