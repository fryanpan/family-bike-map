#!/usr/bin/env bun
/**
 * Routing Benchmark Script
 *
 * Compares client-side router vs Valhalla vs BRouter (safety) for Berlin test routes.
 * Run: bun scripts/benchmark-routing.ts
 */

// ── Overpass tile fetching (same logic as the app) ───────────────────────

// Use our Cloudflare Worker proxy — it has 30-day cached tiles
const OVERPASS_URL = 'https://bike-map.fryanpan.com/api/overpass'
const TILE_DEGREES = 0.1

interface OsmWay {
  osmId: number
  coordinates: [number, number][]
  tags: Record<string, string>
  itemName: string | null
}

interface OverpassElement {
  type: string
  id: number
  tags?: Record<string, string>
  geometry?: Array<{ lat: number; lon: number }>
}

function buildOverpassQuery(bbox: { south: number; west: number; north: number; east: number }): string {
  const { south, west, north, east } = bbox
  const b = `${south},${west},${north},${east}`
  return `
[out:json][timeout:25];
(
  way["highway"="cycleway"](${b});
  way["bicycle_road"="yes"](${b});
  way["cycleway"="track"](${b});
  way["cycleway"="lane"](${b});
  way["cycleway"="opposite_track"](${b});
  way["cycleway"="opposite_lane"](${b});
  way["cycleway"="share_busway"](${b});
  way["highway"="living_street"](${b});
  way["highway"="residential"]["bicycle"!="no"](${b});
  way["highway"="path"]["bicycle"!="no"](${b});
  way["highway"="footway"]["bicycle"~"yes|designated"](${b});
  way["highway"="track"]["bicycle"!="no"](${b});
  way["highway"="tertiary"](${b});
  way["highway"="unclassified"](${b});
  way["highway"="service"]["service"!="parking_aisle"](${b});
  way["highway"="footway"](${b});
  way["highway"="pedestrian"](${b});
  way["highway"="secondary"](${b});
  way["highway"="primary"](${b});
  way["cycleway:right"="track"](${b});
  way["cycleway:left"="track"](${b});
  way["cycleway:both"="track"](${b});
  way["cycleway:right"="lane"](${b});
  way["cycleway:left"="lane"](${b});
  way["cycleway:both"="lane"](${b});
);
out geom;
`
}

const tileCache = new Map<string, OsmWay[]>()

async function fetchTile(row: number, col: number): Promise<OsmWay[]> {
  const key = `${row}:${col}`
  if (tileCache.has(key)) return tileCache.get(key)!

  const bbox = {
    south: row * TILE_DEGREES,
    north: (row + 1) * TILE_DEGREES,
    west: col * TILE_DEGREES,
    east: (col + 1) * TILE_DEGREES,
  }

  const query = buildOverpassQuery(bbox)

  let resp: Response | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    resp = await fetch(`${OVERPASS_URL}?row=${row}&col=${col}`, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    if (resp.ok) break
    console.warn(`[Overpass] Tile ${row}:${col} HTTP ${resp.status}, retry ${attempt + 1}`)
    await new Promise((r) => setTimeout(r, (attempt + 1) * 3000))
  }

  if (!resp || !resp.ok) {
    console.warn(`[Overpass] Tile ${row}:${col} FAILED after retries`)
    tileCache.set(key, [])
    return []
  }

  const data = await resp.json() as { elements: OverpassElement[] }
  const ways: OsmWay[] = data.elements
    .filter((el): el is OverpassElement & { geometry: NonNullable<OverpassElement['geometry']> } =>
      el.type === 'way' && el.geometry != null)
    .map((el) => ({
      osmId: el.id,
      coordinates: el.geometry.map((pt): [number, number] => [pt.lat, pt.lon]),
      tags: el.tags ?? {},
      itemName: null,
    }))

  tileCache.set(key, ways)
  return ways
}

async function fetchBerlinTiles(): Promise<OsmWay[]> {
  const south = 52.34, north = 52.68, west = 13.08, east = 13.76
  const minRow = Math.floor(south / TILE_DEGREES)
  const maxRow = Math.floor(north / TILE_DEGREES)
  const minCol = Math.floor(west / TILE_DEGREES)
  const maxCol = Math.floor(east / TILE_DEGREES)

  const tiles: Array<{ row: number; col: number }> = []
  for (let r = minRow; r <= maxRow; r++)
    for (let c = minCol; c <= maxCol; c++)
      tiles.push({ row: r, col: c })

  console.log(`Fetching ${tiles.length} tiles for Berlin...`)
  const allWays: OsmWay[] = []

  for (let i = 0; i < tiles.length; i += 2) {
    const batch = tiles.slice(i, i + 2)
    const results = await Promise.all(batch.map((t) => fetchTile(t.row, t.col)))
    for (const ways of results) allWays.push(...ways)
    process.stdout.write(`\r  ${Math.min(i + 2, tiles.length)}/${tiles.length} tiles`)
    if (i + 2 < tiles.length) await new Promise((r) => setTimeout(r, 500)) // Worker cache handles rate limits
  }
  console.log(`\n  Total: ${allWays.length} ways`)
  return allWays
}

