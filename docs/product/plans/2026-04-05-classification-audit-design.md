# Classification Audit Tool — Design

## Problem

Our bike infrastructure classifier has gaps:
- `cycleway:*=separate` (the most common value in Berlin) returns `null`
- Same OSM tags mean different real-world quality across cities (Copenhagen tracks are excellent; Berlin tracks are often narrow and bumpy)
- No systematic way to discover what tag combinations exist, verify classifications, or fix errors
- Surface/smoothness tags are under-utilized (we check `surface` but ignore `smoothness` and `tracktype`)
- US-style bikeable roads (`highway=tertiary`, low speed, no cycling tags) are invisible

## Solution

An admin audit tool that scans cities, groups ways by tag pattern, shows examples with street-level imagery, and lets reviewers set classification rules — stored server-side with per-region overrides.

## Architecture

### Three phases

1. **Scan** — Sample ~20 tiles across a city bbox via Overpass API. Fetch all cycling-tagged ways plus `highway=residential/tertiary/unclassified/service/living_street/path/footway/track`. Run each through the classifier for all three travel modes. Group by tag signature. Cache results in IndexedDB.

2. **Browse** — Admin panel shows groups sorted by way count. Each group displays: tag signature, classification per travel mode (or "Unclassified"), way count. Expanding a group shows 5 sample pins on a mini-map with Mapillary street-level photos (lazy-loaded).

3. **Review** — Reviewer confirms, overrides, or adds classification. Overrides are saved as server-side rules via the Cloudflare Worker API.

### Scan details

**Tile sampling strategy:**
- Divide city bbox into a grid
- Pick ~20 tiles biased toward areas with cycling infrastructure (center, known corridors) plus outer neighborhoods
- Each tile = one Overpass query (~500-2000 ways)
- Total: ~10K-30K ways per city, ~2-3 minutes with API rate limits

**Tags fetched:**

Group A (cycling-specific):
- `cycleway`, `cycleway:right`, `cycleway:left`, `cycleway:both` (any value)
- `highway=cycleway`
- `bicycle_road=yes`, `cyclestreet=yes`
- `bicycle=designated/yes/use_sidepath/optional_sidepath`

Group B (potentially bikeable roads):
- `highway=residential/tertiary/unclassified/service/living_street/path/footway/track`

**Per-way data stored:**
- OSM ID, raw tags, centroid lat/lng
- Classifier result for each travel mode (toddler/trailer/training)
- Tag signature string for grouping (e.g. `highway=tertiary + cycleway:right=lane + surface=asphalt`)

**Storage:** IndexedDB per city scan. Only tags + centroid stored (no geometry). ~5 samples kept per group. Estimated 1-3MB per city.

### Server-side classification rules

**Storage:** Cloudflare KV, keyed by region.

**Resolution order:**
1. City-level override (e.g., `berlin`)
2. Country-level default (e.g., `germany`)
3. Global default (current hardcoded classify.ts logic)

**Region matching:** Based on map viewport bbox. App fetches applicable rule set on load, cached client-side with TTL.

**Rule format:**
```json
{
  "region": "berlin",
  "bbox": [52.34, 13.08, 52.68, 13.76],
  "rules": [
    {
      "match": { "highway": "cycleway", "surface": "asphalt" },
      "matchOp": "all",
      "classification": "Car-free path / Radweg",
      "travelModes": {
        "toddler": "preferred",
        "trailer": "preferred",
        "training": "preferred"
      }
    }
  ],
  "legendItems": [
    {
      "name": "Low-speed side street",
      "icon": "🏘️",
      "description": "Tertiary road with maxspeed<=30 and low traffic"
    }
  ]
}
```

Rules and legend items are editable from the audit UI. New legend items added in a region are available as classification targets immediately.

### Mapillary integration

**API:** Mapillary v4 (free, CC BY-SA, 60K requests/min).

**Usage:** When a group card is expanded, fetch the nearest Mapillary image for each of the 5 sample centroids. Display as thumbnails that expand on click.

**Endpoint:** `GET https://graph.mapillary.com/images?bbox={lng-0.001},{lat-0.001},{lng+0.001},{lat+0.001}&limit=1&fields=id,thumb_1024_url,computed_geometry`

