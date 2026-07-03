// Way/node admission filter for the enrichment pipeline.
//
// ─────────────────────────────────────────────────────────────────────────────
// MUST MIRROR buildQuery() in src/services/overpass.ts EXACTLY.
// ─────────────────────────────────────────────────────────────────────────────
// The client fetches non-enriched tiles from Overpass using buildQuery(); the
// pipeline builds enriched tiles from a PBF using this predicate. If the two
// diverge, enriched and non-enriched regions silently get DIFFERENT graphs —
// different overlay coverage AND different routing connectivity (the graph is
// built from the same tile payload). Overpass QL is a query string so it can't
// be executed against local tags directly; this predicate is the line-by-line
// translation:
//
//   way["highway"="cycleway"]
//   way["bicycle_road"="yes"]
//   way["highway"="living_street"]
//   way["highway"~"^(residential|path|track)$"]["bicycle"!="no"]
//   way["highway"="footway"]["bicycle"~"^(yes|designated)$"]
//   way["highway"="pedestrian"]["bicycle"~"^(yes|designated)$"]
//   way[~"^cycleway(:right|:left|:both)?$"~"^(track|lane|opposite_track|opposite_lane|share_busway)$"]
//   node["highway"~"^(traffic_signals|stop)$"]
//
// tests/pipeline/filter.test.ts pins buildQuery()'s output verbatim — if
// buildQuery changes, that test fails and points you here to update the
// mirror (and vice versa).

/** Keys matched by Overpass regex ^cycleway(:right|:left|:both)?$ */
const CYCLEWAY_KEYS = ['cycleway', 'cycleway:right', 'cycleway:left', 'cycleway:both'] as const

/** Values matched by Overpass regex ^(track|lane|opposite_track|opposite_lane|share_busway)$ */
const CYCLEWAY_INFRA_VALUES = new Set([
  'track', 'lane', 'opposite_track', 'opposite_lane', 'share_busway',
])

/** highway values matched by ^(residential|path|track)$ (with bicycle != no). */
const QUIET_HIGHWAYS = new Set(['residential', 'path', 'track'])

/** bicycle values matched by ^(yes|designated)$ (footway/pedestrian admission). */
const BIKE_PERMITTED = new Set(['yes', 'designated'])

/**
 * Does this way belong in a tile payload? Mirrors the way sub-queries of
 * buildQuery() in src/services/overpass.ts (see file header comment).
 */
export function matchesOverpassWayFilter(tags: Record<string, string>): boolean {
  const highway = tags.highway
  if (highway === 'cycleway') return true
  if (tags.bicycle_road === 'yes') return true
  if (highway === 'living_street') return true
  // Overpass ["bicycle"!="no"] matches when the tag is absent OR any value != "no".
  if (highway !== undefined && QUIET_HIGHWAYS.has(highway) && tags.bicycle !== 'no') return true
  if ((highway === 'footway' || highway === 'pedestrian') && BIKE_PERMITTED.has(tags.bicycle ?? '')) return true
  for (const key of CYCLEWAY_KEYS) {
    const v = tags[key]
    if (v !== undefined && CYCLEWAY_INFRA_VALUES.has(v)) return true
  }
  return false
}

/**
 * Is this a traffic-control node the tile payload carries as a
 * single-coordinate pseudo-way? Mirrors buildQuery()'s
 * node["highway"~"^(traffic_signals|stop)$"] sub-query (and the node branch
 * of parseOverpassResponse in src/services/overpass.ts).
 */
export function matchesOverpassControlNodeFilter(tags: Record<string, string>): boolean {
  return tags.highway === 'traffic_signals' || tags.highway === 'stop'
}
