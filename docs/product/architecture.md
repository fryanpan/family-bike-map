# Technical Architecture

## System Overview

```mermaid
graph TB
    subgraph "Browser (React SPA)"
        UI[Map UI<br/>React + Leaflet]
        ClientRouter[Client Router<br/>ngraph.path A*]
        TileCache[Tile Cache<br/>In-memory + IndexedDB]
        Classify[Classifier<br/>classify.ts + overpass.ts]
        Scorer[Route Scorer<br/>routeScorer.ts]
    end

    subgraph "Cloudflare"
        Worker[Worker<br/>API proxy + D1 + KV]
        EdgeCache[Edge Cache<br/>30-day TTL]
        D1[(D1 Database<br/>route logs)]
        KV[(KV Store<br/>classification rules)]
    end

    subgraph "External APIs"
        Valhalla[Valhalla<br/>fallback routing]
        Nominatim[Nominatim<br/>geocoding]
        Overpass[Overpass API<br/>OSM infrastructure data]
        Mapillary[Mapillary<br/>street imagery]
    end

    UI --> ClientRouter
    ClientRouter --> TileCache
    TileCache -->|cache miss| Worker
    Worker -->|proxy + cache| Overpass
    Worker -->|proxy| Valhalla
    Worker -->|proxy| Nominatim
    Classify --> TileCache
    Scorer --> TileCache
    UI -->|route log| D1
    UI -->|rules| KV
    EdgeCache -->|30-day TTL| Overpass
```

## Routing Architecture

```mermaid
flowchart TD
    Start[User searches route] --> Fetch[Fetch/cache Overpass tiles<br/>for route corridor]
    Fetch --> Build[Build graph from<br/>cached OsmWay data]
    Build --> AStar[A* pathfinding<br/>ngraph.path]
    AStar --> Found{Path found?}
    Found -->|Yes| Score[Score segments<br/>using classifier]
    Found -->|No| Fallback[Fallback to Valhalla]
    Score --> Heal[Heal intersection gaps<br/>≤30m between preferred]
    Heal --> Display[Display route on map]
    Fallback --> ValScore[Score Valhalla route<br/>using same classifier]
    ValScore --> Heal
```

### Cost Model (speed-based)

The client router uses **time as cost** — faster segments are cheaper. This naturally handles multimodal routing: walking is slow, biking preferred paths is fast.

| Infrastructure (toddler) | Speed | Cost per 100m |
|---|:---:|:---:|
| Fahrradstrasse | 12 km/h | 30s |
| Bike path (Radweg) | 10 km/h | 36s |
| Elevated sidewalk path | 9 km/h | 40s |
| Shared foot path / Living street | 8 km/h | 45s |
| Residential/local road | 4 km/h | 90s |
| Painted bike lane | 3 km/h | 120s |
| Walking (footway) | 5 km/h | 72s |
| Unclassified road without sidewalk | **Excluded** | ∞ |

### Gap Healing

OSM has short unclassified segments at intersections (crossings, turning circles). If a non-preferred segment is ≤5 coordinates (~30m) with preferred segments on both sides, it inherits the surrounding classification. Applied to route display, quality metrics, and client router output.

## Data Flow

```mermaid
sequenceDiagram
    participant User
    participant App
    participant Cache as Tile Cache
    participant Router as Client Router
    participant Worker
    participant Overpass

    User->>App: Search destination
    App->>Cache: Need tiles for corridor?
    Cache-->>App: Some cached, some missing
    App->>Worker: Fetch missing tiles
    Worker->>Overpass: Query (or serve 30-day edge cache)
    Overpass-->>Worker: OSM ways
    Worker-->>App: Ways data
    App->>Cache: Store tiles (memory + IndexedDB)
    App->>Router: Route on graph
    Router->>Cache: Read all corridor tiles
    Router->>Router: Build graph, A* search
    Router-->>App: Route + segments
    App->>App: Heal gaps, compute quality
    App->>App: Display on map
    App->>Worker: Log route to D1
```

## Classification System

Single source of truth for all infrastructure classification. Used by: map overlay, route coloring, route scoring, client router cost function.

```mermaid
graph LR
    OSM[OSM Tags<br/>highway, cycleway,<br/>surface, bicycle_road] --> Classify[classifyOsmTagsToItem<br/>overpass.ts]
    Rules[Region Rules<br/>Cloudflare KV] --> Classify
    Classify --> ItemName[Item Name<br/>e.g. Fahrradstrasse,<br/>Painted bike lane]
    ItemName --> Preferred{In preferredItemNames?}
    Preferred -->|Yes| Green[Green on map<br/>Low routing cost]
    Preferred -->|No| Orange[Orange on map<br/>High routing cost]
```

