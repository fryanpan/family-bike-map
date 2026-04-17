# Routing Use Cases

## The family-cycling stress model

Every existing framework (LTS, NACTO AAA, CROW, ERA, LTN 1/20, Danish
Vejdirektoratet) models stress per-individual-rider. Family cycling is
a **group activity with asymmetric stress**: the parent carries both
their own rider stress AND a supervisory load that scales with the
kid's inability to self-regulate. This is the gap our kid modes fill.

### The three stress axes for a parent riding with a kid

1. **Own-bike-control stress** — same as any adult rider: steering,
   braking, balance, reading the road surface.
2. **Monitoring stress** — watching the kid: are they in the right
   part of the lane, are they about to swerve, are they approaching a
   hazard they haven't noticed? This is *dual-task cognitive load*:
   the parent is attending to their own ride AND the kid's, not one
   or the other.
3. **Response-delay stress** — when the parent has to command ("stop!"
   "stay right!" "car coming!"), there is a half-to-one-second lag
   before the kid actually acts. That lag is a safety margin the
   parent has to pay for out of their own planning budget — meaning
   the parent has to anticipate a full beat earlier than a solo adult
   would, on the same road.

The three compound. A road that is LTS 1 for a solo adult can still be
high-stress for a parent if it produces monitoring events too often.

### Decision frequency is the dominant stress variable

The real thing the kid modes are ordered by is **how often the parent
has to make a supervisory decision**:

- **kid-starting-out**: near-zero supervisory decisions in transit.
  A decision happens only at intersections — every few minutes at
  most. Between intersections the parent can relax and the kid can
  build confidence. This is why the mode insists on car-free or
  bike-priority surfaces: any moving-vehicle interaction forces a
  supervisory event, and at this ability level the kid can't be
  trusted to handle one correctly.

- **kid-confident**: infrequent car interactions are acceptable —
  roughly what the international manuals allow at LTS 1 (low
  thousands of vehicles/day on 30 km/h streets, meaning the kid sees
  a car every few minutes, not every few seconds). The supervisory
  command is typically a single "stay to the right" — easy, low
  stakes, and the parent has time to issue it and the kid has time
  to comply. This maps to the 2,000–2,500 veh/day threshold every
  framework converges on.

- **kid-traffic-savvy**: the kid now makes the split-second decisions
  themselves — painted bike lane on a tertiary street, watching for
  door-zone, handling a signalled intersection. The parent's
  supervisory load drops to occasional "I see a turning car ahead"
  because the kid is already scanning. This maps to LTS 2 with bike
  infrastructure and a speed cap.

- **carrying-kid**: the kid is a passenger. No supervisory dual-task
  at all — the adult is solo for decision-making purposes. The
  asymmetry flips to the *passenger's* comfort (surface smoothness),
  which the adult absorbs as a separate axis.

### What this means for the router

Routes don't just need to be safe — they need to produce the right
*rate* of supervisory events for the rider's ability. Two routes of
equal LTS can have very different stress profiles if one has ten
intersections and the other has one. We don't currently model this
explicitly, but it's the shape of the next layer (intersection
density as a cost input, not just edge LTS).

---

## UC0: Learning to Ride

**Who:** Parent + very young child (age 2-4) just learning to bike/scooter

**What:** Not routing — discovering safe spaces to practice. Wide open areas with no cars, no intersections, flat or slightly downhill. The parent walks or rides slowly beside the child while she explores and builds confidence.

**What makes a great learning spot:**
- Wide car-free spaces (park paths, closed roads, multi-use trails)
- Flat or gentle downhill
- No intersections with cars, or so little traffic it doesn't matter
- Enough width for a parent to walk beside while the child wobbles
- Smooth surface (asphalt preferred, packed dirt okay)

**Real examples that worked:**
- JFK Drive in Golden Gate Park, SF (car-free, wide, flat)
- Sanchez Street Slow Street, SF (minimal car traffic, gentle hill)
- Alameda multi-use path (linear car-free park path, flat, wide)
- Tempelhofer Feld, Berlin (former airport, completely flat and open)

**What the product should do:**
- "Show me safe places to practice biking near me"
- Highlight wide car-free paths and open spaces on the map
- Not routing — just discovery of suitable spaces

**This is the entry point for the product.** Before you need routes, you need places. A family that finds great learning-to-ride spots through the app will trust it for routing later.

---

## UC1: Family Mobility with Toddler

**Who:** Parent + child (age 4) on her own bike/scooter, ~5-10 km/h

**What:** Getting anywhere in the city — cafe, museum, school, park, friend's house, market, live music, swimming pool. The destination changes daily. The need is the same: a route Bea can ride safely and enjoyably.

