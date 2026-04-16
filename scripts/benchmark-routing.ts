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

// All 5 modes after the Layer 1.5 refactor. External engines (Valhalla /
// BRouter) are mode-blind, so they're compared against a single reference
// mode (kid-confident) — the per-mode client comparison is the meaningful
// signal after the mode-rules work.
const MODES = ['kid-starting-out', 'kid-confident', 'kid-traffic-savvy', 'carrying-kid', 'training'] as const
const REFERENCE_MODE = 'kid-confident'
type ModeKey = typeof MODES[number]

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
  const south = 52.34, north = 52.68, west = 13.08, east = 13.80
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

function scoreRouteCoords(
  coords: [number, number][],
  allWays: OsmWay[],
  profileKey: string,
  preferred: Set<string>,
): { preferredPct: number } {
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
      const item = classifyOsmTagsToItem(nearestWay.tags, profileKey)
      if (item && preferred.has(item)) preferredDist += d
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

async function valhallaRoute(startLat: number, startLng: number, endLat: number, endLng: number, allWays: OsmWay[], profileKey: string, preferred: Set<string>): Promise<RouteResult | null> {
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

    const { preferredPct } = scoreRouteCoords(coords, allWays, profileKey, preferred)

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

async function brouterRoute(startLat: number, startLng: number, endLat: number, endLng: number, allWays: OsmWay[], profileKey: string, preferred: Set<string>): Promise<RouteResult | null> {
  try {
    const url = `https://brouter.de/brouter?lonlats=${startLng},${startLat}|${endLng},${endLat}&profile=safety&alternativeidx=0&format=geojson`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json() as any
    const feature = data.features[0]
    const props = feature.properties
    const geom = feature.geometry.coordinates as [number, number, number][]
    const coords: [number, number][] = geom.map(([lng, lat]) => [lat, lng])

    const { preferredPct } = scoreRouteCoords(coords, allWays, profileKey, preferred)

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
const BRANDENBURGER_TOR = { lat: 52.5163, lng: 13.3777, label: 'Brandenburger Tor' }
const THAIPARK = { lat: 52.4921, lng: 13.3147, label: 'Thaipark' }

const DESTINATIONS = [
  { lat: 52.5079, lng: 13.3376, label: 'Berlin Zoo' },
  { lat: 52.5284, lng: 13.3727, label: 'Hamburger Bahnhof' },
  { lat: 52.5219, lng: 13.4133, label: 'Alexanderplatz' },
  { lat: 52.5130, lng: 13.4070, label: 'Fischerinsel Swimming' },
  { lat: 52.5169, lng: 13.4019, label: 'Humboldt Forum' },
  { lat: 52.4910, lng: 13.4220, label: 'Nonne und Zwerg' },
  { lat: 52.4750, lng: 13.4340, label: 'Stadtbad Neukoelln' },
  { lat: 52.5410, lng: 13.5790, label: 'Garten der Welt' },
  { lat: 52.5300, lng: 13.4519, label: 'SSE Schwimmhalle' },
  { lat: 52.4898, lng: 13.3904, label: 'Ararat Bergmannstr' },
]

// Additional specific route pairs beyond Home/School × Destinations
const EXTRA_ROUTES: Array<{ origin: typeof HOME; dest: typeof HOME }> = [
  { origin: BRANDENBURGER_TOR, dest: { lat: 52.5079, lng: 13.3376, label: 'Berlin Zoo' } },
  { origin: THAIPARK, dest: { lat: 52.4867, lng: 13.3546, label: 'Tranxx' } },
]

// ── Main ─────────────────────────────────────────────────────────────────

interface RoutePair { origin: { lat: number; lng: number; label: string }; dest: { lat: number; lng: number; label: string } }

async function main() {
  const skipExternal = process.argv.includes('--no-external')
  console.log(`=== Routing Benchmark: Client (5 modes)${skipExternal ? '' : ' + Valhalla + BRouter'} ===\n`)

  const allWays = await fetchBerlinTiles()

  // Build all the pairs we want to test.
  const pairs: RoutePair[] = []
  for (const origin of [HOME, SCHOOL]) {
    for (const dest of DESTINATIONS) pairs.push({ origin, dest })
  }
  for (const p of EXTRA_ROUTES) pairs.push(p)

  // Per-mode client routing: build a graph per mode and route every pair.
  interface ModeRow { mode: ModeKey; pair: string; found: boolean; distanceKm: number; durationMin: number; preferredPct: number; walkingPct: number }
  const modeRows: ModeRow[] = []
  const modeGraphStats: Record<string, { nodes: number; edges: number; buildMs: number }> = {}

  for (const mode of MODES) {
    const preferred = getDefaultPreferredItems(mode)
    console.log(`\n[${mode}] Building graph...`)
    const t0 = performance.now()
    const graph = buildRoutingGraph(allWays, mode, preferred)
    const buildMs = performance.now() - t0
    modeGraphStats[mode] = { nodes: graph.getNodeCount(), edges: graph.getLinkCount(), buildMs }
    console.log(`  Nodes: ${graph.getNodeCount()}, Edges: ${graph.getLinkCount()}, Built in ${buildMs.toFixed(0)}ms`)

    let found = 0
    for (const { origin, dest } of pairs) {
      const result = routeOnGraph(graph, origin.lat, origin.lng, dest.lat, dest.lng, mode, preferred)
      const pairLabel = `${origin.label} -> ${dest.label}`
      if (result) {
        found++
        modeRows.push({
          mode, pair: pairLabel, found: true,
          distanceKm: result.distanceKm,
          durationMin: result.durationS / 60,
          preferredPct: scoreRouteCoords(result.coordinates, allWays, mode, preferred).preferredPct,
          walkingPct: result.walkingPct,
        })
      } else {
        modeRows.push({ mode, pair: pairLabel, found: false, distanceKm: 0, durationMin: 0, preferredPct: 0, walkingPct: 0 })
      }
    }
    console.log(`  Routes found: ${found}/${pairs.length}`)
  }

  // External routers (Valhalla / BRouter) scored against the reference mode only.
  interface ExtRow { pair: string; valhalla: RouteResult | null; brouter: RouteResult | null }
  const extRows: ExtRow[] = []
  if (!skipExternal) {
    const refPreferred = getDefaultPreferredItems(REFERENCE_MODE)
    console.log(`\n=== External routers (scored against ${REFERENCE_MODE}) ===\n`)
    for (const { origin, dest } of pairs) {
      console.log(`${origin.label} -> ${dest.label}`)
      const valhalla = await valhallaRoute(origin.lat, origin.lng, dest.lat, dest.lng, allWays, REFERENCE_MODE, refPreferred)
      await new Promise((r) => setTimeout(r, 2000))
      const brouter = await brouterRoute(origin.lat, origin.lng, dest.lat, dest.lng, allWays, REFERENCE_MODE, refPreferred)
      await new Promise((r) => setTimeout(r, 2000))
      extRows.push({ pair: `${origin.label} -> ${dest.label}`, valhalla, brouter })
    }
  }

  // ── Results ──
  console.log('\n=== PER-MODE SUMMARY ===\n')
  console.log('| Mode | Found | Avg Distance | Avg Time | Avg Preferred | Avg Walk | Graph Nodes | Graph Edges |')
  console.log('|------|-------|--------------|----------|---------------|----------|-------------|-------------|')
  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  for (const mode of MODES) {
    const rows = modeRows.filter((r) => r.mode === mode && r.found)
    const total = modeRows.filter((r) => r.mode === mode).length
    const stats = modeGraphStats[mode]
    console.log(
      `| ${mode} | ${rows.length}/${total} | ${avg(rows.map((r) => r.distanceKm)).toFixed(1)} km | ${avg(rows.map((r) => r.durationMin)).toFixed(0)} min | ${(avg(rows.map((r) => r.preferredPct)) * 100).toFixed(0)}% | ${(avg(rows.map((r) => r.walkingPct)) * 100).toFixed(0)}% | ${stats.nodes} | ${stats.edges} |`
    )
  }

  console.log('\n=== PER-ROUTE × MODE (preferred %) ===\n')
  const header = ['Pair', ...MODES]
  console.log('| ' + header.join(' | ') + ' |')
  console.log('|' + header.map(() => '---').join('|') + '|')
  const uniquePairs = Array.from(new Set(modeRows.map((r) => r.pair)))
  for (const pair of uniquePairs) {
    const cells = [pair]
    for (const mode of MODES) {
      const row = modeRows.find((r) => r.mode === mode && r.pair === pair)!
      cells.push(row.found ? `${(row.preferredPct * 100).toFixed(0)}%` : 'FAIL')
    }
    console.log('| ' + cells.join(' | ') + ' |')
  }

  if (!skipExternal) {
    console.log('\n=== CLIENT (kid-confident) vs VALHALLA vs BROUTER ===\n')
    for (const ext of extRows) {
      const clientRow = modeRows.find((r) => r.mode === REFERENCE_MODE && r.pair === ext.pair)
      const c = clientRow?.found ? `${(clientRow.preferredPct * 100).toFixed(0)}%` : 'FAIL'
      const v = ext.valhalla ? `${(ext.valhalla.preferredPct * 100).toFixed(0)}%` : 'FAIL'
      const b = ext.brouter ? `${(ext.brouter.preferredPct * 100).toFixed(0)}%` : 'FAIL'
      console.log(`${ext.pair}: client=${c} valhalla=${v} brouter=${b}`)
    }
  }
}

main().catch(console.error)
