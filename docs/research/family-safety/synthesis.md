# Cross-city Synthesis

Cross-city findings from the April 2026 research pass. 15 cities studied: Amsterdam, Barcelona, Berlin, Bogotá, Copenhagen, London, Mexico City, Montreal, New York City, Paris, Potsdam, San Francisco, Seville, Taipei, Tokyo.

## Three dimensions that must be scored separately

The biggest insight from comparing cities is that **a single "bike-friendliness" number hides the real structure**. Three dimensions move independently:

1. **Per-segment quality** — how good is a good bike street here?
2. **Network continuity** — can you actually get places on the low-stress network, or is it islands?
3. **Local protection standard** — what does "protected" mean here? Plastic posts? Curbs? Full cycle tracks? Flood walls? Zone 30 shared streets?

SF has decent per-segment but terrible continuity. Amsterdam has excellent everything. Seville has continuous topology but aging per-segment quality. Tokyo has no per-segment separation at all but paradoxically high continuity via speed suppression. **The product must score all three or it will mis-rank cities against each other.**

## Archetype table

| City | Per-segment | Network continuity | "Protected" means | Mode share | Archetype |
|---|---|---|---|---|---|
| **Amsterdam** | Excellent | Connected | Grade-separated fietspad/fietsstraat (volumes engineered down) | ~35% | **Amsterdam** |
| **Copenhagen** | Excellent | Connected | Curb-separated track | ~28% | **Copenhagen** |
| **Paris** | Good, uneven | Mostly connected on axes | Concrete curb on REV; bollards elsewhere | ~5% | **Copenhagen-hybrid trending up** |
| **Seville** | OK, aging | **Connected topology** | Sidewalk-grade separator | ~6% | **Copenhagen-topology, Berlin-quality** |
| **London** | Good where built | Patchy + Waltham Forest pocket | Kerb-segregated on new Cycleways | ~4% | **Berlin-leaning hybrid** |
| **Berlin** | OK-to-good | Gaps | Curb or Fahrradstraße; paint ≠ protected | ~18% | **Berlin** |
| **Potsdam** | Good outside Altstadt; cobble penalty inside | Patchy, parks substitute for network | Same as Berlin; plastic posts absent | ~20% | **Berlin-variant** (geography, not policy, is the edge) |
| **Montreal** | Good on REV | Growing | Concrete curb, *plowed* | ~3% | **Berlin-hybrid trending Copenhagen on REV** |
| **Barcelona** | OK-to-good, bimodal | Patchy + superilla islands | Curb on Eixample axes; volume suppression in superilles | ~3% | **SF with superilla twist** |
| **NYC** | OK, variable | Islands + greenways | Parking-protected paint | ~1.3% | **SF with better greenway spine** |
| **San Francisco** | Bimodal | Spotty | Plastic posts | ~2.5% | **SF** |
| **Mexico City** | OK in core | Patchy (radial) | Bollards/armadillos; enforcement-dependent | ~2% | **Bogotá-in-periphery, Berlin-in-core** |
| **Bogotá** | Wildly variable | Sunday ≠ Monday | Varies, often sidewalk stripe | ~5% | **Split personality** |
| **Tokyo** | n/a (no separation) | Paradoxically connected | *Slowness*: Zone 30 + narrow streets + legal sidewalk refuge | ~14% | **Tokyo** (new archetype: slow-everything) |
| **Taipei** | Bimodal | Riverside trunk + hostile capillaries | Flood-wall separation + paint on-street | ~4% | **Recreational trunk + hostile capillaries** |

## Seven archetypes the data supports

1. **Amsterdam** — optimize for bike congestion, not cars (new failure mode: crowding + tourist scooters)
2. **Copenhagen** — curb-separated connected network, designed for 8-year-olds
3. **Berlin** — protected infra exists but network has gaps; surface penalties matter (cobblestones)
4. **SF** — hero corridors, spotty network, "protected" = plastic posts
5. **Bogotá split** — Sunday open-streets vs. hostile weekday (time-of-week is routing dimension)
6. **Tokyo slow-everything** — no separation, relies on speed suppression + legal sidewalk refuge + high mode share + e-assist mamachari
7. **Taipei trunk-and-capillary** — car-free recreational backbone behind physical barrier (floodgates as transfer nodes)

## Surprising findings worth preserving

