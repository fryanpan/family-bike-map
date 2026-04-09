# Routing Engine & Safety Scoring Research Synthesis

## Part 1: Routing Engine Recommendation

### The Core Problem
We need a routing engine that can:
1. Apply custom per-segment safety costs based on OSM tags
2. Support bike+walk mid-route (walk short dangerous segments on sidewalk)
3. Return per-segment metadata (road type, surface, tags) for our map overlay
4. Be fast enough for interactive use and cost-effective to host

### Comparison Summary

| Engine | Custom Costs | Bike+Walk | Per-Segment Tags | Speed | Self-Host Cost |
|--------|:-----------:|:---------:|:----------------:|:-----:|:-------------:|
| **Valhalla** (current) | High | No | Needs 2nd API call | ~5-50ms | ~$10-20/mo |
| **BRouter** | Highest | Partial (dismount penalty) | Yes (in response) | ~50-200ms | ~$5-10/mo |
| **GraphHopper** | High | No | Yes | ~1-50ms | ~$10-20/mo |
| **OSRM** | Low (rebuild needed) | No | No | ~1-5ms | ~$10/mo |
| **OpenTripPlanner** | Low (build-time only) | Transit-only | No (street names only) | ~100-500ms | ~$40-120/mo |
| **pgRouting** | Highest (SQL) | Yes (custom graph) | Yes (you define it) | ~50-500ms | ~$20-40/mo |

### Recommendation: Add BRouter alongside Valhalla

**Keep Valhalla** for current routing (it works, we have the integration).

**Add BRouter** as the "family-safe" routing engine because:
1. **Per-segment OSM tags in the response** — no separate trace_attributes call needed. The `messages` array returns `highway=secondary surface=asphalt cycleway:right=track` for every segment.
2. **Scripting-level cost functions** — can match ANY OSM tag: `bicycle_road=yes`, `cycleway:separation=flex_post`, individual surface types. Far more expressive than Valhalla's parameter-based costing.
3. **Dismount fallback** — profiles can model walking speed on `bicycle=dismount` segments, giving us basic bike+walk hybrid routing.
4. **Lightweight** — runs on a $5/mo VPS. MIT license.
5. **Alternative routes** — built-in (`alternativeidx=0,1,2`).
6. **Profile iteration** — edit a `.brf` text file and re-request. No graph rebuild.

**The migration path:**
1. Prototype a `family-bike.brf` profile encoding our safety model
2. Test it on brouter.de against known Berlin routes
3. If results are good, self-host BRouter and use it for the primary route
4. Keep Valhalla as a comparison/fallback

---

## Part 2: Safety Scoring Framework

### The Universal Speed Threshold

Every country studied (Netherlands, Denmark, Sweden, Finland, Germany, Japan, Spain, Colombia, UK) converges on the same number:

**30 km/h is THE critical boundary for child cycling safety.**

Below 30 km/h, mixed traffic is acceptable for families. Above 30 km/h, physical separation is required. This is validated by:
- Dutch CROW manual
- Danish Vejregler
- Swedish Vision Zero
- UK LTN 1/20
- WHO recommendations
- Barcelona superblock evidence (10 km/h interiors are effectively car-free)

### Speed + Volume Matrix (synthesized from CROW, LTN 1/20, Vejregler)

| Speed | < 2,000 vehicles/day | 2,000-5,000/day | > 5,000/day |
|-------|:-------------------:|:---------------:|:-----------:|
| **≤ 10 km/h** | Great | Great | Great |
| **≤ 30 km/h** | Great | OK (separation recommended) | Avoid (separation required) |
| **40-50 km/h** | OK (with separation) | Avoid (without separation) | Avoid |
| **≥ 60 km/h** | Avoid (separation mandatory) | Avoid | Avoid |

### The "Weakest Link" Principle

The most important insight from both Dutch and Danish planning:

**A route's safety is determined by its worst segment, not the average.**

A 5km route with 4.8km of perfect bike paths and 200m of unprotected road crossing is unusable for families. Copenhagen's Skolevejsanalyse (school route analysis) works exactly this way: one dangerous segment flags the entire route.

For our algorithm: apply **exponential penalties** to dangerous segments rather than linear averaging. A route with one LTS 4 segment should score dramatically worse than a route that's uniformly LTS 2.

### Proposed Family Safety Score (0-100)

Four dimensions, weighted per travel mode:

| Dimension | Toddler | Trailer | Training | Data Source |
|-----------|:-------:|:-------:|:--------:|-------------|
| Separation from cars | 40% | 30% | 15% | OSM cycleway/highway tags |
| Surface & comfort | 15% | 30% | 20% | OSM surface/smoothness/width |
| Traffic exposure | 30% | 25% | 25% | OSM maxspeed + road class as volume proxy |
| Directness | 15% | 15% | 40% | Route distance / shortest distance |

**Per-segment separation score:**
- 100: Car-free path, Fahrradstrasse with modal filter
- 85: Fahrradstrasse without modal filter
- 75: Physically separated cycle track (bollards, curb, raised)
- 60: Separated track without known physical barrier
- 40: Painted bike lane with buffer
- 25: Painted bike lane without buffer
- 15: Shared bus lane
- 10: Residential street, no bike facility
- 0: Multi-lane road, no bike facility

