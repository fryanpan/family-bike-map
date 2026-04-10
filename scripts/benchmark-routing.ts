#!/usr/bin/env bun
/**
 * Routing Benchmark Script
 *
 * Compares client-side router vs Valhalla vs BRouter (safety) for Berlin test routes.
 * Uses the app's actual routing code (buildRoutingGraph, routeOnGraph, classifyOsmTagsToItem)
 * so benchmark results reflect real app behavior.
 *
 * Run: bun scripts/benchmark-routing.ts
 */

import { buildRoutingGraph, routeOnGraph, haversineM } from '../src/services/clientRouter'
import { classifyOsmTagsToItem, buildQuery } from '../src/services/overpass'
import { getDefaultPreferredItems } from '../src/utils/classify'
import type { OsmWay } from '../src/utils/types'

// ── Config ──────────────────────────────────────────────────────────────

const OVERPASS_URL = 'https://bike-map.fryanpan.com/api/overpass'
const TILE_DEGREES = 0.1
const PROFILE_KEY = 'toddler'
const PREFERRED = getDefaultPreferredItems(PROFILE_KEY)

// ── Tile fetching (via Cloudflare Worker proxy with 30-day cache) ────────

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

  const query = buildQuery(bbox)

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

  const data = await resp.json() as { elements: Array<{ type: string; id: number; tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> }> }
  const ways: OsmWay[] = data.elements
    .filter((el) => el.type === 'way' && el.geometry != null)
    .map((el) => ({
      osmId: el.id,
      coordinates: el.geometry!.map((pt): [number, number] => [pt.lat, pt.lon]),
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
    if (i + 2 < tiles.length) await new Promise((r) => setTimeout(r, 500))
  }
  console.log(`\n  Total: ${allWays.length} ways`)
  return allWays
}

// ── Score external routes using Overpass data ────────────────────────────

function scoreRouteCoords(coords: [number, number][], allWays: OsmWay[]): { preferredPct: number } {
  let totalDist = 0, preferredDist = 0

  for (let i = 1; i < coords.length; i++) {
    const d = haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
    totalDist += d

    // Find nearest way to classify this segment
    let nearestWay: OsmWay | null = null, nearestDist = Infinity
    for (const way of allWays) {
      for (const [wLat, wLng] of way.coordinates) {
        const wd = Math.abs(coords[i][0] - wLat) + Math.abs(coords[i][1] - wLng)
        if (wd < nearestDist && wd < 0.0005) { nearestDist = wd; nearestWay = way }
      }
    }
    if (nearestWay) {
      const item = classifyOsmTagsToItem(nearestWay.tags, PROFILE_KEY)
      if (item && PREFERRED.has(item)) preferredDist += d
    }
  }

  return { preferredPct: totalDist > 0 ? preferredDist / totalDist : 0 }
}

// ── Valhalla routing ─────────────────────────────────────────────────────

interface RouteResult {
  engine: string
  distance: number  // km
  duration: number  // min
  preferredPct: number
  walkingPct: number
}

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

    const { preferredPct } = scoreRouteCoords(coords, allWays)

    return {
      engine: 'valhalla',
      distance: trip.summary.length,
      duration: trip.summary.time / 60,
      preferredPct,
      walkingPct: 0,
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

    const { preferredPct } = scoreRouteCoords(coords, allWays)

    return {
      engine: 'brouter-safety',
      distance: props['track-length'] / 1000,
      duration: props['total-time'] / 60,
      preferredPct,
      walkingPct: 0,
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
  { lat: 52.4750, lng: 13.4340, label: 'Stadtbad Neukoelln' },
  { lat: 52.5410, lng: 13.5790, label: 'Garten der Welt' },
]

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Routing Benchmark: Client vs Valhalla vs BRouter (toddler mode) ===\n')

  // Fetch Berlin tiles
  const allWays = await fetchBerlinTiles()

  // Build graph using the app's actual buildRoutingGraph
  console.log('\nBuilding routing graph...')
  const t0 = performance.now()
  const graph = buildRoutingGraph(allWays, PROFILE_KEY, PREFERRED)
  const buildMs = performance.now() - t0
  console.log(`  Nodes: ${graph.getNodeCount()}, Edges: ${graph.getLinkCount()}, Built in ${buildMs.toFixed(0)}ms\n`)

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
      console.log(`${origin.label} -> ${dest.label}`)

      // Client route using the app's actual routeOnGraph
      const t1 = performance.now()
      const clientResult = routeOnGraph(graph, origin.lat, origin.lng, dest.lat, dest.lng, PROFILE_KEY, PREFERRED)
      const routeMs = performance.now() - t1
      let client: RouteResult | null = null
      if (clientResult) {
        console.log(`    Client route: ${routeMs.toFixed(0)}ms`)
        client = {
          engine: 'client',
          distance: clientResult.distanceKm,
          duration: clientResult.durationS / 60,
          preferredPct: scoreRouteCoords(clientResult.coordinates, allWays).preferredPct,
          walkingPct: clientResult.walkingPct,
        }
      }

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
      const marker = diff > 5 ? '+' : diff < -5 ? '-' : '='
      console.log(`[${marker}] ${r.origin} -> ${r.dest}: Client ${(r.client.preferredPct * 100).toFixed(0)}% vs Valhalla ${(r.valhalla.preferredPct * 100).toFixed(0)}% (${diff > 0 ? '+' : ''}${diff.toFixed(0)}pp)`)
    }
  }
}

main().catch(console.error)
