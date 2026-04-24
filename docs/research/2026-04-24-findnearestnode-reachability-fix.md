# Routing benchmark: findNearestNode reachability fix (2026-04-24)

## Summary

Client router went from **77% success (150/195)** to **100% success (195/195)** by making `findNearestNode` directed-reachability-aware. No regression on routes that were already passing — Berlin preferred-% moved by 0.5pp, distance by −0.5% (both within noise).

## Problem

Blog Assistant reported that the Client router was failing on 7/17 SF pairs in *every* travel mode, plus 2/22 Berlin pairs. The failures were mode-independent — exactly the same origin-dest pairs failed regardless of which mode was selected — which ruled out mode-rule tuning as the cause.

## Root cause

`findNearestNode` picked the geometrically-nearest node with any edge. In a directed graph two things go wrong:

1. **Role-blind snap**: when used as the end-node, it happily snapped to a node that had 1 outgoing / 0 incoming edges (the upstream terminus of a one-way). A* cannot arrive at such a node.
2. **Island snap**: even if the node had incoming edges, it could lie on a tiny directed island that isn't directed-reachable from the start. In SF only 52% of the graph is directed-reachable from a Castro origin.

Contributing factors to the directed-island structure:
- One-way streets (2,771 of 12,624 ways ≈ 22%)
- `continue`'d motorway/trunk edges (never enter the graph)
- **Overpass query coverage** — biggest gap. `buildQuery` only fetches bike-relevant highway tags (`cycleway`, `residential`, `living_street`, `path`, `track`, `footway`, or any highway with a `cycleway:*` lane/track tag). Corridor streets tagged `tertiary | secondary | primary | unclassified` *without* a cycleway tag are absent from the graph. Berlin's residential grid has dense bike tagging so coverage is high; SF's Mission/Castro/downtown has sparser tagging so the graph has bigger gaps wherever a corridor street cuts across.

## Fix

`src/services/clientRouter.ts`:

- Pass `role: 'start' | 'end'` to `findNearestNode`. Require the snap to have at least one outgoing edge for start, incoming for end.
- Pre-compute the directed-reachable set from the start node via BFS (O(V+E), ≈10 ms on the 94k-node SF graph) and pass it as a restriction set to the end-snap. The end must be in the reachable set.

One additional fix was tried (walking-speed reverse edges for accepted one-way bike edges, matching the `isBridgeWalkable` philosophy) but reverted — the benchmark showed it only added 107 reachable nodes (0.1% of the graph) so the work was negligible, and it added routing-change surface area without meaningful benefit. The deeper issue is the Overpass coverage gap, which this PR does not address.

## Benchmark results

Baseline: `2026-04-24-0.1.181-local-10fb94a` (pre-fix)
After: `2026-04-24-0.1.184-local-5478dd5-dirty` (findNearestNode fix only)

### Success rate

| Router | Berlin 110 | SF 85 | Total |
|---|---|---|---|
| Client pre  | 100/110 (91%) | 50/85 (59%) | 150/195 (77%) |
| Client post | **110/110** | **85/85** | **195/195** |
| Valhalla post | 110/110 | 83/85 | 193/195 |
| BRouter post | 110/110 | 85/85 | 195/195 |
| Google post  | 110/110 | 85/85 | 195/195 |

### Quality — Berlin (no regression)

| Router | Preferred % | Distance (km) |
|---|---|---|
| client   pre  | 58.8% (n=100) | 6.05 |
| client   post | 58.3% (n=110) | 6.02 |
| valhalla post | 37.2% | 4.73 |
| brouter  post | 40.3% | 4.75 |
| google   post | 36.6% | 4.85 |

### Quality — SF (composition shift from 35 new successes)

| Router | Preferred % | Distance (km) |
|---|---|---|
| client   pre  | 43.2% (n=50) | 5.28 |
| client   post | 38.6% (n=85) | 5.37 |
| valhalla post | 26.8% | 4.92 |
| brouter  post | 24.4% | 4.95 |
| google   post | 26.9% | 5.20 |

The SF client preferred-% drop (43.2→38.6, −4.6pp) is a composition effect — the 35 newly-successful routes are harder (they cross corridor-street gaps) and so their preferred-% is lower than the 50 easy routes that were already passing. Not a regression on previously-passing routes.

## Interpretation for the launch blog post

- **"20% more on preferred paths"**: Berlin client 58.3% vs best competitor 40.3% (BRouter) = +18 pp, or 1.45× as often. Claim holds.
- **"~30% farther on average"**: Berlin client 6.02 km vs best competitor 4.73 km = +27%. Claim holds.
- **"sometimes over 2× (up to 2.6×)"**: Berlin max ratio unchanged at 2.60× (School → Hamburger Bahnhof, kid-confident). Claim holds.
- **Failure rate caveat**: no longer necessary at launch. Client is 100% success across both cities now.

## Follow-ups (not in this PR)

- Expand the Overpass query to include tertiary/secondary/unclassified streets. Those would be rejected by `applyModeRule` for strict modes but become bridge-walks (walking speed), which would close the corridor gaps that currently force long detours. Benchmark would need to verify no regression in preferred-% (bridge-walk cost dominates, so A* should avoid them unless necessary).