// ── Classification (inline, matches the app's classifyOsmTagsToItem) ─────

const BAD_SURFACES = new Set([
  'cobblestone', 'sett', 'unhewn_cobblestone', 'cobblestone:flattened',
  'gravel', 'unpaved', 'dirt', 'earth', 'ground', 'mud', 'sand',
  'grass', 'fine_gravel', 'pebblestone', 'woodchips',
])

const BAD_SMOOTHNESS = new Set(['bad', 'very_bad', 'horrible', 'very_horrible', 'impassable'])

function classifyWay(tags: Record<string, string>, profileKey: string): string | null {
  if (BAD_SMOOTHNESS.has(tags.smoothness ?? '')) return 'Rough surface'

  const surface = tags.surface ?? ''
  if (profileKey === 'toddler') {
    if (BAD_SURFACES.has(surface)) return 'Rough surface'
  } else {
    if (BAD_SURFACES.has(surface) || surface === 'paving_stones') return 'Rough surface'
  }

  const hw = tags.highway ?? ''
  const cw = tags.cycleway ?? ''
  const cRight = tags['cycleway:right'] ?? ''
  const cLeft = tags['cycleway:left'] ?? ''
  const cBoth = tags['cycleway:both'] ?? ''

  if (tags.bicycle_road === 'yes') return 'Fahrradstrasse'
  if (hw === 'cycleway' || hw === 'path' || hw === 'track') return 'Bike path'
  if (hw === 'footway') return 'Shared foot path'

  if (cw === 'track' || cw === 'opposite_track' || cRight === 'track' || cLeft === 'track' || cBoth === 'track')
    return 'Elevated sidewalk path'

  if (cw === 'lane' || cw === 'opposite_lane' || cRight === 'lane' || cLeft === 'lane' || cBoth === 'lane')
    return 'Painted bike lane'

  if (cw === 'share_busway' || cRight === 'share_busway' || cLeft === 'share_busway' || cBoth === 'share_busway')
    return 'Shared bus lane'

  if (hw === 'living_street') return 'Living street'
  if (hw === 'residential' || hw === 'tertiary' || hw === 'unclassified' || hw === 'service')
    return 'Residential/local road'

  return null
}

// ── Toddler preferred items ──────────────────────────────────────────────

const TODDLER_PREFERRED = new Set([
  'Bike path', 'Fahrradstrasse', 'Shared foot path',
  'Elevated sidewalk path', 'Living street',
])

// ── Graph building + A* routing (same as clientRouter.ts) ────────────────

import createGraph from 'ngraph.graph'
import { aStar } from 'ngraph.path'
import type { Graph, Node } from 'ngraph.graph'

const R_EARTH = 6_371_000
function toRad(deg: number) { return deg * Math.PI / 180 }
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

interface NodeData { lat: number; lng: number }
interface EdgeData { distance: number; cost: number; tags: Record<string, string>; isWalking: boolean }

function coordId(lat: number, lng: number) { return `${lat.toFixed(6)},${lng.toFixed(6)}` }

const TODDLER_SPEEDS = {
  preferred: 10 / 3.6,
  otherClassified: 5 / 3.6,
  walking: 4 / 3.6,     // adult+toddler walking pace, not toddler alone
  unclassified: 4 / 3.6,
}

function isWalkingOnly(tags: Record<string, string>): boolean {
  const hw = tags.highway ?? ''
  if (hw === 'steps') return true
  if (hw === 'footway' || hw === 'pedestrian') {
    const b = tags.bicycle ?? ''
    return b !== 'yes' && b !== 'designated'
  }
  return false
}

