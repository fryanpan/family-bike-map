# Turn & Intersection Cost Design

**Goal:** (1) routes stop zig-zagging through 10-turn residential mazes when a 3-turn route is nearly as safe (Joanna's 2026-04-20 feedback), and (2) ETAs are *roughly right on average* — including the real-world time of crossing two legs of a signalized intersection and waiting out a long light.

## How the major engines do it

| Engine | Mechanism | Defaults / shape | ETA-affecting? |
|---|---|---|---|
| **OSRM** (bicycle.lua) | Per-turn duration computed at every junction transition: `duration = (angle/90)² × turn_penalty`, with `turn_bias` (1.4) making left turns cost more than right (right-hand traffic) | `turn_penalty = 6 s`, `traffic_signal_penalty = 2 s` | Yes — turn duration goes into the route time. The 2 s signal value is free-flow-optimistic, not an average wait |
| **Valhalla** | Edge **transition costs** at nodes; distinguishes *cost* (added to path cost AND elapsed time) from *penalty* (path-shaping only, NOT added to time). Signals/stop signs add stop impact | `maneuver_penalty = 5 s` (penalty — shapes simpler routes without inflating ETA) | Split by design — exactly the distinction we already have (`cost` vs `durationSec`) |
| **BRouter** | `turncost` assigned in node context, expressed in *meters of equivalent way length*, scaled by turn angle | Profiles use 0 (roundabouts, marked routes) to 60–90 m (junctions, main roads) | Indirectly (cost-meters) |

The composite lesson: **three separately-tunable components** — (a) the physical time a turn takes, (b) a path-shaping "cognitive" penalty that should NOT inflate the ETA, (c) expected waiting time at controlled intersections, which SHOULD inflate the ETA because it's real. OSRM's 2 s signal default is the cautionary tale for (c): it models rolling through a green, not the average experience.

## Our criteria

All three components key off the **junction transition**: the route passes from edge A to edge B at node N. Curves *within* a way (winding park path) cost nothing — only places where a navigating human needs to make a decision. A node is a junction iff ≥ 3 distinct ways meet there.

### 1. Turn maneuver time (real time → `cost` AND `durationSec`)

Slowing, shoulder check, re-accelerating. Angle between incoming and outgoing bearing:

| Turn angle | kid-starting-out / kid-confident | traffic-savvy / carrying-kid | training |
|---|---|---|---|
| < 30° (straight) | 0 s | 0 s | 0 s |
| 30–60° (slight) | 3 s | 2 s | 1 s |
| 60–120° (turn) | 6 s | 4 s | 3 s |
| > 120° (sharp/U) | 10 s | 8 s | 5 s |

(Kid modes ride slower, so re-acceleration costs less in absolute speed but more in coordination — calling adult+kid out at 1.5–2× OSRM's 6 s quadratic at 90° is consistent with its shape.)

### 2. Maneuver penalty (path-shaping only → `cost`, NOT `durationSec`)

The Valhalla pattern, sized for our problem: each junction turn ≥ 60° adds a flat penalty so A* prefers fewer-instruction routes even when the zig-zag is slightly "greener."

| | kid modes (starting-out/confident) | traffic-savvy / carrying-kid | training |
|---|---|---|---|
| Penalty per turn ≥ 60° | **12 s** | 8 s | 5 s |

Why 12 s for kid modes: at 10 km/h, 12 s ≈ 33 m of detour-equivalent — i.e. the router will trade up to ~33 m of extra riding to avoid one turn. Joanna's complaint says today that tradeoff is 0 m. Tuning target: her known-good routes (Gleisdreieck → Mehringdamm LPG) should match the suggestion; benchmark must report **avg turns/route** before/after, expecting a meaningful drop with < 3 pp preferred-% loss.

### 3. Intersection control time (real time → `cost` AND `durationSec`)

This is the "wait for a long light" component. Expected wait at uniform arrival is `red² / (2 × cycle)`. Urban cycles run 60–120 s; for a typical 90 s cycle with ~half red toward the crossing, the average is **~10–15 s for a straight/right crossing**. A left turn for family modes is a **two-stage (pedestrian-style) crossing**: cross leg one, wait for the next phase, cross leg two — two expected waits plus repositioning.

Data source: `node["highway"="traffic_signals"]` (plus `highway=stop`) added to the Overpass tile query — node-only output, cheap, and signal nodes sit *on* the way geometry so they snap to graph nodes by the existing 5-dp coordId.

| Transition at a signalized node | kid modes | traffic-savvy / carrying-kid | training |
|---|---|---|---|
| Straight or right | 15 s | 12 s | 10 s |
| Left (two-stage for family modes) | **45 s** | 30 s | 20 s (vehicular) |
| Stop sign (any direction) | 5 s | 4 s | 3 s |

These are averages by design — sometimes you roll through a green, sometimes you eat the full 90 s; Bryan's ask is that the *average* estimate is roughly right.

## Implementation phasing

The constraint: ngraph.path's A* is **node-keyed** — the distance callback can't see the incoming edge, so genuinely angle-dependent transition costs are impossible in it. The standard fix (what Valhalla and OSRM effectively do) is searching over **directed-edge states** instead of nodes. We don't need a materialized line graph — a custom A* whose labels are links (neighbors enumerated from the existing node adjacency) keeps memory ∝ edge count (SF 184k, Berlin 1.2M labels — fine).

- **Phase A — signals into ETA (no search change).** Fetch signal/stop nodes; add the *straight-crossing* control time onto edges leaving a signal node (node-located, direction-blind). Ships the ETA-realism half immediately with zero routing-architecture risk.
- **Phase B — edge-state A* (turn shaping).** Replace `aStar(graph, …)` with our own edge-keyed A*; apply components 1 + 2 by angle, and upgrade signal lefts vs straights (45 s vs 15 s). Full benchmark gate: routes-found, preferred-%, **new turns/route metric**, plus the Joanna route as a named regression case.

Caveat worth recording: turn-cost search on edge states is the *correct* formulation; doing it node-keyed (hacks like averaging turn cost into nodes) silently breaks optimality, which is why Phase A deliberately limits itself to direction-blind node costs.

## Tuning & evaluation

- All constants live in the mode rules (`ModeRule`) and are admin-settings overridable, like the existing speed/multiplier knobs.
- Benchmark additions: avg turns/route, avg signalized crossings/route, ETA delta vs current.
- Acceptance: turns/route drops materially for family modes; preferred-% within ~3 pp of baseline; Hancock→Hook Fish and Joanna's Gleisdreieck route eyeballed by Bryan before merge.

## Sources

- [OSRM bicycle.lua profile](https://github.com/Project-OSRM/osrm-backend/blob/master/profiles/bicycle.lua) — `turn_penalty = 6`, `turn_bias = 1.4`, `traffic_signal_penalty = 2`, quadratic angle formula
- [Valhalla dynamic costing docs](https://valhalla.github.io/valhalla/sif/dynamic-costing/) and [API reference](https://valhalla.github.io/valhalla/api/turn-by-turn/api-reference/) — transition costs, cost-vs-penalty distinction, `maneuver_penalty = 5 s`
- [BRouter cost functions](https://brouter.de/brouter/costfunctions.html) and [profile glossary](https://github.com/poutnikl/Brouter-profiles/wiki/Glossary) — node-context `turncost` in meters-equivalent; [profile examples](https://github.com/poutnikl/Brouter-profiles/issues/9) using 0–90
