# Turn-cost tuning — handoff notes (2026-06-12)

Bryan-approved follow-up to the edge-keyed A* (PR #200, shipped 2026-06-11).
Two real-route regressions reported by Bryan on the deployed build:

1. **kid-confident summits Buena Vista Park** (suboptimal — slope). Likely:
   stop-sign/signal costs every block on the flat Page St bike boulevard +
   Haight/Fell corridors exceed the hill's ascent cost; park paths have zero
   controls. Stop signs on a boulevard mostly face the CROSS street — the
   through rider rolls — but `edgeAStar.ts` charges full `stopSignWaitSec`
   every pass, no corridor-continuation reduction (signals got one, stops
   didn't).
2. **carrying-kid and training no longer route via JFK Promenade.** Verified
   NOT classification: 'Shared use path' is defaultPreferred for all 5 modes
   (classify.ts PROFILE_LEGEND) and JFK is surface=asphalt (fine for
   SMOOTH_ONLY). Likely: GGP is junction-dense (path fork ~every 100 m) and
   gentle bends ≥30° at those forks accumulate turn time + penalties, while
   Lincoln Way is one same-name corridor paying half signal waits. The 6-10
   benchmark (pre-turn-costs) had ~25% promenade usage in ALL modes.

## Agreed fix (one coherent change)

- Extend corridor-continuation to **stop signs**: same-name straight-through
  ≈ free (or heavily reduced); cross-street stop pays full.
- Don't charge turn time at park-path forks for slight (30–60°) deviations —
  only bill when the route deviates ≥60°. (Scope: maybe only for
  highway=path/cycleway/footway transitions, or drop the 30–60° class at
  junctions where both edges are car-free.)

## Process requirements

- **Reproduce both routes FIRST** (learnings: reproduce before fixing) via a
  diag script using production buildRoutingGraph/routeOnGraph on prod tiles
  (proxy `https://bike-map.fryanpan.com/api/overpass?row=…` — use synthetic
  cache-key rows like `row=diag-377` for custom queries, NEVER real row/col
  keys with non-standard queries — that poisoned prod once already).
  - Buena Vista case: kid-confident, Castro (37.7605,-122.4311) → Inner
    Sunset (~37.764,-122.469); assert route does not enter Buena Vista Park
    (bbox ~37.766–37.770, -122.444–-122.437) / check elevation gain.
  - JFK case: carrying-kid + training, Castro → Hook Fish Co
    (37.7624,-122.5069); assert promenade usage (highway=pedestrian named
    Kennedy) > ~15% of distance. Pattern for measuring: scripts/diag-jfk-route.ts.
- Full benchmark gate (`TILE_BUST=<fresh>` SF + Berlin, routes-found,
  preferred-%, avg-turns) + results doc + decisions entry, committed WITH the
  code. Baselines: docs/research/2026-06-11-routing-benchmark-results.md
  (SF: 29/39/49/44/41 preferred, 17/17; Berlin: 47/63/66/57/45, 22/22).
- Key files: src/services/edgeAStar.ts (transition fn), src/data/modes.ts
  (constants), tests/edgeAStar.test.ts. Cache version is worker v4 / IDB v4 —
  tuning constants do NOT change tile content → no cache bump needed.
- Ship loop: branch → PR → CI → `gh pr merge --squash --admin` → deploy auto
  → verify on prod → prewarm not needed (no query change).
- Also note: turn-cost knobs may need Joanna's Gleisdreieck→Mehringdamm
  check eventually; admin-override wiring for the new ModeRule fields is
  still unbuilt (noted 2026-06-11 decisions).