**Route requirements:**
- Strongly prefer: Fahrradstrasse, car-free Radweg, park paths, elevated sidewalk paths, living streets
- Accept: walking on sidewalk for a few hundred meters to bridge gaps
- Avoid: any road with car traffic (even with painted bike lane), cobblestones, busy unsignalized intersections
- Detour tolerance: 75% longer is fine — safety over speed
- At 5-10 km/h, time barely matters

**What the product should do:**
- Find routes that are 90%+ on preferred infrastructure automatically
- Suggest short walk segments rather than routing through traffic
- The parent should trust the route without needing to manually edit it

**Why existing routing engines fail:**
- Valhalla treats painted bike lanes on busy roads as "bike infrastructure" — same as a Fahrradstrasse
- No engine can express "I won't put my kid on a painted lane next to 50 km/h traffic"
- The Fahrradstrasse one block over is the obviously correct choice, but routers don't see it

---

## UC2: Cargo Bike with Trailer

**Who:** Adult on cargo bike pulling child trailer, 20-25 km/h

**What:** Daycare drop-off/pick-up, grocery runs, weekend outings — practical family transport

**Route requirements:**
- Strongly prefer: wide smooth Radweg (≥2.5m), Fahrradstrasse, painted lanes on smooth moderate roads
- Accept: residential/local roads with low traffic, shared bus lanes
- Avoid: narrow elevated sidewalk paths (trailer doesn't fit), cobblestones (vibration), bollard barriers, sharp turns
- Detour tolerance: 30-40%

**Why existing routing engines fail:**
- No awareness of path width (OSM `width` tag)
- No awareness of bollard barriers that block trailers
- Can't distinguish wide smooth path from narrow bumpy one

---

## UC3: Road Training Ride

**Who:** Adult on road bike with narrow tires, 25-35 km/h, sustaining speed

**What:** Training ride — fitness, speed, enjoying the ride. Looking for smooth uninterrupted flow.

**Route requirements:**
- Strongly prefer: smooth asphalt roads ≤30 km/h, Fahrradstrasse, wide smooth Radweg where passing is possible
- Accept: roads with moderate traffic if smooth asphalt, painted lanes on smooth roads
- Avoid: tram tracks (catch narrow tires), narrow bike paths (can't pass slower riders), paving stones, shared foot paths (pedestrian conflicts at 30 km/h), living streets (too slow)
- Detour tolerance: 15-20% — directness matters

**Why existing routing engines fail:**
- Route onto bumpy elevated sidewalk paths that are miserable at speed
- No concept of "can I pass slower cyclists" (path width)
- No tram track avoidance (`railway=tram` in OSM)
- Treat all cycleways equally regardless of surface/width quality

---

## UC4: Discovery and Exploration

**Who:** Any mode, but especially family (UC1)

**What:** "Where can we bike that's nice?" Not always A→B. Sometimes: "show me a loop of good paths from here" or "what's reachable on safe infrastructure within 20 minutes?"

**Not yet built.** Requires understanding the preferred infrastructure network as a graph and computing reachability, not just point-to-point routing.

---

## UC5: Navigate and Adapt

**Who:** Any mode, actively on a ride

**What:** Following a route, encounter something unexpected — construction, scary intersection, surface worse than expected. Need to adapt in real time.

**Requirements:**
- "Reroute avoiding this segment" one-tap action
- Feedback on current segment quality (good/bad/mismatch)
- Real-time reroute from current GPS position
- Turn-by-turn with GPS auto-advance and distance-based speech
- Segment feedback feeds back into classification rules over time

---

## UC6: Evaluate and Improve Routing Quality

**Who:** Developer/admin

**What:** Systematically test routing quality across engines, travel modes, and route pairs. Track improvements over time.

**Requirements:**
- Saved test cases (origin/destination pairs from real usage)
- Run across all engines and travel modes
- Compare: distance, time, % preferred, LTS breakdown, worst segment
- Regression detection: alert when a change makes a known-good route worse

---

## The Routing Strategy

Existing routing engines (Valhalla, BRouter, GraphHopper) all model bike infrastructure as binary — has it or doesn't. Our use cases need a spectrum. The product should route on its own understanding of what's preferred, not on someone else's model.

**The preferred infrastructure graph** — built from our Overpass tile data and classification system — already exists. The green overlay on the map IS the answer. The routing engine should use it:

1. Route on the preferred graph first (client-side Dijkstra on cached Overpass data)
2. Fall back to Valhalla/BRouter only for connecting gaps where no preferred path exists
3. The user's preferences (PROFILE_LEGEND preferred/other) ARE the routing weights
4. As preferences evolve (Bea grows, user adjusts), routing automatically adapts
