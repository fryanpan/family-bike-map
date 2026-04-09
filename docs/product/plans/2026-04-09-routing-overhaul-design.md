# Week of 2026-04-09: Routing Overhaul Design

## Slices (deploy order)

### Slice 1: Route Logging + D1 Database
- Add D1 binding to wrangler.toml
- Create route_logs table (id, timestamp, start/end coords+labels, travel mode, engine, distance, duration, preferred_pct, lts_breakdown, worst_segment, coordinates)
- POST /api/route-log endpoint on Worker
- GET /api/route-logs endpoint (list, filterable)
- Frontend: log every route computation automatically

### Slice 2: Valhalla Alternates + Route List UI
- Pass `alternates: 2` to Valhalla route request
- Return array of routes instead of single route
- Route list UI: cards showing distance, time, % preferred for each
- Selected route shown prominently, others faded on map
- Compute segments for all routes (background)

### Slice 3: BRouter Integration
- Add BRouter service (src/services/brouter.ts)
- Proxy BRouter requests through Worker (/api/brouter)
- Write family-bike BRouter profile parameters
- Parse BRouter GeoJSON response with per-segment OSM tags
- Show BRouter route alongside Valhalla routes in route list
- Log BRouter routes to D1

### Slice 4: LTS Scoring
- Compute LTS per segment from OSM tags (maxspeed + lanes + cycleway)
- Add LTS breakdown to route quality display
- Family Safety Score (0-100) per route
- "Worst segment" callout with street name

### Slice 5: Live Turn-by-Turn Navigation
- Track GPS position during navigation (useGeolocation watch)
- Auto-advance to current step based on proximity
- Speak instructions at the right time (distance-based trigger)
- Show preferred/not-preferred indicator for current segment
- Walk-the-bike indicator when on dismount segments

### Slice 6: BRouter Bike+Walk Hybrid
- BRouter profile with dismount fallback for high-LTS segments
- Display walking sections differently (dashed line, walking icon)
- Turn-by-turn: "Walk your bike here: 200m on sidewalk"
- Training mode: suggest road when elevated path is available

### Slice 7: Segment Feedback
- During navigation: thumbs up/down on current segment
- "Report issue" button: mismatch, unsafe, surface problem
- Save feedback to D1 (segment coords, OSM way ID, feedback type)
- Feed into evaluation dataset

### Slice 8: Evaluation Harness
- Admin page: pick an origin/destination pair from route logs
- Run it through all engines (Valhalla toddler/trailer/training, BRouter)
- Side-by-side comparison: distance, time, % preferred, LTS breakdown, worst segment
- Track improvements over time as profiles/rules change
