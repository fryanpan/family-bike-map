# Routing Benchmark Results — 2026-04-11

## Setup
- **Mode:** Toddler (5-10 km/h biking, 4 km/h walking)
- **City:** Berlin
- **Engines:** Client-side (ngraph.path A* on Overpass data), Valhalla (use_roads=0.0), BRouter (safety profile)
- **Test routes:** 16 pairs (Home + School → 8 destinations)
- **Scoring:** Preferred % = fraction of route distance on preferred infrastructure (Fahrradstrasse, bike path, shared foot path, elevated sidewalk path, living street)

## Summary

| Engine | Routes found | Avg preferred % |
|--------|:-----------:|:---------------:|
| **Client** | 16/16 | **54%** |
| Valhalla | 15/16 | 35% |
| BRouter (safety) | 16/16 | 39% |

**Client router achieves 54% average preferred infrastructure — 19 percentage points better than Valhalla (35%) and 15pp better than BRouter (39%).**

## Head-to-Head: Client vs Valhalla

| Route | Client preferred | Valhalla preferred | Diff |
|-------|:---:|:---:|:---:|
| Home → Berlin Zoo | 77% | 65% | ✅ +13pp |
| Home → Hamburger Bahnhof | 53% | 18% | ✅ +35pp |
| Home → Alexanderplatz | 56% | 27% | ✅ +29pp |
| Home → Fischerinsel Swimming | 50% | 15% | ✅ +35pp |
| Home → Humboldt Forum | 42% | 2% | ✅ +40pp |
| Home → Nonne und Zwerg | 55% | 53% | ➖ +2pp |
| Home → Stadtbad Neukölln | 77% | 49% | ✅ +27pp |
| Home → Garten der Welt | 84% | 73% | ✅ +10pp |
| School → Berlin Zoo | 54% | 13% | ✅ +41pp |
| School → Hamburger Bahnhof | 41% | 14% | ✅ +27pp |
| School → Alexanderplatz | 23% | 40% | ❌ -17pp |
| School → Fischerinsel Swimming | 13% | 20% | ❌ -7pp |
| School → Humboldt Forum | 13% | 15% | ➖ -2pp |
| School → Nonne und Zwerg | 79% | n/a | ✅ (Valhalla failed) |
| School → Stadtbad Neukölln | 71% | 46% | ✅ +26pp |
| School → Garten der Welt | 76% | 79% | ➖ -3pp |

**Client wins 10, ties 3, loses 2 out of 15 head-to-head comparisons.**

## Key Observations

### Why Client Router Wins
1. **Routes through Fahrradstrassen** that Valhalla ignores (e.g., Mariannenstrasse)
2. **Uses park paths and canal paths** that Valhalla treats as equivalent to roads
3. **Speed-based costing** naturally prefers safe infrastructure without arbitrary multipliers

### Why Client Router Occasionally Loses
1. **Short routes** (School → Alexanderplatz, 2.3km) — the graph may have connectivity gaps near the school, forcing suboptimal paths
2. **Graph topology issues** — coordinate snapping at 6 decimal places may miss some connections

### Distance Trade-off
Client routes average **10-30% longer** in distance but with much higher preferred %. This is acceptable — the user explicitly accepts 75% longer routes for safety.

### Walking Segments
All routes show 0% walking — the 4 km/h walking speed makes short walk gaps "cheap" in the time-based cost model, so they don't register as separate walking segments. This needs refinement to properly track walk vs bike segments.

## Architecture Notes
- **Graph size:** ~150K nodes, ~350K edges (Berlin, all cycling+pedestrian+road infrastructure)
- **Graph build time:** ~500ms
- **Route computation:** ~10-100ms per route (A* with haversine heuristic)
- **Data source:** Same Overpass tiles as the map overlay (30-day Cloudflare edge cache)