### Per-travel-mode infrastructure preferences

| Infrastructure | Toddler | Trailer | Training |
|---|:---:|:---:|:---:|
| Bike path | Preferred | Preferred | Preferred |
| Fahrradstrasse | Preferred | Preferred | Preferred |
| Shared foot path | Preferred | Preferred | Preferred |
| Elevated sidewalk path | Preferred | Other | Other |
| Living street | Preferred | Preferred | Preferred |
| Painted bike lane | Other | Preferred | Preferred |
| Shared bus lane | Other | Preferred | Preferred |
| Residential/local road | Other | Preferred | Preferred |
| Rough surface | Other | Other | Other |

### Surface handling (per-mode)

| Surface | Toddler | Trailer | Training |
|---|:---:|:---:|:---:|
| paving_stones | OK | Rough | Rough |
| compacted | OK | OK | OK |
| sett/cobblestone | Rough | Rough | Rough |
| dirt/gravel/sand | Rough | Rough | Rough |

## Key Files

| File | Purpose |
|------|---------|
| `src/services/clientRouter.ts` | Client-side A* routing on Overpass graph |
| `src/services/routeScorer.ts` | Score any route using Overpass data |
| `src/services/overpass.ts` | Overpass queries, tile cache, `classifyOsmTagsToItem` |
| `src/utils/classify.ts` | PROFILE_LEGEND, quality metrics, gap healing |
| `src/services/routing.ts` | Valhalla API (fallback), profile definitions |
| `src/services/tileCache.ts` | IndexedDB tile persistence, city detection |
| `src/services/brouter.ts` | BRouter API (comparison routing) |
| `src/services/rules.ts` | Per-region classification rules (KV) |
| `src/services/audit.ts` | City scan, tag grouping, classification audit |
| `src/services/routeLog.ts` | Route logging to D1 |
| `src/services/mapillary.ts` | Mapillary street-level imagery |
| `src/components/Map.tsx` | Leaflet map, route display, segment suggestions |
| `src/components/BikeMapOverlay.tsx` | Canvas-rendered bike infrastructure overlay |
| `src/components/DirectionsPanel.tsx` | Navigation, GPS tracking, speech |
| `src/components/AuditPanel.tsx` | Admin classification audit tool |
| `src/worker.ts` | Cloudflare Worker (all API endpoints) |
| `scripts/benchmark-routing.ts` | Routing quality benchmark (22 Berlin test routes) |

## Infrastructure

| Service | Purpose | Cost |
|---------|---------|------|
| Cloudflare Pages + Workers | SPA hosting + API proxy | Free tier |
| Cloudflare KV | Classification rules per region | Free tier |
| Cloudflare D1 | Route logs, segment feedback | Free tier |
| Cloudflare Edge Cache | 30-day Overpass tile cache | Free |
| Sentry | Error tracking | Free tier |
| Mapillary | Street-level imagery in audit tool | Free API |
| Valhalla (public) | Fallback routing | Free |
| BRouter (public) | Comparison routing | Free |
| Overpass (public) | OSM infrastructure data | Free |

## Benchmark Results (2026-04-11)

22 Berlin test routes, toddler mode:

| Engine | Avg preferred % | Notes |
|--------|:---:|------|
| **Client router** | **57%** | Uses Overpass data + speed-based costing |
| BRouter (safety) | 40% | Generic safety profile, can't express our preferences |
| Valhalla | 35% | `use_roads=0.0` but treats painted lanes as bike infra |

**Note:** The benchmark scores Valhalla/BRouter routes using coordinate-matching against Overpass data (different from the app's segment-based scoring with gap healing). The app's displayed % may differ slightly from benchmark numbers.

## Architecture Rules

1. **Single classification source:** `classifyOsmTagsToItem` in overpass.ts is THE classifier. Used by overlay, router, scorer. Never duplicate.
2. **Never push to main.** Always branch → PR → CI → merge.
3. **Tile cache is the routing graph.** What you see on the map overlay IS what the router routes on.
4. **Speed IS the penalty.** No arbitrary multipliers. Walking is slow → high cost → router finds detours.
5. **Heal intersection gaps.** Short non-preferred gaps between preferred segments are healed everywhere.
6. **City-agnostic.** All tile fetching, caching, and routing work for any city, not just Berlin.
