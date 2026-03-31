# Existing Tools Research

Source: Notion doc "Bicycle Route Mapping Solution"

## Official Maps

### 1. InfraVelo Projektkarte ★ Best official map
- URL: https://www.infravelo.de/karte/
- **Description**: Official Berlin bike infrastructure map
- **Features**:
  - Toggle layers for: Fahrradstraßen, protected bike lanes, structurally separated paths
  - Filter by completed vs. planned infrastructure
  - Shows all 24 new Fahrradstraßen being added in Mitte
- **Bryan's Assessment**:
  - ✅ Has decent data for separated bike paths and Fahrradstrasse
  - ✅ Can save a bookmark to a view with only relevant layers enabled
  - ❌ UX is hard to use (very cluttered and hard to read), makes manual routefinding difficult
  - ❌ Has no routefinding of its own
  - ❌ No ability to consider additional characteristics (e.g., quiet streets at certain times)
  - ❌ Doesn't help connect gaps in the network

### 2. CyclOSM
- URL: https://www.cyclosm.org/#map=13/52.5200/13.4050/cyclosm
- **Description**: OpenStreetMap rendering specifically for cyclists
- **Features**:
  - Color-codes: separated tracks vs painted lanes vs shared roads
  - Shows surface types (useful for avoiding cobblestones with trailer)
- **Bryan's Assessment**:
  - ✅ Has a ton of data
  - ❌ Essentially unusable in the form above
  - ❌ Too many layers with colors that are too similar
  - ❌ Has no automated route finding

### 3. BBBike Route Planner
- URL: https://www.bbbike.org/Berlin/
- **Description**: Bike-friendly route planner
- **Features**:
  - Enter start/end points to find safe routes that favor cycling infrastructure
- **Bryan's Assessment**:
  - ❌ Has no map functionality
  - ❌ Gives a giant list of routes with no confidence it's done something reasonable
  - ❌ Virtually unusable — looks like a tool from 20+ years ago missing all key modern expectations
  - ❌ Worse than using Mapquest print-yourself maps from the 90s
  - ⚠️  But maybe the underlying logic is decent?

### 4. ADFC Berlin on Komoot
- URL: https://www.komoot.com/de-de/user/adfcberlin
- **Description**: ADFC (German Cycling Club) publishes curated family-friendly collections
- **Features**:
  - Turn-by-turn navigation in mobile app
  - Free to follow; paid for offline maps and GPX export
- **Bryan's Assessment**:
  - ❌ Didn't find family-friendly collections?

### 5. ADFC Fahrradplan Berlin (Paper Map)
- **Description**: Physical paper map (~€6.90)
- **Where**: ADFC shop, Brunnenstraße 28, Berlin
- **Features**:
  - Color-codes every street by cycling suitability
  - Laminated, waterproof versions available
- **Bryan's Question**: Is there a PDF online available somewhere?

## Recommended Workflow (from Notion)

1. Use **InfraVelo** to browse official infrastructure and identify safe corridors
2. Use **CyclOSM** to check surface details and confirm separated paths
3. Use **BBBike** to plan specific A→B routes
4. Follow **ADFC on Komoot** for pre-made family routes
5. Buy **ADFC paper map** for overview and offline reference

## Optional: Custom uMap

- URL: https://umap.openstreetmap.fr/
- **Description**: Free, open-source map builder using OpenStreetMap
- **Use cases**:
  - Consolidate documented routes on one shareable map
  - Add personal field notes and photos from trips
  - Mark favorite stops (playgrounds, cafés, ice cream shops)

### Overpass Turbo Query for Fahrradstraße

```
[out:json][timeout:25];
area["name"="Berlin"]->.a;
(
  way["bicycle_road"="yes"](area.a);
);
out geom;
```

Run at https://overpass-turbo.eu/, export as GeoJSON, import to uMap

## Gap Analysis

### What Exists
- Comprehensive infrastructure data (OSM, InfraVelo)
- Basic bike routing (BBBike)
- Curated routes (Komoot/ADFC)
- Visual infrastructure maps (CyclOSM, InfraVelo)

### What's Missing
- **Usable routing UI**: BBBike is outdated, InfraVelo/CyclOSM have no routing
- **Granular preferences**: Can't specify priority order (Fahrradstrasse > separated > quiet streets)
- **Rider profiles**: No distinction between "solo adult" vs "with kids"
- **Gap filling**: No help connecting network gaps with acceptable alternatives
- **Time-aware routing**: Can't specify time-of-day preferences
- **Feedback loop**: Routes don't improve based on user experience
- **Route tweaking**: Can't manually adjust suggested routes and provide feedback