function buildGraph(ways: OsmWay[]): Graph<NodeData, EdgeData> {
  const graph = createGraph<NodeData, EdgeData>()

  for (const way of ways) {
    const coords = way.coordinates
    if (coords.length < 2) continue
    const tags = way.tags
    const walking = isWalkingOnly(tags)
    const itemName = classifyWay(tags, 'toddler')

    let speed: number
    if (walking) {
      speed = TODDLER_SPEEDS.walking
    } else if (itemName && TODDLER_PREFERRED.has(itemName)) {
      speed = TODDLER_SPEEDS.preferred
    } else if (itemName) {
      speed = TODDLER_SPEEDS.otherClassified
    } else {
      const hw = tags.highway ?? ''
      const hasSidewalk = ['both', 'left', 'right', 'yes'].includes(tags.sidewalk ?? '')
      if (!hasSidewalk && ['primary', 'secondary', 'tertiary', 'trunk'].includes(hw)) continue
      speed = TODDLER_SPEEDS.unclassified
    }

    const oneway = tags.oneway === 'yes' && tags['oneway:bicycle'] !== 'no'

    for (let i = 0; i < coords.length - 1; i++) {
      const [lat1, lng1] = coords[i]
      const [lat2, lng2] = coords[i + 1]
      const id1 = coordId(lat1, lng1), id2 = coordId(lat2, lng2)
      if (!graph.getNode(id1)) graph.addNode(id1, { lat: lat1, lng: lng1 })
      if (!graph.getNode(id2)) graph.addNode(id2, { lat: lat2, lng: lng2 })
      const dist = haversineM(lat1, lng1, lat2, lng2)
      const cost = dist / speed
      const edge: EdgeData = { distance: dist, cost, tags, isWalking: walking }
      graph.addLink(id1, id2, edge)
      if (!oneway) graph.addLink(id2, id1, { ...edge })
    }
  }
  return graph
}

function findNearest(graph: Graph<NodeData, EdgeData>, lat: number, lng: number): string | null {
  let bestId: string | null = null, bestDist = Infinity
  graph.forEachNode((node: Node<NodeData>) => {
    const d = haversineM(lat, lng, node.data.lat, node.data.lng)
    if (d < bestDist) { bestDist = d; bestId = node.id as string }
  })
  return bestId
}

interface RouteResult {
  engine: string
  distance: number  // km
  duration: number  // min
  preferredPct: number
  walkingPct: number
  coordinates: [number, number][]
}

function clientRoute(graph: Graph<NodeData, EdgeData>, startLat: number, startLng: number, endLat: number, endLng: number): RouteResult | null {
  const startId = findNearest(graph, startLat, startLng)
  const endId = findNearest(graph, endLat, endLng)
  if (!startId || !endId) return null

  const pathFinder = aStar(graph, {
    oriented: true,
    distance: (_f: Node<NodeData>, _t: Node<NodeData>, link: any) => link.data.cost,
    heuristic: (from: Node<NodeData>, to: Node<NodeData>) =>
      haversineM(from.data.lat, from.data.lng, to.data.lat, to.data.lng) / TODDLER_SPEEDS.preferred,
  })

  const t0 = performance.now()
  const path = pathFinder.find(startId, endId)
  const routeTimeMs = performance.now() - t0

  if (!path || path.length === 0) return null

  const nodes = [...path].reverse()
  let totalDist = 0, totalTime = 0, preferredDist = 0, walkingDist = 0
  const coords: [number, number][] = [{ lat: nodes[0].data.lat, lng: nodes[0].data.lng } as any].map(n => [nodes[0].data.lat, nodes[0].data.lng])

  for (let i = 1; i < nodes.length; i++) {
    coords.push([nodes[i].data.lat, nodes[i].data.lng])
    const link = graph.getLink(nodes[i - 1].id, nodes[i].id)
    if (link) {
      totalDist += link.data.distance
      totalTime += link.data.cost
      const item = classifyWay(link.data.tags, 'toddler')
      if (item && TODDLER_PREFERRED.has(item)) preferredDist += link.data.distance
      if (link.data.isWalking) walkingDist += link.data.distance
    }
  }

  console.log(`    Client route: ${routeTimeMs.toFixed(0)}ms`)

  return {
    engine: 'client',
    distance: totalDist / 1000,
    duration: totalTime / 60,
    preferredPct: totalDist > 0 ? preferredDist / totalDist : 0,
    walkingPct: totalDist > 0 ? walkingDist / totalDist : 0,
    coordinates: coords,
  }
}

// ── Valhalla routing ─────────────────────────────────────────────────────

