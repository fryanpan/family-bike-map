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
  getCachedSignals,
  fetchBikeInfraForTile,
  latLngToTile,
  tileKey,
  classifyOsmTagsToItem,
} from './overpass'
import { buildSegments, healSegmentGaps, getLegendItem } from '../utils/classify'
import { classifyEdge } from '../utils/lts'
import { MODE_RULES, applyModeRule, getEffectiveModeRule } from '../data/modes'
import { loadSettings } from './adminSettings'
import type { AdminSettings } from './adminSettings'
import type { RideMode } from '../data/modes'
import type { OsmWay, Route, RouteSegment } from '../utils/types'
import type { ClassificationRule } from './rules'
import { applyRegionOverlay } from '../data/cityProfiles/overlay'
import type { RegionProfile } from '../data/cityProfiles/overlay'
import { applyPreferenceAdjustments } from '../data/preferences'
import type { RiderPreference } from '../data/preferences'

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
  wayId: number     // OSM way id — used by tap-to-avoid to identify the source way
  isWalking: boolean
}

// Highway tier ranking — higher number = bigger road, used by the
// unsignalized-major-road penalty (Joanna 2026-04-29, #4) to detect
// junctions where a bike must cross a primary/trunk artery.
const HIGHWAY_TIER: Record<string, number> = {
  motorway: 7, trunk: 6, primary: 5, secondary: 4, tertiary: 3,
  unclassified: 2, residential: 1,
}
function highwayTier(highway: string): number {
  return HIGHWAY_TIER[highway] ?? 0
}
// Speed default by class (mirrors the inline fallback in classifyEdge).
function speedDefaultForHighway(highway: string): number | null {
  switch (highway) {
    case 'living_street': return 15
    case 'residential': return 30
    case 'unclassified': return 30
    case 'tertiary': return 50
    case 'secondary': return 50
    case 'primary': return 60
    case 'trunk': return 80
    default: return null
  }
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

function resolveRule(profileKey: string, settings?: AdminSettings) {
  const mode = (MODE_RULES[profileKey as RideMode] ? profileKey : 'kid-starting-out') as RideMode
  const s = settings ?? loadSettings()
  return getEffectiveModeRule(mode, s)
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
  avoidedWayIds?: Set<number> | null,
  riderPreference?: RiderPreference | null,
  settings?: AdminSettings,
  signalCoords?: [number, number][] | null,
): Graph<NodeData, EdgeData> {
  const graph = createGraph<NodeData, EdgeData>()
  const rule = resolveRule(profileKey, settings)

  // ── Pre-pass: per-node info for unsignalized-major-road penalty (Joanna #4)
  //
  // For each node (keyed by coordId so it matches what the main pass will
  // create), compute:
  //   - degree: number of incident way-segments (coords that share this id
  //     across any way). Counts every adjacent way-coord, not unique ways,
  //     because what matters for "is this an intersection?" is the count
  //     of incoming/outgoing edges in the routing graph.
  //   - hasTrafficSignals: true if a signal node lies at the same coordId.
  //   - worstIncidentClass: the heaviest highway tier among incident ways.
  //   - worstIncidentSpeed: max speed (read or class-default) at incident
  //     ways of that worst class.
  //   - allBikeOnly: true if every incident way is cycleway/path/footway.
  //
  // The penalty fires only on edges that ENTER a node where:
  //   degree > 2 AND hasTrafficSignals === false AND
  //   worstIncidentClass ∈ {primary, trunk} AND worstIncidentSpeed ≥ 50
  //   AND not allBikeOnly.
  interface NodeInfo {
    degree: number
    hasTrafficSignals: boolean
    worstClass: string  // highway tier name
    worstTier: number   // numeric tier rank
    worstSpeed: number  // km/h
    allBikeOnly: boolean
  }
  const BIKE_ONLY = new Set(['cycleway', 'path', 'footway', 'pedestrian'])
  const nodeInfo = new Map<string, NodeInfo>()

  function getOrInit(id: string): NodeInfo {
    let info = nodeInfo.get(id)
    if (!info) {
      info = { degree: 0, hasTrafficSignals: false, worstClass: '', worstTier: -1, worstSpeed: 0, allBikeOnly: true }
      nodeInfo.set(id, info)
    }
    return info
  }

  // Mark signal-bearing coord keys.
  if (signalCoords && signalCoords.length) {
    for (const [lat, lng] of signalCoords) {
      const id = coordId(lat, lng)
      const info = getOrInit(id)
      info.hasTrafficSignals = true
    }
  }

  // Walk all ways to populate per-node degree + worstIncidentClass.
  // Skipped ways (avoidedWayIds, < 2 coords) match the main-pass skip list
  // so the pre-pass and main pass agree on what's in the graph.
  for (const way of ways) {
    const coords = way.coordinates
    if (coords.length < 2) continue
    if (avoidedWayIds && avoidedWayIds.has(way.osmId)) continue

    const hw = way.tags.highway ?? ''
    const tier = highwayTier(hw)
    const isBikeOnly = BIKE_ONLY.has(hw) || (hw === 'footway' && (way.tags.bicycle === 'yes' || way.tags.bicycle === 'designated'))
    const maxspeed = parseInt(way.tags.maxspeed ?? '0', 10)
    const speed = maxspeed > 0 ? maxspeed : (speedDefaultForHighway(hw) ?? 0)

    for (let i = 0; i < coords.length; i++) {
      const [lat, lng] = coords[i]
      const id = coordId(lat, lng)
      const info = getOrInit(id)
      // Degree increment: each coord that's part of a segment edge counts
      // once per side it touches. End-of-way coords get +1, middle coords
      // sit on two adjacent segments so they get +2.
      if (i === 0 || i === coords.length - 1) info.degree += 1
      else info.degree += 2

      if (!isBikeOnly) info.allBikeOnly = false
      if (tier > info.worstTier) {
        info.worstTier = tier
        info.worstClass = hw
        info.worstSpeed = speed
      } else if (tier === info.worstTier && speed > info.worstSpeed) {
        info.worstSpeed = speed
      }
    }
  }

  // Decision helper: should an edge ENTERING `j` carry the unsignalized
  // penalty? Used by the main pass.
  const PRIMARY_TIER = highwayTier('primary')
  const TRUNK_TIER = highwayTier('trunk')
  function entryPenalty(jId: string): { addS: number; mul: number } {
    const info = nodeInfo.get(jId)
    if (!info) return { addS: 0, mul: 1 }
    if (info.degree <= 2) return { addS: 0, mul: 1 }
    if (info.allBikeOnly) return { addS: 0, mul: 1 }
    if (info.hasTrafficSignals) return { addS: 0, mul: 1 }
    // Only the headline case: crossed road is primary or trunk at ≥ 50 km/h.
    // Other tiers (signalized +8s, unsignalized-tertiary +25s) are deferred
    // per the joanna.md spec.
    if (info.worstTier !== PRIMARY_TIER && info.worstTier !== TRUNK_TIER) return { addS: 0, mul: 1 }
    if (info.worstSpeed < 50) return { addS: 0, mul: 1 }
    return { addS: 50, mul: 2 }
  }

  for (const way of ways) {
    const coords = way.coordinates
    if (coords.length < 2) continue
    // User-requested avoid list — the edge isn't added to the graph at
    // all (not even as a bridge-walk). Used for in-route "reroute around
    // this segment" requests.
    if (avoidedWayIds && avoidedWayIds.has(way.osmId)) continue

    const tags = way.tags
    const walkingOnly = isWalkingOnly(tags)

    // Walking-only ways (footway without bicycle=yes, stairs) bypass the
    // mode rule and enter the graph as bridge-walk edges. The router will
    // only use them when no cycling alternative exists because they're
    // much slower than riding.
    let speedKmh: number
    let isWalking: boolean
    let costMultiplier = 1.0
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
      // Layer 2: region overlay (city-specific corridor + zone rules).
      const regionAdjusted = applyRegionOverlay(
        rawClassification,
        tags,
        regionProfile ?? null,
        midpoint?.[0],
        midpoint?.[1],
      )
      // Layer 3: rider preference (per-rider taste within a mode).
      // Runs before applyModeRule so "cobbles are fine" flips surface
      // BEFORE the mode rule decides whether to ride or walk.
      const classification = applyPreferenceAdjustments(regionAdjusted, riderPreference ?? null)
      const itemNameEarly = classifyOsmTagsToItem(tags, profileKey, regionRules)
      const decision = applyModeRule(rule, classification, itemNameEarly)
      if (decision.accepted) {
        speedKmh = decision.speedKmh
        isWalking = decision.isWalking
        costMultiplier = decision.costMultiplier
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
      // Cost = time-at-effective-speed × level-cost-multiplier.
      // Multiplier biases the router away from accepted-but-worse infra
      // (e.g. LTS 2b for traffic-savvy at 1.5×, LTS 3 for carrying-kid at
      // 2×, rough surfaces at 5×) even when the base speed is unchanged.
      const baseCost = (dist / speed) * costMultiplier
      const edgeData: EdgeData = { distance: dist, cost: baseCost, wayTags: tags, wayId: way.osmId, isWalking }

      // Per-direction unsignalized-major-road penalty (Joanna #4): the
      // penalty fires on the *entering* side of a junction. Forward edge
      // enters id2, reverse edge enters id1 — query each separately.
      //
      // Walking edges skip the penalty: bridge-walks cross arterials at
      // the crosswalk on foot, where the unsignalized stress is much
      // lower than riding through (Furth's framework is about cycling
      // stress, not pedestrian stress). Without this carve-out, kid-modes
      // that bridge-walk through every primary intersection see the
      // penalty stack up on every node — kid-starting-out's preferred-%
      // collapsed from 56% → 17% in the first benchmark run because the
      // router avoided bridge-walks entirely and detoured onto walking
      // routes through quiet residential, leaving less preferred infra
      // available within the cost budget.
      const fwdPenalty = isWalking ? { addS: 0, mul: 1 } : entryPenalty(id2)
      const fwdCost = baseCost * fwdPenalty.mul + fwdPenalty.addS

      // Forward edge (always)
      graph.addLink(id1, id2, { ...edgeData, cost: fwdCost })

      // Reverse edge (unless one-way)
      if (!isOneway) {
        const revPenalty = isWalking ? { addS: 0, mul: 1 } : entryPenalty(id1)
        const revCost = baseCost * revPenalty.mul + revPenalty.addS
        graph.addLink(id2, id1, { ...edgeData, cost: revCost })
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
/**
 * Max distance (m) the nearest-node snap will accept before giving up.
 * If the closest valid node is farther than this from the requested
 * point, the caller is treated as "off the graph" and routing returns
 * null. Calibrated from the 2026-04-24 benchmark: the hardest successful
 * snap was ~486 m (SF Apple Store in kid-starting-out), so 1 km is a
 * safe 2× margin. The disconnected-graph test case in
 * `tests/clientRouter.test.ts` relies on this threshold producing null
 * rather than a long-distance snap onto an isolated cluster.
 */
const MAX_SNAP_M = 1000

function findNearestNode(
  graph: Graph<NodeData, EdgeData>,
  lat: number,
  lng: number,
  role: 'start' | 'end',
  allowedSet?: Set<string>,
): string | null {
  // A start node must have at least one OUTGOING edge (so A* can leave it).
  // An end node must have at least one INCOMING edge (so A* can reach it).
  // Without this check, `findNearestNode` happily snaps to the upstream
  // terminus of a one-way street — 1 outgoing, 0 incoming — and A*
  // returns null even though a perfectly good node a block away has
  // incoming edges. This bit us for ~25% of SF samples in the 10fb94a
  // benchmark (see docs/process/learnings.md).
  //
  // `allowedSet` optionally restricts the snap to a pre-computed set
  // (e.g. the directed-reachable set from the start). Used for the
  // end-node snap to avoid landing on a directed island that A* can't
  // reach even though the node has incoming edges.
  let bestId: string | null = null
  let bestDist = Infinity
  let fallbackId: string | null = null  // any node with ANY edge — last resort
  let fallbackDist = Infinity

  graph.forEachNode((node: Node<NodeData>) => {
    const d = haversineM(lat, lng, node.data.lat, node.data.lng)

    const links = graph.getLinks(node.id)
    if (links === null) return  // isolated node, skip entirely

    let hasRoleEdge = false
    let hasAnyEdge = false
    for (const link of links) {
      hasAnyEdge = true
      if (role === 'start' ? link.fromId === node.id : link.toId === node.id) {
        hasRoleEdge = true
        break
      }
    }

    const inAllowed = !allowedSet || allowedSet.has(node.id as string)

    if (hasRoleEdge && inAllowed && d < bestDist) {
      bestDist = d
      bestId = node.id as string
    } else if (hasAnyEdge && d < fallbackDist) {
      fallbackDist = d
      fallbackId = node.id as string
    }
  })

  // Cap the snap distance. Without this the role+allowedSet check can
  // snap to a node 10+ km away (in a disconnected-graph edge case); the
  // caller almost certainly wants "no route" in that case, not a route
  // that starts/ends nowhere near the requested point.
  if (bestId !== null && bestDist > MAX_SNAP_M) return null
  if (bestId === null && fallbackDist > MAX_SNAP_M) return null
  return bestId ?? fallbackId
}

/**
 * Forward BFS from `startId` following only outgoing edges, returning the
 * set of node IDs reachable via some directed path. O(V + E).
 *
 * We pre-compute this when routing so the end-node snap can be restricted
 * to a node A* can actually reach — the SF graph has ~47% of nodes in
 * directed islands that look fine locally (have incoming edges) but are
 * unreachable from the Castro origin.
 */
function computeReachableSet(
  graph: Graph<NodeData, EdgeData>,
  startId: string,
): Set<string> {
  const reachable = new Set<string>([startId])
  const queue: string[] = [startId]
  while (queue.length) {
    const id = queue.pop()!
    const links = graph.getLinks(id)
    if (!links) continue
    for (const link of links) {
      if (link.fromId === id && !reachable.has(link.toId as string)) {
        reachable.add(link.toId as string)
        queue.push(link.toId as string)
      }
    }
  }
  return reachable
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
  const startId = findNearestNode(graph, startLat, startLng, 'start')
  if (!startId) return null
  // Restrict end-node snap to the start's directed-reachable set so we
  // don't snap onto a disconnected island (cheap BFS, O(V + E)).
  const reachable = computeReachableSet(graph, startId)
  const endId = findNearestNode(graph, endLat, endLng, 'end', reachable)
  if (!endId) return null

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
  interface ClassifiedPoint {
    itemName: string | null
    coord: [number, number]
    isWalking?: boolean
    wayId?: number  // null on the first point (no inbound edge)
  }
  const classified: ClassifiedPoint[] = []

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
        wayId: link.data.wayId,
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

  // Post-process: restore real itemName, set isWalking flag, heal gaps,
  // attach wayIds per segment (for tap-to-avoid). wayIds are derived by
  // keying each coord lat,lng and accumulating every wayId that
  // traverses it — handles routes that revisit a node (loops / spurs).
  const wayIdsByCoord = new Map<string, Set<number>>()
  for (const cp of classified) {
    if (cp.wayId == null) continue
    const k = `${cp.coord[0]},${cp.coord[1]}`
    let set = wayIdsByCoord.get(k)
    if (!set) { set = new Set(); wayIdsByCoord.set(k, set) }
    set.add(cp.wayId)
  }
  const restoredSegments: RouteSegment[] = rawSegments.map((seg) => {
    const base: RouteSegment = seg.itemName === WALK_MARKER
      ? { ...seg, itemName: null, isWalking: true }
      : seg
    const wayIds = new Set<number>()
    for (const coord of seg.coordinates) {
      const k = `${coord[0]},${coord[1]}`
      const found = wayIdsByCoord.get(k)
      if (found) for (const id of found) wayIds.add(id)
    }
    // pathLevel — derive directly from the legend item for this segment's
    // itemName. The legend (PROFILE_LEGEND) is the source of truth for
    // display tiers. Previously we read this from a per-coord cache, but
    // buildSegments uses the prior segment's last coord as the bridge for
    // visual continuity — so every segment after the first inherited the
    // previous segment's pathLevel. Living streets (1b green) rendered
    // pink (2b) because the preceding Quiet street segment's pathLevel
    // leaked through. (Bryan's launch-blocking 2026-04-28 colors-don't-
    // match-after-mode-switch report; root-cause found 2026-04-29.)
    const legendItem = seg.itemName ? getLegendItem(seg.itemName, profileKey) : undefined
    const pathLevel = legendItem?.level
    return { ...base, wayIds: [...wayIds], pathLevel }
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
  avoidedWayIds?: Set<number> | null,
  riderPreference?: RiderPreference | null,
  settings?: AdminSettings,
): Promise<Route | null> {
  // Collect ways from cached tiles covering the corridor
  const tiles = getTilesForCorridor(startLat, startLng, endLat, endLng)
  const allWays: OsmWay[] = []
  const allSignals: [number, number][] = []

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
    // Signals are populated alongside ways (same tile cache contract).
    // Tiles fetched before this code shipped will report undefined →
    // treat as no signals (penalty silently doesn't fire for that tile).
    const sigs = getCachedSignals(t.row, t.col)
    if (sigs) allSignals.push(...sigs)
  }

  if (allWays.length === 0) return null

  const graph = buildRoutingGraph(allWays, profileKey, preferredItemNames, regionRules, regionProfile, avoidedWayIds, riderPreference, settings, allSignals)
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