**Perceived safety scores (Copenhagen Bicycle Account, 10-point scale):**
- Fully separated path: 8.5
- Raised cycle track: 7.8
- Shared road ≤ 30 km/h: 5.8
- Painted bike lane: 5.2
- Shared road 50 km/h: 3.1

### Display for Parents

**Headline:** Single number + label
- 85-100: "Great for families" (green shield)
- 70-84: "Good with care" (yellow shield)
- 50-69: "Some busy sections" (orange warning)
- 0-49: "Not recommended" (red X)

**Worst segment callout:**
> "Heads up: 200m on Kottbusser Damm (busy road, painted bike lane only)"

This is more actionable than any average score.

---

## Part 3: Country-Specific Design Insights

### Netherlands (CROW / Sustainable Safety)
- **8-80 principle**: if infrastructure works for ages 8 and 80, it works for everyone
- **Separation by speed difference, not user type**: the design variable is motor vehicle speed, not cyclist characteristics
- **Motor traffic is the variable**: when conflicts exist, redirect cars, not bikes
- **70% of casualties at intersections**: route scoring should weight intersection quality heavily
- **Detour tolerance**: families accept ~30-40% longer routes for safety

### Denmark (Copenhagen)
- **Green waves at 20 km/h**: signal timing for cyclists on major corridors
- **Weakest link principle**: one bad segment ruins the whole route
- **Right-turning trucks**: the #1 killer at intersections
- **Width for cargo bikes**: 2.5m minimum for overtaking (Copenhagen standard)
- **Parents' #1 concern**: intersection complexity, not midblock infrastructure

### Finland (Oulu)
- **3m minimum path width**: designed for maintenance machinery and side-by-side cycling
- **Snow clearance priority higher than roads**: this enables year-round cycling
- **60% of school trips by bike even in winter** (Oulu)

### Japan
- **Cultural norms > infrastructure**: low crime, community supervision, slow residential speeds
- **20-30 km/h residential zones**: the speed environment matters more than dedicated infrastructure
- **Most schools ban cycling**: yet children cycle independently to activities

### Barcelona (Superblocks)
- **10 km/h interior zones = effectively car-free** for routing purposes
- **School streets**: time-based car restrictions during drop-off/pick-up
- **Health impact**: full implementation could prevent 667 premature deaths annually

### Belgium/Flanders
- **"Eyes of a child" audits**: children film their school route at child eye-level
- **School streets**: 1,000+ school environments made safer
- **Fietssnelwegen**: 2,800 km planned cycle highway network

---

## Part 4: Implementation Roadmap

### Phase 1: Better Route Display (weeks)
- Valhalla alternates (1-3 routes per query)
- Route list with distance, time, % preferred paths
- "Worst segment" callout per route
- Family Safety Score (0-100) using existing classification data

### Phase 2: BRouter Integration (weeks)
- Write `family-bike.brf` profile encoding our safety model
- Test on brouter.de against known Berlin routes
- Self-host BRouter on Fly.io ($5/mo)
- Use BRouter as primary routing engine, keep Valhalla as fallback
- Single API call returns route + per-segment OSM tags

### Phase 3: LTS-Based Scoring (months)
- Compute actual LTS per segment using OSM maxspeed + lanes + cycleway tags
- Split "Residential & local road" into LTS 1 vs LTS 2
- Intersection quality scoring (signalized vs unsignalized crossings of busy roads)
- Apply exponential "weakest link" penalty

### Phase 4: Bike+Walk Hybrid Routing (months)
- BRouter profile with dismount fallback for dangerous segments
- Display walking sections differently on map (dashed line, walking icon)
- Show "Walk your bike here: 200m" in turn-by-turn
- Time estimate accounts for walking speed

### Phase 5: Crowdsourced Validation (ongoing)
- Post-ride safety ratings (1-5 stars)
- Segment-level flags ("this felt unsafe because...")
- Community-verified badges on popular family routes
- Feed ratings back into per-region classification rules

---

## Key References

### Routing Engines
- Valhalla: github.com/valhalla/valhalla (MIT, C++, 14.5k commits)
- BRouter: github.com/abrensch/brouter (MIT, Java, 1.6k commits)
- GraphHopper: github.com/graphhopper/graphhopper (Apache 2.0, Java, 7k commits)
- OSRM: github.com/Project-OSRM/osrm-backend (BSD-2, C++, 8.8k commits)
- OpenTripPlanner: github.com/opentripplanner/OpenTripPlanner (LGPL, Java, 31.7k commits)
- pgRouting: pgrouting.org (GPL-2.0, C, PostgreSQL extension)

### Safety Standards
- CROW Design Manual for Bicycle Traffic (Netherlands)
- Vejregler / Vejdirektoratet (Denmark)
- ERA — Empfehlungen fur Radverkehrsanlagen (Germany)
- LTN 1/20 Cycle Infrastructure Design (UK)
- Vision Zero (Sweden)
- Level of Traffic Stress: Peter Furth, Northeastern University

### Data Sources
- SupaplexOSM Cycling Quality Index: github.com/SupaplexOSM/OSM-Cycling-Quality-Index
- SimRa (TU Berlin): github.com/simra-project/dataset
- OpenBikeSensor: github.com/openbikesensor
- Mapillary: mapillary.com/developer
- Copenhagen Bicycle Account: kk.dk/cykelregnskab
- CycleOSMData: pypi.org/project/cycleosmdata
