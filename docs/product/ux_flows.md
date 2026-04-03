# UX Flows

Key user interface flows and their intended behaviour.

## Flow 1: Browse map to scout nearby routes

**Context**: User is at or near their current location and wants to understand what bike infrastructure exists around them — to plan where to head next, evaluate a potential route, or just get oriented before leaving home.

### Entry points
- App loads and GPS locates the user → map centers on current location
- User manually pans/zooms to a familiar area

### What the user sees
- **Bike infrastructure overlay** (default: on): coloured polylines for all known bike ways in the current viewport, fetched from Overpass and classified by safety level
  - Green lines: preferred path types (Fahrradstrasse, car-free paths, footways by default)
  - Orange/Red lines: non-preferred or avoid (shown only when "Show other paths" is toggled)
- **Legend** (top-right): shows which path types are preferred vs. other, based on the active profile. User can move items between preferred/other to customise what they see
- **Profile selector** (top): toddler / trailer / training — changing profile immediately re-fetches the overlay with profile-appropriate classifications

### Key interactions
1. **Pan and zoom** to see nearby infrastructure tiles as they load
2. **Toggle "Bike Layer"** (bottom-left) to compare with base map
3. **Profile switch** to see how infrastructure quality changes by riding mode
4. **Legend adjustments** — move a path type from Preferred to Other (or vice versa) to control which ways appear green on the map
5. **"Show other paths" toggle** in the legend header — makes orange/red paths visible without moving them to preferred

### Design intent
The overlay is the core value here. It lets the user answer "is there a Fahrradstrasse near me?" or "where do the car-free paths go?" without having to know OSM tags or look at multiple tools. The profile selector should feel like switching between different lenses: same geography, different safety thresholds.

---

## Flow 2: Get a directed route from A to B

**Context**: User knows their destination and wants the app to find the safest, most comfortable route given their current riding mode.

### Entry points
- User types a destination in the "End" search bar
- User sets both start and end locations

### Step-by-step
1. **Set start**: type an address or tap "Current Location" quick option (reverse-geocoded from GPS). Alternatively, tap "Home" to use the hardcoded home address.
2. **Set end**: type destination in the End search bar → Nominatim autocomplete → select result
3. **Route computed**: Valhalla bicycle routing runs with the active profile's `costingOptions` (speed, road avoidance, surface avoidance, etc.)
4. **Initial display**: route renders as a plain blue polyline while edge classification is fetched asynchronously
5. **Coloured segments appear**: trace_attributes call classifies each edge → green (preferred), orange (other). Non-preferred segments are hidden unless "show other paths" is on
6. **Directions panel** slides up: shows total distance/time, turn-by-turn maneuvers, and a route quality bar (fraction preferred vs. non-preferred)

### Key interactions
- **Profile switch mid-route**: re-runs routing with new profile's costing; preferred classes update for the new profile
- **Legend adjustments**: moving a path type between preferred/other updates which route segments appear green/hidden without re-routing
- **"Show other paths" toggle**: reveals hidden orange segments on the route (useful to understand why the app routed a certain way)
- **Tooltip on segment**: hover/tap a coloured segment to see the path type name and safety class icon

### Design intent
The two-step render (route geometry first, then classified segments) keeps perceived latency low. The route quality bar is a quick summary of how "family-friendly" the found route is. Users shouldn't need to manually adjust routing parameters — the profile encodes the safety preferences, and the legend adjustments are a post-hoc view control (they change what you see, not what the router chose).

### Known gap
Legend adjustments currently affect **display only** — moving a path type between preferred/other does not re-run routing with different costing. The route chosen by Valhalla is determined entirely by the profile's `costingOptions`. A future improvement would be to translate preferred item selections into adjusted costing parameters and re-route automatically.

---

## State shared across both flows

| State | Where stored | Scope |
|-------|-------------|-------|
| Active profile | URL `?mode=` + localStorage | Persists across sessions |
| Custom preferred items | URL `?preferred=` + localStorage | Persists across sessions |
| Show other paths | URL `?showOther=1` | Persists in URL/session |
| Route start/end | In-memory (React state) | Current session only |
| Profile edits (costing sliders) | localStorage `bike-route-profiles` | Persists across sessions |
| Overlay tile cache | In-memory (overpass.ts module) | Current session only |