async function valhallaRoute(startLat: number, startLng: number, endLat: number, endLng: number, allWays: OsmWay[]): Promise<RouteResult | null> {
  const body = {
    locations: [
      { lat: startLat, lon: startLng },
      { lat: endLat, lon: endLng },
    ],
    costing: 'bicycle',
    costing_options: {
      bicycle: {
        bicycle_type: 'Hybrid',
        cycling_speed: 6,
        use_roads: 0.0,
        avoid_bad_surfaces: 0.5,
        use_hills: 0.1,
        use_ferry: 0.0,
        use_living_streets: 1.0,
      },
    },
    directions_options: { units: 'km', language: 'en-US' },
  }

  try {
    const resp = await fetch('https://valhalla1.openstreetmap.de/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) return null
    const data = await resp.json() as any
    const trip = data.trip
    const coords: [number, number][] = trip.legs.flatMap((leg: any) => {
      // Decode polyline6
      const encoded = leg.shape
      const points: [number, number][] = []
      let lat = 0, lng = 0, idx = 0
      while (idx < encoded.length) {
        let b, shift = 0, result = 0
        do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
        lat += ((result & 1) ? ~(result >> 1) : (result >> 1))
        shift = 0; result = 0
        do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
        lng += ((result & 1) ? ~(result >> 1) : (result >> 1))
        points.push([lat / 1e6, lng / 1e6])
      }
      return points
    })

    // Score using Overpass data
    let totalDist = 0, preferredDist = 0
    for (let i = 1; i < coords.length; i++) {
      const d = haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
      totalDist += d
      // Find nearest way to classify
      let nearestWay: OsmWay | null = null, nearestDist = Infinity
      for (const way of allWays) {
        for (const [wLat, wLng] of way.coordinates) {
          const wd = Math.abs(coords[i][0] - wLat) + Math.abs(coords[i][1] - wLng)
          if (wd < nearestDist && wd < 0.0005) { nearestDist = wd; nearestWay = way }
        }
      }
      if (nearestWay) {
        const item = classifyWay(nearestWay.tags, 'toddler')
        if (item && TODDLER_PREFERRED.has(item)) preferredDist += d
      }
    }

    return {
      engine: 'valhalla',
      distance: trip.summary.length,
      duration: trip.summary.time / 60,
      preferredPct: totalDist > 0 ? preferredDist / totalDist : 0,
      walkingPct: 0,
      coordinates: coords,
    }
  } catch (e) {
    console.warn(`    Valhalla error: ${e}`)
    return null
  }
}

// ── BRouter routing ──────────────────────────────────────────────────────

async function brouterRoute(startLat: number, startLng: number, endLat: number, endLng: number, allWays: OsmWay[]): Promise<RouteResult | null> {
  try {
    const url = `https://brouter.de/brouter?lonlats=${startLng},${startLat}|${endLng},${endLat}&profile=safety&alternativeidx=0&format=geojson`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json() as any
    const feature = data.features[0]
    const props = feature.properties
    const geom = feature.geometry.coordinates as [number, number, number][]
    const coords: [number, number][] = geom.map(([lng, lat]) => [lat, lng])

    // Score
    let totalDist = 0, preferredDist = 0
    for (let i = 1; i < coords.length; i++) {
      const d = haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
      totalDist += d
      let nearestWay: OsmWay | null = null, nearestDist = Infinity
      for (const way of allWays) {
        for (const [wLat, wLng] of way.coordinates) {
          const wd = Math.abs(coords[i][0] - wLat) + Math.abs(coords[i][1] - wLng)
          if (wd < nearestDist && wd < 0.0005) { nearestDist = wd; nearestWay = way }
        }
      }
      if (nearestWay) {
        const item = classifyWay(nearestWay.tags, 'toddler')
        if (item && TODDLER_PREFERRED.has(item)) preferredDist += d
      }
    }

    return {
      engine: 'brouter-safety',
      distance: props['track-length'] / 1000,
      duration: props['total-time'] / 60,
      preferredPct: totalDist > 0 ? preferredDist / totalDist : 0,
      walkingPct: 0,
      coordinates: coords,
    }
  } catch (e) {
    console.warn(`    BRouter error: ${e}`)
    return null
  }
}

// ── Test cases ───────────────────────────────────────────────────────────

const HOME = { lat: 52.5016, lng: 13.4103, label: 'Home' }
const SCHOOL = { lat: 52.5105, lng: 13.4247, label: 'School' }

const DESTINATIONS = [
  { lat: 52.5079, lng: 13.3376, label: 'Berlin Zoo' },
  { lat: 52.5284, lng: 13.3727, label: 'Hamburger Bahnhof' },
  { lat: 52.5219, lng: 13.4133, label: 'Alexanderplatz' },
  { lat: 52.5130, lng: 13.4070, label: 'Fischerinsel Swimming' },
  { lat: 52.5169, lng: 13.4019, label: 'Humboldt Forum' },
  { lat: 52.4910, lng: 13.4220, label: 'Nonne und Zwerg' },
  { lat: 52.4750, lng: 13.4340, label: 'Stadtbad Neukölln' },
  { lat: 52.5410, lng: 13.5790, label: 'Garten der Welt' },
]

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Routing Benchmark: Client vs Valhalla vs BRouter (toddler mode) ===\n')

  // Fetch Berlin tiles
  const allWays = await fetchBerlinTiles()

  // Build graph
  console.log('\nBuilding routing graph...')
  const t0 = performance.now()
  const graph = buildGraph(allWays)
  const buildMs = performance.now() - t0
  let nodeCount = 0, edgeCount = 0
  graph.forEachNode(() => { nodeCount++ })
  graph.forEachLink(() => { edgeCount++ })
  console.log(`  Nodes: ${nodeCount}, Edges: ${edgeCount}, Built in ${buildMs.toFixed(0)}ms\n`)

  // Run benchmarks
  const origins = [HOME, SCHOOL]
  const results: Array<{
    origin: string; dest: string
    client: RouteResult | null
    valhalla: RouteResult | null
    brouter: RouteResult | null
  }> = []

  for (const origin of origins) {
    for (const dest of DESTINATIONS) {
      console.log(`${origin.label} → ${dest.label}`)

      const client = clientRoute(graph, origin.lat, origin.lng, dest.lat, dest.lng)
      const valhalla = await valhallaRoute(origin.lat, origin.lng, dest.lat, dest.lng, allWays)
      await new Promise((r) => setTimeout(r, 1200)) // rate limit
      const brouter = await brouterRoute(origin.lat, origin.lng, dest.lat, dest.lng, allWays)
      await new Promise((r) => setTimeout(r, 1200))

      results.push({ origin: origin.label, dest: dest.label, client, valhalla, brouter })
    }
  }

  // Print results
  console.log('\n=== RESULTS ===\n')
  console.log('| Origin | Destination | Engine | Distance | Time | Preferred % | Walking % |')
  console.log('|--------|-------------|--------|----------|------|-------------|-----------|')

  for (const r of results) {
    for (const [engine, result] of [['Client', r.client], ['Valhalla', r.valhalla], ['BRouter', r.brouter]] as const) {
      if (result) {
        console.log(
          `| ${r.origin} | ${r.dest} | ${engine} | ${result.distance.toFixed(1)} km | ${result.duration.toFixed(0)} min | ${(result.preferredPct * 100).toFixed(0)}% | ${(result.walkingPct * 100).toFixed(0)}% |`
        )
      } else {
        console.log(`| ${r.origin} | ${r.dest} | ${engine} | FAILED | - | - | - |`)
      }
    }
  }

  // Summary
  console.log('\n=== SUMMARY ===\n')
  const clientResults = results.map((r) => r.client).filter(Boolean) as RouteResult[]
  const valhallaResults = results.map((r) => r.valhalla).filter(Boolean) as RouteResult[]
  const brouterResults = results.map((r) => r.brouter).filter(Boolean) as RouteResult[]

  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0

  console.log(`Client:   ${clientResults.length}/${results.length} routes found, avg preferred: ${(avg(clientResults.map((r) => r.preferredPct)) * 100).toFixed(0)}%, avg walk: ${(avg(clientResults.map((r) => r.walkingPct)) * 100).toFixed(0)}%`)
  console.log(`Valhalla: ${valhallaResults.length}/${results.length} routes found, avg preferred: ${(avg(valhallaResults.map((r) => r.preferredPct)) * 100).toFixed(0)}%`)
  console.log(`BRouter:  ${brouterResults.length}/${results.length} routes found, avg preferred: ${(avg(brouterResults.map((r) => r.preferredPct)) * 100).toFixed(0)}%`)

  // Per-route comparison
  console.log('\n=== CLIENT vs VALHALLA (preferred % difference) ===\n')
  for (const r of results) {
    if (r.client && r.valhalla) {
      const diff = (r.client.preferredPct - r.valhalla.preferredPct) * 100
      const emoji = diff > 5 ? '✅' : diff < -5 ? '❌' : '➖'
      console.log(`${emoji} ${r.origin} → ${r.dest}: Client ${(r.client.preferredPct * 100).toFixed(0)}% vs Valhalla ${(r.valhalla.preferredPct * 100).toFixed(0)}% (${diff > 0 ? '+' : ''}${diff.toFixed(0)}pp)`)
    }
  }
}

main().catch(console.error)
