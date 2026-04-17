/**
 * Client-side routing engine using ngraph.path A* on Overpass tile data.
 *
 * Builds a graph from cached OsmWay arrays (fetched via Overpass tiles),
 * classifies edges by the user's preferred path types, and routes using
 * cost-weighted A* with haversine heuristic.
 */

import createGraph from 'ngraph.graph'
import { aStar } from 'ngraph.path'
import type { Graph, Node } from 'ngraph.graph'
import {
  getCachedTile,
  fetchBikeInfraForTile,
  latLngToTile,
  tileKey,
  classifyOsmTagsToItem,
} from './overpass'
import { buildSegments, healSegmentGaps } from '../utils/classify'
import { classifyEdge } from '../utils/lts'
import { MODE_RULES, applyModeRule } from '../data/modes'
import type { RideMode } from '../data/modes'
import type { OsmWay, Route, RouteSegment } from '../utils/types'
import type { ClassificationRule } from './rules'
import { applyRegionOverlay } from '../data/cityProfiles/overlay'
import type { RegionProfile } from '../data/cityProfiles/overlay'

// ── Haversine ──────────────────────────────────────────────────────────────

const R_EARTH = 6_371_000 // metres

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/** Haversine distance in metres between two lat/lng points. */
export function haversineM(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ── Graph types ────────────────────────────────────────────────────────────

interface NodeData {
  lat: number
  lng: number
}

interface EdgeData {
  distance: number  // metres
  cost: number      // weighted cost for A*
  wayTags: Record<string, string>
  isWalking: boolean
}

/** Canonical node ID from a coordinate pair.
 * Uses 5 decimal places (~1.1m precision) to snap nearby endpoints together,
 * improving graph connectivity near intersections where OSM ways don't share
 * exact coordinates at 6dp. */
function coordId(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`
}

// ── Speed-based costing via mode rules ────────────────────────────────────
//
// Edge cost = time to traverse (distance / speed). Speed is resolved from
// the mode rule in src/data/modes.ts, which combines Layer 1 LTS
// classification with the rider's mode-specific acceptance bands.
//
// The old per-item-name speed table (KID_ITEM_SPEEDS) has been replaced.
// Speed selection is now:
//   1. Layer 1 classifies the edge (LTS tier, carFree flag, surface, etc.)
//   2. Mode rule decides accept/reject + base speed via applyModeRule
//   3. If the user has toggled the corresponding legend item off, speed
//      drops to the mode's slowSpeedKmh (light user-level override —
//      doesn't reject, just nudges).
//
// Bridge-walking is a core innovation: any edge a mode does NOT want to
// ride on — either because the LTS is too high for that rider, the
// surface is rejected (e.g. cobbles for training), or it's a
// pedestrian-only footway — still enters the graph at walkingSpeedKmh
// with isWalking=true. The rider "dismounts and walks the bike on the
// sidewalk" across the bad segment. Speed-based cost (cost = dist/speed)
// makes these edges very expensive per meter so the router only uses
// them for short unavoidable gaps, but crucially they keep the graph
// connected. Without this, a kid-confident trip across Berlin fails
// the moment it needs to cross a Hauptstraße.
//
// Exception: motorway/trunk-class highways. These legally prohibit foot
// traffic and often have no sidewalk — you genuinely can't walk them.
// These stay hard-rejected.

function resolveRule(profileKey: string) {
  return MODE_RULES[profileKey as RideMode] ?? MODE_RULES['kid-starting-out']
}

// ── Graph builder ──────────────────────────────────────────────────────────

/**
 * Determine if a way represents a walking-only segment (no bicycle access).
 * These segments are still added to the graph at walking cost so the router
 * can use them as a last resort to connect disconnected cycling infrastructure.
 */
function isWalkingOnly(tags: Record<string, string>): boolean {
  const hw = tags.highway ?? ''
  if (hw === 'steps') return true
  if (hw === 'footway' || hw === 'pedestrian') {
    const bicycle = tags.bicycle ?? ''
    if (bicycle === 'yes' || bicycle === 'designated') return false
    return true
  }
  return false
}

/**
 * Whether an edge rejected by the mode rule can still be used as a
 * bridge-walk fallback (dismount and walk the bike on the sidewalk).
 *
 * A bad road is only walkable if there's somewhere to put your feet.
 *
 * Hard-reject:
 *   - Motorway / trunk class: legally forbidden to pedestrians.
 *   - Explicit `foot=no` / `access=no|private` / construction / raceway.
 *   - Motor-traffic road classes where `sidewalk=no|none` (or both sides
 *     explicitly `no`). Untagged sidewalk defaults to "present" because
 *     that's the urban norm and OSM convention is to tag `sidewalk=no`
 *     explicitly when absent.
 *
 * Self-walkable (no sidewalk needed — you walk on the way itself):
 *   cycleway, path, track, footway, pedestrian, steps, living_street,
 *   bridleway, service.
 */
function isBridgeWalkable(tags: Record<string, string>): boolean {
  const hw = tags.highway ?? ''

  // Hard-reject pedestrian-hostile road classes and explicit bans.
  if (hw === 'motorway' || hw === 'motorway_link') return false
  if (hw === 'trunk' || hw === 'trunk_link') return false
  if (hw === 'raceway' || hw === 'construction' || hw === 'proposed') return false
  if (tags.foot === 'no') return false
  if (tags.access === 'no' || tags.access === 'private') return false

  // Ways you walk on directly — no separate sidewalk needed.
  if (
    hw === 'cycleway' || hw === 'path' || hw === 'track' ||
    hw === 'footway' || hw === 'pedestrian' || hw === 'steps' ||
    hw === 'living_street' || hw === 'bridleway' || hw === 'service'
  ) return true

  // Motor-traffic road classes: require a sidewalk tag that isn't "no".
  const sidewalk      = tags.sidewalk          ?? ''
  const sidewalkBoth  = tags['sidewalk:both']  ?? ''
  const sidewalkLeft  = tags['sidewalk:left']  ?? ''
  const sidewalkRight = tags['sidewalk:right'] ?? ''
  const explicitlyNone =
    sidewalk === 'no' || sidewalk === 'none' ||
    sidewalkBoth === 'no' ||
    (sidewalkLeft === 'no' && sidewalkRight === 'no')
  if (explicitlyNone) return false

  return true
}

/**
 * Build an ngraph from OsmWay arrays with cost based on mode rules.
 *
 * Edge acceptance is determined by the Layer 1.5 mode rule from
 * src/data/modes.ts. Edges the mode rule rejects are not added to the
 * graph at all — they're simply unavailable to the router. This replaces
 * the old "add every edge with a high cost" approach and its per-item
 * speed overrides.
 *
 * preferredItemNames is consumed as a light user preference nudge: items
 * the user has toggled off get the slower `slowSpeedKmh` rather than
 * `ridingSpeedKmh`. The mode rule still has final say on accept/reject.
 */
export function buildRoutingGraph(
  ways: OsmWay[],
  profileKey: string,
  preferredItemNames: Set<string>,
  regionRules?: ClassificationRule[],
  regionProfile?: RegionProfile | null,
): Graph<NodeData, EdgeData> {
  const graph = createGraph<NodeData, EdgeData>()
  const rule = resolveRule(profileKey)

  for (const way of ways) {
    const coords = way.coordinates
    if (coords.length < 2) continue

    const tags = way.tags
    const walkingOnly = isWalkingOnly(tags)

    // Walking-only ways (footway without bicycle=yes, stairs) bypass the
    // mode rule and enter the graph as bridge-walk edges. The router will
    // only use them when no cycling alternative exists because they're
    // much slower than riding.
    let speedKmh: number
    let isWalking: boolean
    if (walkingOnly) {
      speedKmh = rule.walkingSpeedKmh
      isWalking = true
    } else {
      // Classify the edge using Layer 1 (LTS + carFree + bikeInfra + speed
      // + traffic density + surface), then ask the mode rule whether it's
      // accepted and at what speed. Layer 2 region overlay runs between
      // classifyEdge and applyModeRule — it adjusts the classification
      // based on named corridors / zone overrides specific to the current
      // city (see src/data/cityProfiles/overlay.ts).
      const rawClassification = classifyEdge(tags)
      const midpoint = coords[Math.floor(coords.length / 2)]
      const classification = applyRegionOverlay(
        rawClassification,
        tags,
        regionProfile ?? null,
        midpoint?.[0],
        midpoint?.[1],
      )
      const decision = applyModeRule(rule, classification)
      if (decision.accepted) {
        speedKmh = decision.speedKmh
        isWalking = decision.isWalking
      } else if (isBridgeWalkable(tags)) {
        // Mode rule rejected this edge (too stressful, bad surface, …)
        // but it's still walkable on the sidewalk. Add as a bridge-walk
        // edge at walkingSpeedKmh. The router will only pick it for
        // short unavoidable gaps because walking cost dominates.
        speedKmh = rule.walkingSpeedKmh
        isWalking = true
      } else {
        // Motorway / trunk / explicit no-foot — genuinely unusable.
        continue
      }
    }

    // Light user-preference nudge: if the user has toggled off the legend
    // item for this way, drop to slowSpeedKmh (but still include the edge —
    // user overrides are soft, not hard filters).
    const itemName = classifyOsmTagsToItem(tags, profileKey, regionRules)
    if (!isWalking && itemName && !preferredItemNames.has(itemName)) {
      speedKmh = Math.min(speedKmh, rule.slowSpeedKmh)
    }

    const speed = speedKmh / 3.6  // km/h → m/s

    // Check one-way constraints
    const oneway = tags.oneway === 'yes' || tags['oneway:bicycle'] === 'yes'
    const bicycleOverride = tags['oneway:bicycle'] === 'no'
    const isOneway = oneway && !bicycleOverride

    for (let i = 0; i < coords.length - 1; i++) {
      const [lat1, lng1] = coords[i]
      const [lat2, lng2] = coords[i + 1]
      const id1 = coordId(lat1, lng1)
      const id2 = coordId(lat2, lng2)

      // Ensure nodes exist
      if (!graph.getNode(id1)) graph.addNode(id1, { lat: lat1, lng: lng1 })
      if (!graph.getNode(id2)) graph.addNode(id2, { lat: lat2, lng: lng2 })

      const dist = haversineM(lat1, lng1, lat2, lng2)
      const cost = dist / speed  // cost = time in seconds
      const edgeData: EdgeData = { distance: dist, cost, wayTags: tags, isWalking }

      // Forward edge (always)
      graph.addLink(id1, id2, edgeData)

      // Reverse edge (unless one-way)
      if (!isOneway) {
        graph.addLink(id2, id1, { ...edgeData })
      }
    }
  }

  return graph
}

// ── Nearest node finder ────────────────────────────────────────────────────

/**
 * Find the graph node nearest to a given lat/lng that has at least one link.
 * Skips isolated nodes (degree 0) which can't participate in routing.
 * Falls back to any nearest node if no connected nodes exist.
 */
function findNearestNode(
  graph: Graph<NodeData, EdgeData>,
  lat: number,
  lng: number,
): string | null {
  let bestId: string | null = null
  let bestDist = Infinity
  let fallbackId: string | null = null
  let fallbackDist = Infinity

  graph.forEachNode((node: Node<NodeData>) => {
    const d = haversineM(lat, lng, node.data.lat, node.data.lng)

    // ngraph stores links as a linked list on node.links; null means no links
    const links = graph.getLinks(node.id)
    const connected = links !== null

    if (connected) {
      if (d < bestDist) {
        bestDist = d
        bestId = node.id as string
      }
    } else {
      if (d < fallbackDist) {
        fallbackDist = d
        fallbackId = node.id as string
      }
    }
  })

  return bestId ?? fallbackId
}

// ── Route on graph ─────────────────────────────────────────────────────────

export interface ClientRouteResult {
  coordinates: [number, number][]
  segments: RouteSegment[]
  distanceKm: number
  walkingDistanceKm: number
  walkingPct: number
  durationS: number
  graphNodes: number
  graphEdges: number
}

/**
 * Run A* on a pre-built graph from start to end coordinates.
 * Returns null if no path exists.
 */
export function routeOnGraph(
  graph: Graph<NodeData, EdgeData>,
  startLat: number,
  startLng: number,
  endLat: number,
  endLng: number,
  profileKey: string,
  preferredItemNames: Set<string>,
  regionRules?: ClassificationRule[],
): ClientRouteResult | null {
  const startId = findNearestNode(graph, startLat, startLng)
  const endId = findNearestNode(graph, endLat, endLng)
  if (!startId || !endId) return null

  const rule = resolveRule(profileKey)
  const maxSpeedMs = rule.ridingSpeedKmh / 3.6  // optimistic lower-bound for A*

  const pathFinder = aStar(graph, {
    oriented: true,
    distance(_from: Node<NodeData>, _to: Node<NodeData>, link) {
      return link.data.cost
    },
    heuristic(from: Node<NodeData>, to: Node<NodeData>) {
      // Heuristic must be in same units as cost (time in seconds).
      // Use the mode's top riding speed as the optimistic lower bound —
      // A* correctness requires the heuristic to never overestimate.
      const dist = haversineM(from.data.lat, from.data.lng, to.data.lat, to.data.lng)
      return dist / maxSpeedMs
    },
  })

  const path = pathFinder.find(startId, endId)
  if (!path || path.length === 0) return null

  // ngraph.path returns nodes from END to START — reverse
  const nodes = [...path].reverse()

  const coordinates: [number, number][] = nodes.map((n) => [n.data.lat, n.data.lng])

  // Build segments by walking the path edges
  let totalDistance = 0
  let walkingDistance = 0
  let totalTime = 0
  const classified: Array<{ itemName: string | null; coord: [number, number]; isWalking?: boolean }> = []

  for (let i = 0; i < nodes.length; i++) {
    if (i === 0) {
      classified.push({ itemName: null, coord: [nodes[0].data.lat, nodes[0].data.lng] })
      continue
    }

    const prevNode = nodes[i - 1]
    const currNode = nodes[i]
    const link = graph.getLink(prevNode.id, currNode.id)
    if (link) {
      totalDistance += link.data.distance
      totalTime += link.data.cost  // cost IS time in seconds
      if (link.data.isWalking) walkingDistance += link.data.distance

      const itemName = classifyOsmTagsToItem(link.data.wayTags, profileKey, regionRules)
      classified.push({
        itemName,
        coord: [currNode.data.lat, currNode.data.lng],
        isWalking: link.data.isWalking,
      })
    } else {
      classified.push({ itemName: null, coord: [currNode.data.lat, currNode.data.lng] })
    }
  }

  // Build walking-aware segments: walking edges get a special itemName marker
  // so buildSegments groups them separately, then we restore the real itemName.
  const WALK_MARKER = '__walking__'
  const segmentInput = classified.map((c) => ({
    itemName: c.isWalking ? WALK_MARKER : c.itemName,
    coord: c.coord,
  }))
  const rawSegments = buildSegments(segmentInput)

  // Post-process: restore real itemName, set isWalking flag, heal intersection gaps
  const restoredSegments: RouteSegment[] = rawSegments.map((seg) => {
    if (seg.itemName === WALK_MARKER) {
      return { ...seg, itemName: null, isWalking: true }
    }
    return seg
  })
  const segments = healSegmentGaps(restoredSegments, preferredItemNames)

  return {
    coordinates,
    segments,
    distanceKm: totalDistance / 1000,
    walkingDistanceKm: walkingDistance / 1000,
    walkingPct: totalDistance > 0 ? walkingDistance / totalDistance : 0,
    durationS: totalTime,
    graphNodes: graph.getNodeCount(),
    graphEdges: graph.getLinkCount(),
  }
}

// ── Tile helpers ───────────────────────────────────────────────────────────

/**
 * Get all tiles covering a bounding box defined by two points plus a buffer.
 */
function getTilesForCorridor(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
  bufferDeg = 0.05,
): Array<{ row: number; col: number }> {
  const south = Math.min(lat1, lat2) - bufferDeg
  const north = Math.max(lat1, lat2) + bufferDeg
  const west = Math.min(lng1, lng2) - bufferDeg
  const east = Math.max(lng1, lng2) + bufferDeg

  const TILE_DEGREES = 0.1
  const minRow = Math.floor(south / TILE_DEGREES)
  const maxRow = Math.floor(north / TILE_DEGREES)
  const minCol = Math.floor(west / TILE_DEGREES)
  const maxCol = Math.floor(east / TILE_DEGREES)

  const tiles: Array<{ row: number; col: number }> = []
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      tiles.push({ row: r, col: c })
    }
  }
  return tiles
}

// ── Prefetch Berlin tiles ──────────────────────────────────────────────────

/**
 * Pre-fetch all tiles covering a bounding box.
 * Fetches in batches of 2 (respecting Overpass rate limits).
 */
export async function prefetchTiles(
  bbox: { south: number; west: number; north: number; east: number },
  onProgress?: (pct: number) => void,
): Promise<OsmWay[]> {
  const TILE_DEGREES = 0.1
  const minRow = Math.floor(bbox.south / TILE_DEGREES)
  const maxRow = Math.floor(bbox.north / TILE_DEGREES)
  const minCol = Math.floor(bbox.west / TILE_DEGREES)
  const maxCol = Math.floor(bbox.east / TILE_DEGREES)

  const tiles: Array<{ row: number; col: number }> = []
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      tiles.push({ row: r, col: c })
    }
  }

  const allWays: OsmWay[] = []
  let done = 0

  // Fetch in batches of 2
  for (let i = 0; i < tiles.length; i += 2) {
    const batch = tiles.slice(i, i + 2)
    const results = await Promise.all(
      batch.map((t) => fetchBikeInfraForTile(t.row, t.col)),
    )
    for (const ways of results) {
      allWays.push(...ways)
    }
    done += batch.length
    onProgress?.(Math.round((done / tiles.length) * 100))
  }

  return allWays
}

// ── High-level routing function ────────────────────────────────────────────

/**
 * Client-side route using cached Overpass tile data.
 * Returns a Route object compatible with the app's existing type,
 * or null if no path can be found (caller should fall back to Valhalla).
 */
export async function clientRoute(
  startLat: number,
  startLng: number,
  endLat: number,
  endLng: number,
  profileKey: string,
  preferredItemNames: Set<string>,
  regionRules?: ClassificationRule[],
  regionProfile?: RegionProfile | null,
): Promise<Route | null> {
  // Collect ways from cached tiles covering the corridor
  const tiles = getTilesForCorridor(startLat, startLng, endLat, endLng)
  const allWays: OsmWay[] = []

  for (const t of tiles) {
    // Try cache first, then fetch
    let ways = getCachedTile(t.row, t.col)
    if (!ways) {
      try {
        ways = await fetchBikeInfraForTile(t.row, t.col)
      } catch {
        continue // skip failed tiles
      }
    }
    allWays.push(...ways)
  }

  if (allWays.length === 0) return null

  const graph = buildRoutingGraph(allWays, profileKey, preferredItemNames, regionRules, regionProfile)
  const result = routeOnGraph(
    graph, startLat, startLng, endLat, endLng,
    profileKey, preferredItemNames, regionRules,
  )

  if (!result) return null

  return {
    coordinates: result.coordinates,
    maneuvers: [],
    summary: {
      distance: result.distanceKm,
      duration: result.durationS,
    },
    segments: result.segments,
    engine: 'client',
  }
}
