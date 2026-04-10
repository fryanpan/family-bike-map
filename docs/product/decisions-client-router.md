# Client-Side Routing Engine — Design Decisions

## 2026-04-10: Speed-based cost model (not arbitrary multipliers)

**Decision:** Edge cost = time to traverse (distance / speed), not distance × arbitrary multiplier.

**Why:** The router is solving a multimodal problem — Bea bikes safe segments at 10 km/h and walks unsafe ones at 1.5 km/h. Using time as the cost naturally penalizes unsafe segments: walking 200m adds ~2 min, but walking 2km adds ~20 min. The router will find a bike detour rather than walk a long unsafe gap. No need for hand-tuned multipliers.

**Speeds per mode:**
- Toddler: preferred 10 km/h, cautious 5 km/h, walk 1.5 km/h
- Trailer: preferred 22 km/h, cautious 15 km/h, walk 4 km/h
- Training: preferred 30 km/h, cautious 20 km/h, walk 5 km/h (or bike unclassified at 10 km/h)

## 2026-04-10: Unsafe roads without sidewalks are excluded (toddler mode)

**Decision:** In toddler mode, primary/secondary/tertiary roads with no sidewalk tag are excluded entirely from the graph.

**Why:** If there's no sidewalk, there's no safe way for a toddler to traverse the segment — not even walking. The router should find an alternative even if it means a significant detour.

## 2026-04-10: Why client-side, not server-side

**Decision:** Route in the browser using cached Overpass tile data + ngraph.path A*.

**Why:**
1. Data already cached — the bike overlay tiles contain all roads/paths we need
2. Our classification system IS the cost function — `classifyOsmTagsToItem` already knows what's preferred
3. 30-60K node graph routes in ~10-30ms (proven by ngraph.path benchmarks on 5x larger graphs)
4. Zero server cost, zero rate limits, instant re-routing when preferences change
5. Works offline once tiles are cached

**Alternative considered:** Self-hosted BRouter with custom .brf profiles. Rejected because:
- Needs a $5/mo VM
- Profile language is unusual (Polish notation)
- Single maintainer (bus factor)
- Can't iterate as fast as modifying TypeScript

**Alternative considered:** Custom C++ Valhalla costing. Rejected because:
- Maintaining a Valhalla fork is significant ongoing work
- C++ compilation pipeline
- Valhalla fundamentally can't distinguish painted lane from separated track without source changes

## 2026-04-10: City-agnostic tile prefetch

**Decision:** `prefetchTiles(bbox)` accepts any bounding box, not hardcoded Berlin.

**Why:** The family travels. Berlin today, Copenhagen next month, visiting SF for holidays. The app should cache any city's cycling data on first visit.

## 2026-04-10: Graph built from Overpass overlay data (not separate fetch)

**Decision:** The routing graph is built from the same `OsmWay[]` data that powers the green/orange map overlay.

**Why:** Single source of truth. What the user sees on the map IS what the router routes on. If a segment is green on the overlay, the router prefers it. If it's not shown on the overlay, the router avoids it. This eliminates the "why didn't the router use that green path I can see?" problem.
