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
import { buildSegments } from '../utils/classify'
import type { OsmWay, Route, RouteSegment } from '../utils/types'
import type { ClassificationRule } from './rules'

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

/** Canonical node ID from a coordinate pair. */
function coordId(lat: number, lng: number): string {
  return `${lat.toFixed(6)},${lng.toFixed(6)}`
}

// ── Cost multipliers ───────────────────────────────────────────────────────

const COST_PREFERRED = 1.0
const COST_OTHER_CLASSIFIED = 3.0
const COST_WALKING = 5.0
const COST_UNCLASSIFIED = 8.0

// Average speeds (m/s) for time estimation
const CYCLING_SPEED_MS = 15 / 3.6  // ~15 km/h family pace
const WALKING_SPEED_MS = 5 / 3.6   // ~5 km/h walking

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
 * Build an ngraph from OsmWay arrays with cost based on classification.
 */
export function buildRoutingGraph(
  ways: OsmWay[],
  profileKey: string,
  preferredItemNames: Set<string>,
  regionRules?: ClassificationRule[],
): Graph<NodeData, EdgeData> {
  const graph = createGraph<NodeData, EdgeData>()

  for (const way of ways) {
    const coords = way.coordinates
    if (coords.length < 2) continue

    const tags = way.tags
    const walking = isWalkingOnly(tags)
    const itemName = classifyOsmTagsToItem(tags, profileKey, regionRules)

    // Determine cost multiplier
    let multiplier: number
    if (walking) {
      multiplier = COST_WALKING
    } else if (itemName && preferredItemNames.has(itemName)) {
      multiplier = COST_PREFERRED
    } else if (itemName) {
      multiplier = COST_OTHER_CLASSIFIED
    } else {
      multiplier = COST_UNCLASSIFIED
    }

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
      const cost = dist * multiplier
      const edgeData: EdgeData = { distance: dist, cost, wayTags: tags, isWalking: walking }

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
 * Find the graph node nearest to a given lat/lng by iterating all nodes.
 * Returns the node ID or null if the graph is empty.
 */
function findNearestNode(
  graph: Graph<NodeData, EdgeData>,
  lat: number,
  lng: number,
): string | null {
  let bestId: string | null = null
  let bestDist = Infinity

  graph.forEachNode((node: Node<NodeData>) => {
    const d = haversineM(lat, lng, node.data.lat, node.data.lng)
    if (d < bestDist) {
      bestDist = d
      bestId = node.id as string
    }
  })

  return bestId
}

// ── Route on graph ─────────────────────────────────────────────────────────

export interface ClientRouteResult {
  coordinates: [number, number][]
  segments: RouteSegment[]
  distanceKm: number
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

  const pathFinder = aStar(graph, {
    oriented: true,
    distance(_from: Node<NodeData>, _to: Node<NodeData>, link) {
      return link.data.cost
    },
    heuristic(from: Node<NodeData>, to: Node<NodeData>) {
      return haversineM(from.data.lat, from.data.lng, to.data.lat, to.data.lng)
    },
  })

  const path = pathFinder.find(startId, endId)
  if (!path || path.length === 0) return null

  // ngraph.path returns nodes from END to START — reverse
  const nodes = [...path].reverse()

  const coordinates: [number, number][] = nodes.map((n) => [n.data.lat, n.data.lng])

  // Build segments by walking the path edges
  let totalDistance = 0
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
      const speed = link.data.isWalking ? WALKING_SPEED_MS : CYCLING_SPEED_MS
      totalTime += link.data.distance / speed

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

  // Build segments (group consecutive same-classification points)
  const segmentInput = classified.map((c) => ({
    itemName: c.itemName,
    coord: c.coord,
  }))
  const segments = buildSegments(segmentInput)

  // Mark walking segments
  let classifiedIdx = 0
  for (const seg of segments) {
    // Check if any of the classified points in this segment are walking
    let hasWalking = false
    for (let j = 0; j < seg.coordinates.length && classifiedIdx < classified.length; j++) {
      if (classified[classifiedIdx]?.isWalking) hasWalking = true
      classifiedIdx++
    }
    if (hasWalking) seg.isWalking = true
  }

  return {
    coordinates,
    segments,
    distanceKm: totalDistance / 1000,
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
 * Pre-fetch all tiles covering Berlin (bbox: 52.34-52.68 lat, 13.08-13.76 lng).
 * Fetches in batches of 2 (respecting Overpass rate limits).
 */
export async function prefetchBerlinTiles(
  onProgress?: (pct: number) => void,
): Promise<OsmWay[]> {
  const TILE_DEGREES = 0.1
  const minRow = Math.floor(52.34 / TILE_DEGREES)
  const maxRow = Math.floor(52.68 / TILE_DEGREES)
  const minCol = Math.floor(13.08 / TILE_DEGREES)
  const maxCol = Math.floor(13.76 / TILE_DEGREES)

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

  const graph = buildRoutingGraph(allWays, profileKey, preferredItemNames, regionRules)
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
