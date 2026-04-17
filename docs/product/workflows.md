# User Workflows

Top-level summary of what a real user does with family-bike-map. This is
the source of truth for UX reviews, screenshot tours, and
feature-complete checklists. When a workflow changes in the product,
update this doc.

For the product *vision* see `vision.md`; for *why* the routing modes
exist as they do see `routing-use-cases.md`; for the stress model behind
the kid-mode progression, the "family-cycling stress model" section at
the top of `routing-use-cases.md`.

Live at **bike-map.fryanpan.com**.

## The five workflows

### W1 · First-time setup
A brand-new user opens the app. Berlin map loads (there's no geolocation
permission ask yet). They see the bike-infra overlay, the travel-mode
picker, and the search bar. Home and School are EMPTY — the quick
options read "Tap to add Home" / "Tap to add School" with instructions
when tapped.

**Success criteria**: within ~30 seconds, the user understands what the
app does, can see a green path near them, and knows how to search for
a place. They're not confused about the empty Home / School slots.

### W2 · Browse bike infrastructure
The user pans and zooms to explore what bike infrastructure exists in
their area. Green polylines = preferred for the selected travel mode;
orange = other (hidden by default, toggle in the legend).

**Key interactions**:
- Pan / zoom the map — tiles fetch lazily from Overpass
- Switch travel mode (top-right picker) — same map, different green/orange split
- Toggle "Show other paths" in the legend — reveal orange polylines
- Tap any path segment — popup with OSM tags + Mapillary street image
- Legend items can be moved between Preferred and Other (customizes colors; persists to localStorage + URL)

**Success criteria**: user can answer "what bike infra is near me?"
without any routing. Profile switches feel like lens changes — same
geography, different verdicts.

### W3 · Search a place
User types an address or place name in the search bar. Nominatim
autocomplete returns suggestions (debounced 300ms). User selects one →
place-detail card slides up, map pans to the place, marker drops.

**From the place card**:
- 🚲 **Directions** — start routing from current location to this place
- 🏠 **Save as Home** — store this place in localStorage as Home
- 🏫 **Save as School** — store this place in localStorage as School
- ← **Back** — return to search

**Success criteria**: autocomplete returns relevant results for typical
queries. Once a place is saved as Home/School, the quick options
persist across reloads and route directly to the saved coords.

### W4 · Get a route
User taps Directions from a place card, OR enters the routing mode
manually (start + end search bars). The client router builds a routing
graph from cached Overpass tiles, runs A* with mode-appropriate costing,
and renders the route as a classified polyline (green preferred, orange
bridge segments or lower-priority infra, red walking segments).

**Routing mode layout**:
- Top: routing header (← back, start input, end input, ⇅ swap)
- Map: route polyline + segment marker icons
- Bottom: route summary card (distance, time, preferred %, directions panel)

**Key interactions**:
- Change travel mode mid-route → re-routes with new costing
- Tap on map → add waypoint
- Tap × on waypoint → remove it
- Tap alternate route polyline (dashed) → swap selected route

**Success criteria**: route prefers kid-appropriate infra (88%+ on
kid-traffic-savvy, 52–58% on stricter kid modes). Walking bridges
appear only for short unavoidable gaps. Route visibly changes when
switching between modes.

### W5 · Admin / evaluate
Power-user flow for reviewing the classifier. Accessed via the ⚙️ gear
button bottom-left, OR by visiting `?admin=samples`. Shareable URLs
per tab:

- `?admin=samples` — per-type Mapillary image gallery (default tab)
- `?admin=groups` — OSM tag groups with classification status
- `?admin=rules` — region-specific classification rules
- `?admin=legend` — legend-item CRUD
- `?admin=eval` — routing benchmark harness

Core loop: scan a city → browse infrastructure types → spot-check
Mapillary images → override classification if wrong.

**Success criteria**: a reviewer can decide "is this classifier right
about 'Elevated sidewalk path' in Berlin?" in under 2 minutes per
type.

## Mode picker (cross-cutting)

The travel-mode picker is visible in W2 (map), W4 (routing), and W5
(samples tab). Five modes — kid-starting-out, kid-confident,
kid-traffic-savvy, carrying-kid, Fast training — shown as landscape
line-art icons (adult + kid + trailer / car as appropriate). Active
mode gets a blue border. Changing the mode updates the entire app in
place (no reload).

See `routing-use-cases.md` for the full stress-model rationale behind
the kid-mode progression.

## State persistence

| State | Storage | Scope |
|---|---|---|
| Travel mode | URL `?travelMode=` + localStorage | Across sessions |
| Preferred items | URL `?preferred=` + localStorage | Across sessions |
| Show other paths | URL `?showOther=1` | Session / URL |
| Saved Home | localStorage `bike-route-home` | Across sessions |
| Saved School | localStorage `bike-route-school` | Across sessions |
| Route start/end | React state | Current route only |
| Active admin tab | URL `?admin=` | Shareable |
| Visited bike tiles | IndexedDB (30-day TTL, 2000-tile LRU) | Across sessions |