- **Paris leapfrogged Amsterdam for child-friendly mobility** in a 2025 European ranking — driven by school streets (*rue aux écoles*) + blanket 30 km/h, not by bike-lane quality. Attacking speed/volume beats building lanes.
- **London retired its "Quietway" brand** because parents stopped trusting it. Only city in the set that publicly killed a family-branded tier. Signal for us: brand labels alone don't earn trust; evidence does.
- **NYC DOT's 2025 "family-friendly bike routes"** are all under 2 miles and park-internal — a de facto admission the connected network isn't there for kids.
- **Amsterdam's #1 parent complaint is bike *congestion*, not cars.** A city can solve cars and then have a different problem.
- **Tokyo is paradoxically connected without separation.** Sub-6m residential streets + Zone 30 + legal sidewalk refuge + mamachari-expecting drivers gives you an emergent low-stress network. E-assist is the enabling technology; without it the system collapses into "walk the kids."
- **Taipei's flood wall is the most important piece of bike infrastructure in the city** — the car-free riverside network exists accidentally as a monsoon defense. Routing for families becomes a floodgate-selection problem.
- **Montreal winter-plows bike lanes before many car lanes.** Jan-Feb counts on key routes rose 159% between 2015–2017 after the REV was built. Winter plowing *is* the protection standard — a lane not plowed is treated as removed.
- **Seville's 2006–2011 "build the network all at once" story** produced a topologically continuous network at ~€0.27M/km — but the 2024 €8M repair budget is essentially a second build. The legend understates maintenance debt.
- **Bogotá has a quantified Sunday ≠ Monday split**: 51% of Ciclovía users feel safe from traffic vs. far fewer on CicloRutas; flat-tire help rate is 73% on Sunday vs. 28% on weekdays. Families aren't irrational for treating them as two different cities.
- **Mexico City: enforcement reliability beats hardware tier.** Parents trust plastic curbs on Reforma more than bollards on Insurgentes, because the Insurgentes lane is routinely invaded by taxis. A "clear-lane reliability" multiplier may matter more than hardware.
- **Barcelona builds the low-stress network backwards**: superilla interiors first (low-stress islands), arterial connectors later. Excellent *destinations*, weak *through-routes*.

## Routing-model requirements uncovered

1. **Intersection scoring as weakest-link** (LTS canonical)
2. **Floodgates as transfer nodes** (Taipei)
3. **Time-of-week aware edges** (Bogotá Ciclovía, Paris rue aux écoles, Sunday Muévete en Bici)
4. **AQI as optional cost layer** (Mexico City Contingencia Ambiental; also future: Delhi, Jakarta)
5. **Winter-plowed flag** (Montreal; applies to any northern city)
6. **Enforcement-reliability multiplier per corridor** (Mexico City; hardest to capture automatically)
7. **"Protected" is per-city calibrated**, not a global tag — Copenhagen curb ≠ SF plastic post
8. **Surface penalties matter** (Berlin sett/cobblestone; Seville aging asphalt)

## The three-layer architecture

**Layer 1 — Global baseline**
LTS 1–4 from `(maxspeed, volume proxy, cycleway=*, bicycle_road=yes, surface)`, weakest-link intersection scoring, gradient penalty. Defensible against every standard in [`standards.md`](./standards.md).

**Layer 2 — Per-city profile**
Small YAML overlay tuning the baseline. Six fields: archetype, mode_share (→ SiN multiplier), protected_definition (accept/reject tag lists), vocabulary (boost/demote tags), named_overrides, network_continuity_index. Optional extra_dimensions for city-specific factors (AQI, winter_plowed, time_of_week). See [`city-profiles/README.md`](./city-profiles/README.md).

**Layer 3 — Family customization (future)**
Runtime sliders: kid age → stamina cap + gradient tolerance, cobble tolerance, detour willingness, trust level for plastic-post protection, time-of-week awareness, AQI ceiling.

## Repeatable per-city recipe

**Auto step (zero human time):**
- Mode share from Eurostat / ACS / city open data
- From OSM: `bicycle_road=yes` share, `cycleway=track` share, `maxspeed` distribution, `surface=sett` share, `highway=living_street` share
- Network continuity index: largest connected component of LTS-1/2 edges as % of residential edges

**LLM step (~15 min compute):** Run the templated research prompt in [`city-profiles/README.md`](./city-profiles/README.md). Produces `city_profile.yaml` with sources. Human review ~10 minutes → commit.

Bootstrap set: the 14 cities in this folder. Any new city inherits from its nearest archetype until its own profile lands.