Requires a Mapillary client token (free to obtain, stored as env var).

## UI Design

### Entry point

Small gear icon (⚙️) in the bottom-left of the map, near the bike layer toggle. Subtle gray, easy to miss for regular users. Opens `/admin/audit` as a full-page overlay.

### Audit panel layout

```
┌──────────────────────────────────────────────────┐
│ Classification Audit                              │
│                                                  │
│ City: [Berlin ▾]  [Scan]    Last scan: 2 hrs ago │
├──────────────────────────────────────────────────┤
│ Filter: [All ▾] [Toddler ▾]    Search: [      ] │
├──────────────────────────────────────────────────┤
│                                                  │
│ ┌─ Separated bike track (187 ways) ─── ✅ ─────┐ │
│ │ cycleway:right=track, highway=secondary       │ │
│ │ toddler: preferred | trailer: other           │ │
│ └───────────────────────────────────────────────┘ │
│                                                  │
│ ┌─ Unclassified (342 ways) ─── ❓ ─────────────┐ │
│ │ cycleway:right=separate, highway=secondary    │ │
│ │ [Should be: ▾ _______________]                │ │
│ └───────────────────────────────────────────────┘ │
│                                                  │
│ Expanded card:                                   │
│ ┌───────────────────────────────────────────────┐ │
│ │ Residential road (891 ways) ── ✅             │ │
│ │ highway=residential, surface=asphalt          │ │
│ │                                               │ │
│ │ [mini-map with 5 pins]                        │ │
│ │                                               │ │
│ │ 📷 Sample 1   📷 Sample 2   📷 Sample 3      │ │
│ │ Bergmannstr   Oranienstr    Wrangelstr        │ │
│ │                                               │ │
│ │ [✅ Correct] [Override ▾] [🏁 Flag]          │ │
│ └───────────────────────────────────────────────┘ │
│                                                  │
│ [Rules tab] [Legend items tab]                    │
└──────────────────────────────────────────────────┘
```

### Tabs

- **Groups** (default): browse tag combination groups with samples
- **Rules**: view/edit all classification rules for the selected region, reorder priority
- **Legend Items**: add/rename/remove legend items for the selected region

### Key interactions

- **Scan**: triggers tile sampling + Overpass queries, shows progress bar
- **Expand group**: shows mini-map + lazy-loads Mapillary images for 5 samples
- **Confirm**: marks group as reviewed (checkmark badge)
- **Override**: pick a classification from dropdown (creates/updates a server-side rule)
- **Add legend item**: inline form in Legend Items tab, immediately available as override target
- **Filter**: by classification status (all/unclassified/classified), by travel mode, text search on tag values

## Tags to audit (beyond current set)

### Infrastructure tags to add to Overpass queries
- `cyclestreet=yes`
- `cycleway=shared_lane/shoulder`
- `bicycle=use_sidepath/optional_sidepath/designated`
- `maxspeed` (for low-speed road detection)
- `barrier=cycle_barrier` (routing hazard)
- `segregated=yes/no`
- `ramp:stroller=yes`, `ramp:bicycle=yes`

### Surface/smoothness classification

Use `smoothness` as primary signal when available, fall back to `surface`, then `tracktype`:

| Smoothness | Family verdict |
|-----------|---------------|
| excellent, good | Comfortable |
| intermediate | OK |
| bad | Avoid for toddler/trailer |
| very_bad and worse | Avoid for all |

Surfaces to add to BAD_SURFACES:
- `compacted`, `fine_gravel`, `dirt`, `earth`, `ground`, `mud`, `sand`, `grass`, `grass_paver`, `pebblestone`, `woodchips`

Consider removing `paving_stones` from BAD_SURFACES (CyclOSM classifies it as road-quality).

## Future extensions

- **User-facing preference mode**: same UI but simplified — users see examples and vote "would you ride here with your kid?" Aggregated votes inform regional rules.
- **Automated Mapillary ML**: use Mapillary's built-in object detections to auto-flag discrepancies between OSM tags and detected infrastructure.
- **SimRa/OpenBikeSensor integration**: layer near-miss and passing-distance data onto the audit view to enrich safety scoring.
- **Per-segment overrides**: in addition to tag-pattern rules, allow overriding classification for a specific OSM way ID.
