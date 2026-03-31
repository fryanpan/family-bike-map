# BC-222: Initial Prototype Web App — Implementation Plan

**Status:** In progress
**Branch:** `ticket/BC-222`
**Target deploy:** `family-bike-map.surge.sh`

---

## Original Task Requirements

Build an initial prototype web app for Berlin bike routing.

### Core Features
1. **Route planning** — start/end point selection with place search (Nominatim)
2. **Three routing profiles** with different Valhalla costing:
   - **Biking with toddler** — heavily prefer Fahrradstrasse, separated paths; avoid cobblestones, roads
   - **Bike trailer** — mostly separated paths; roadside lanes OK; avoid bad surfaces
   - **Fast training ride** — Fahrradstrasse great; bus lanes good; 30 km/h roads OK
3. **Avoid cobblestones** via Valhalla `avoid_bad_surfaces` parameter (all profiles)
4. **Route editing** via waypoints — add intermediate points to force route through preferred streets
5. **Turn-by-turn directions** with voice navigation (Web Speech API)

### Approach Decisions
- **Routing engine**: Valhalla public instance (`valhalla1.openstreetmap.de`) — no API key, supports dynamic bike costing
- **Map**: Leaflet + OpenStreetMap tiles (free, no key)
- **Geocoding**: Nominatim (OSM, free, no key)
- **Frontend**: Vite + React (fast, modern, mobile-first)
- **Backend**: Cloudflare Worker (feedback endpoint + CORS proxy for Valhalla/Nominatim)

---

## Requirements Added During Implementation

### Mobile-First UI
- Optimised for mobile: full-screen map + bottom sheet panel
- Bottom sheet slides up/down via pull handle
- Responsive: sidebar layout on desktop (>=768px)
- Large touch targets (minimum 44px)

### Route Quality Visualization
- Color-code route segments by safety level using Valhalla `trace_attributes` endpoint
- Colors:
  - Green **Great** — Fahrradstrasse / car-free paths (`highway=cycleway`, `bicycle_network>=1`)
  - Blue **Good** — Separated bike path (`cycle_lane=separated`)
  - Purple **OK** — Dedicated bike lane (`cycle_lane=dedicated`)
  - Yellow **Acceptable** — Quiet streets, bus lanes, living streets
  - Orange **Caution** — Road with bike markings
  - Red **Avoid** — Busy road with no infra
- Path type emoji icons at segment midpoints
- Map legend showing color meanings

### Bike Map Overlay Mode
- Toggle button to show bike infrastructure for the visible map area
- Queries Overpass API for cycling infrastructure in current viewport
- Colors infrastructure using same safety category scheme
- Updates on pan/zoom (debounced, 600ms)
- Refuses to query if viewport > ~15 km2 (shows "zoom in" message)
- Hover tooltips show path type and road name

### Profile Customisation
- Edit button on each profile card
- Modal with sliders for all Valhalla costing parameters:
  - Bike type (Road/Hybrid/Cross/Mountain)
  - Cycling speed (8-30 km/h)
  - Roads vs paths preference (0-1)
  - Surface quality importance (0-1)
  - Hill tolerance (0-1)
  - Living streets preference (0-1)
- Profile name editable
- Customisations persisted to localStorage
- Route auto-recomputes when editor closes

### Feedback Widget
- Same widget as health tool (feedback-widget.js)
- Posts to Cloudflare Worker which creates a Linear issue in bike-route-finder project
- Requires LINEAR_API_KEY, LINEAR_TEAM_ID, LINEAR_PROJECT_ID as Worker secrets

### CI/CD
- **CI** (PRs): runs `npm test` on every pull request
- **Deploy** (main): builds with Vite, deploys static app to `family-bike-map.surge.sh`
  - Requires SURGE_TOKEN GitHub secret
  - Requires CLOUDFLARE_API_TOKEN GitHub secret for Worker deploy
  - Requires VITE_WORKER_URL build arg set to deployed Worker URL

---

## Architecture

```
family-bike-map.surge.sh (static Vite build)
  |
  | fetch /api/valhalla/*  ->  bike-feedback.fryanpan.workers.dev
  | fetch /api/nominatim/* ->  bike-feedback.fryanpan.workers.dev
  | fetch /feedback        ->  bike-feedback.fryanpan.workers.dev
                                  |
                                  +-- proxy -> valhalla1.openstreetmap.de
                                  +-- proxy -> nominatim.openstreetmap.org
                                  +-- create Linear issue
```

In development, Vite's dev server proxy handles `/api/*` routes directly.

---

## Files Created/Modified

| File | Purpose |
|------|---------|
| `package.json` | Vite + React project |
| `vite.config.js` | Dev proxy for Valhalla + Nominatim |
| `index.html` | HTML entry with feedback widget init |
| `src/main.jsx` | React entry |
| `src/App.jsx` | Main app — state, layout, routing flow |
| `src/App.css` | Mobile-first responsive styles |
| `src/components/Map.jsx` | Leaflet map, colored segments, legend, overlay |
| `src/components/SearchBar.jsx` | Nominatim autocomplete |
| `src/components/ProfileSelector.jsx` | Profile cards with edit button |
| `src/components/DirectionsPanel.jsx` | Route summary + turn-by-turn + voice nav |
| `src/components/ProfileEditor.jsx` | Profile customisation modal |
| `src/components/BikeMapOverlay.jsx` | Overpass-based bike infra overlay |
| `src/services/routing.js` | Valhalla route + trace_attributes |
| `src/services/geocoding.js` | Nominatim search + reverse geocode |
| `src/services/overpass.js` | Overpass API for map overlay |
| `src/utils/polyline.js` | Precision-6 polyline decoder |
| `src/utils/classify.js` | Edge attributes -> safety category |
| `worker/src/index.ts` | Cloudflare Worker: feedback + API proxy |
| `worker/wrangler.toml` | Worker config |
| `worker/package.json` | Worker dependencies |
| `public/feedback-widget.js` | Feedback widget (copied from health-tool) |
| `tests/polyline.test.js` | Polyline decoder unit tests |
| `.github/workflows/ci.yml` | CI: run tests on PRs |
| `.github/workflows/deploy.yml` | Deploy to surge + worker on main |

---

## Required Secrets

| Secret | Where | Purpose |
|--------|-------|---------|
| `SURGE_TOKEN` | GitHub Actions | Deploy to surge.sh |
| `CLOUDFLARE_API_TOKEN` | GitHub Actions | Deploy Cloudflare Worker |
| `VITE_WORKER_URL` | GitHub Actions (build env) | Worker URL injected at build time |
| `LINEAR_API_KEY` | Cloudflare Worker secret | Create Linear issues |
| `LINEAR_TEAM_ID` | Cloudflare Worker secret | Target Linear team |
| `LINEAR_PROJECT_ID` | Cloudflare Worker secret | Target Linear project |
| `LINEAR_ASSIGNEE_ID` | Cloudflare Worker secret (optional) | Auto-assign issues |

---

## Deferred / Known Limitations

- Profile customisation edits existing profiles only — no "add new profile" button yet
- Segment coloring requires `trace_attributes` to succeed — falls back to solid blue if API fails
- Overlay queries Overpass — may be slow; area limit prevents overloading
- Voice navigation is step-through only — no GPS position tracking
- Cobblestone avoidance handled by `avoid_bad_surfaces` Valhalla param; may not catch all tagged streets
- Multi-city architecture ready but only Berlin data in scope
