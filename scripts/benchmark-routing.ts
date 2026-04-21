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
import { classifyEdge } from '../src/utils/lts'
import type { PathLevel } from '../src/utils/lts'
import type { OsmWay } from '../src/utils/types'

// ── Config ──────────────────────────────────────────────────────────────

const OVERPASS_URL = 'https://bike-map.fryanpan.com/api/overpass'
const TILE_DEGREES = 0.1

// All 5 modes after the Layer 1.5 refactor.
const MODES = ['kid-starting-out', 'kid-confident', 'kid-traffic-savvy', 'carrying-kid', 'training'] as const
type ModeKey = typeof MODES[number]

// External engines (Valhalla, BRouter) don't know about our modes, but
// each engine has its own tunable profile. For the head-to-head we pick
// the closest-matching profile for each of our modes, so we're always
// comparing our router's kid-X mode against the BEST each engine can do
// for that same rider. The returned route is scored against our mode's
// preferred-item set either way.
interface ValhallaCostingOptions {
  bicycle_type: 'Road' | 'Hybrid' | 'Cross' | 'Mountain'
  cycling_speed: number
  use_roads: number          // 0 = avoid, 1 = prefer
  use_hills: number
  avoid_bad_surfaces: number // 0 = ignore, 1 = strongly avoid
  use_living_streets: number // 0 = avoid, 1 = strongly prefer
  use_ferry: number
}
const VALHALLA_PROFILES: Record<ModeKey, ValhallaCostingOptions> = {
  // Slowest, most car-avoidant. Hybrid tires for paving stones.
  'kid-starting-out': {
    bicycle_type: 'Hybrid', cycling_speed: 5,
    use_roads: 0.0, avoid_bad_surfaces: 0.9,
    use_living_streets: 1.0, use_hills: 0.1, use_ferry: 0.0,
  },
  // Still maximally car-avoidant but a bit faster and tolerates paving.
  'kid-confident': {
    bicycle_type: 'Hybrid', cycling_speed: 10,
    use_roads: 0.05, avoid_bad_surfaces: 0.6,
    use_living_streets: 1.0, use_hills: 0.2, use_ferry: 0.0,
  },
  // Will take painted lanes, still prefers quieter streets.
  'kid-traffic-savvy': {
    bicycle_type: 'Hybrid', cycling_speed: 15,
    use_roads: 0.3, avoid_bad_surfaces: 0.5,
    use_living_streets: 0.7, use_hills: 0.3, use_ferry: 0.0,
  },
  // Trailer/cargo: smooth surfaces matter, moderate speed, avoid roads
  // but not to the point of absurd detours.
  'carrying-kid': {
    bicycle_type: 'Hybrid', cycling_speed: 15,
    use_roads: 0.2, avoid_bad_surfaces: 0.9,
    use_living_streets: 0.7, use_hills: 0.4, use_ferry: 0.0,
  },
  // Fast adult road bike — fine on roads, avoids rough surface, flows.
  'training': {
    bicycle_type: 'Road', cycling_speed: 25,
    use_roads: 0.6, avoid_bad_surfaces: 0.8,
    use_living_streets: 0.3, use_hills: 0.3, use_ferry: 0.0,
  },
}

// BRouter has a small set of pre-built profiles hosted on brouter.de.
// "safety" — max avoidance of traffic (family / kid)
// "trekking" — general touring, balanced
// "fastbike" — fast road cycling, prefers good surfaces and flow
const BROUTER_PROFILES: Record<ModeKey, string> = {
  'kid-starting-out':  'safety',
  'kid-confident':     'safety',
  'kid-traffic-savvy': 'trekking',
  'carrying-kid':      'trekking',
  'training':          'fastbike',
}

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

interface CityBbox { south: number; west: number; north: number; east: number }

async function fetchTilesForCity(cityName: string, bbox: CityBbox): Promise<OsmWay[]> {
  const minRow = Math.floor(bbox.south / TILE_DEGREES)
  const maxRow = Math.floor(bbox.north / TILE_DEGREES)
  const minCol = Math.floor(bbox.west / TILE_DEGREES)
  const maxCol = Math.floor(bbox.east / TILE_DEGREES)

  const tiles: Array<{ row: number; col: number }> = []
  for (let r = minRow; r <= maxRow; r++)
    for (let c = minCol; c <= maxCol; c++)
      tiles.push({ row: r, col: c })

  console.log(`Fetching ${tiles.length} tiles for ${cityName}...`)
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

type LevelBreakdown = Record<PathLevel, number>

function emptyBreakdown(): LevelBreakdown {
  return { '1a': 0, '1b': 0, '2a': 0, '2b': 0, '3': 0, '4': 0 }
}

function scoreRouteCoords(
  coords: [number, number][],
  allWays: OsmWay[],
  profileKey: string,
  preferred: Set<string>,
): { preferredPct: number; levelPct: LevelBreakdown } {
  let totalDist = 0, preferredDist = 0
  const levelDist: LevelBreakdown = emptyBreakdown()

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
      const { pathLevel } = classifyEdge(nearestWay.tags)
      levelDist[pathLevel] += d
    }
  }

  const levelPct = emptyBreakdown()
  if (totalDist > 0) {
    for (const k of Object.keys(levelDist) as PathLevel[]) {
      levelPct[k] = levelDist[k] / totalDist
    }
  }

  return { preferredPct: totalDist > 0 ? preferredDist / totalDist : 0, levelPct }
}

// ── Valhalla routing ─────────────────────────────────────────────────────

interface RouteResult {
  engine: string
  distance: number  // km
  duration: number  // min
  preferredPct: number
  walkingPct: number
}

async function valhallaRoute(startLat: number, startLng: number, endLat: number, endLng: number, allWays: OsmWay[], profileKey: ModeKey, preferred: Set<string>): Promise<RouteResult | null> {
  const body = {
    locations: [
      { lat: startLat, lon: startLng },
      { lat: endLat, lon: endLng },
    ],
    costing: 'bicycle',
    costing_options: {
      bicycle: VALHALLA_PROFILES[profileKey],
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

async function brouterRoute(startLat: number, startLng: number, endLat: number, endLng: number, allWays: OsmWay[], profileKey: ModeKey, preferred: Set<string>): Promise<RouteResult | null> {
  try {
    const brouterProfile = BROUTER_PROFILES[profileKey]
    const url = `https://brouter.de/brouter?lonlats=${startLng},${startLat}|${endLng},${endLat}&profile=${brouterProfile}&alternativeidx=0&format=geojson`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json() as any
    const feature = data.features[0]
    const props = feature.properties
    const geom = feature.geometry.coordinates as [number, number, number][]
    const coords: [number, number][] = geom.map(([lng, lat]) => [lat, lng])

    const { preferredPct } = scoreRouteCoords(coords, allWays, profileKey, preferred)

    return {
      engine: `brouter-${brouterProfile}`,
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

type LatLng = { lat: number; lng: number; label: string }

interface CityConfig {
  key: string                            // 'berlin', 'sf'
  displayName: string
  bbox: CityBbox
  origins: LatLng[]                      // each origin × destinations
  destinations: LatLng[]
  extraRoutes: Array<{ origin: LatLng; dest: LatLng }>
}

const BERLIN: CityConfig = {
  key: 'berlin',
  displayName: 'Berlin',
  bbox: { south: 52.34, west: 13.08, north: 52.68, east: 13.80 },
  origins: [
    { lat: 52.5016, lng: 13.4103, label: 'Home' },     // Dresdener Str area, Kreuzberg
    { lat: 52.5105, lng: 13.4247, label: 'School' },   // Wilhelmine-Gemberg-Weg
  ],
  destinations: [
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
  ],
  extraRoutes: [
    { origin: { lat: 52.5163, lng: 13.3777, label: 'Brandenburger Tor' },
      dest:   { lat: 52.5079, lng: 13.3376, label: 'Berlin Zoo' } },
    { origin: { lat: 52.4921, lng: 13.3147, label: 'Thaipark' },
      dest:   { lat: 52.4867, lng: 13.3546, label: 'Tranxx' } },
  ],
}

// San Francisco — Bryan's curated 17 destinations, single origin at 120 Hancock St.
// Covers daily-life destinations (coffee, groceries, transit, medical, park)
// across the city, chosen to exercise SF's infra variety: Panhandle + Wiggle
// (cycleway-heavy), Market + Valencia (painted-lane arterials), Great Highway
// + JFK Promenade (car-free), hill climbs to Richmond/Sunset, Chinatown
// one-ways. All destinations resolved via Nominatim on 2026-04-21; see
// docs/product/plans/2026-04-21-path-categories-plan.md for context.
const SF: CityConfig = {
  key: 'sf',
  displayName: 'San Francisco',
  bbox: { south: 37.70, west: -122.52, north: 37.82, east: -122.38 },
  origins: [
    { lat: 37.7605, lng: -122.4311, label: 'Home (120 Hancock St, Castro)' },
  ],
  destinations: [
    { lat: 37.7955, lng: -122.3935, label: 'Ferry Building' },
    { lat: 37.7838, lng: -122.5068, label: 'Lands End' },
    { lat: 37.7696, lng: -122.4541, label: 'JFK Promenade east end (Stanyan)' },
    { lat: 37.7507, lng: -122.5085, label: 'Sunset Dunes (Ocean Beach)' },
    { lat: 37.7261, lng: -122.4434, label: 'Balboa Pool' },
    { lat: 37.7619, lng: -122.4219, label: 'Dumpling Story (694 Valencia)' },
    { lat: 37.7615, lng: -122.4239, label: 'Tartine (600 Guerrero)' },
    { lat: 37.7573, lng: -122.3924, label: '22nd St Caltrain' },
    { lat: 37.7769, lng: -122.3951, label: '4th + King Caltrain' },
    { lat: 37.7651, lng: -122.4197, label: '16th St Mission BART' },
    { lat: 37.7475, lng: -122.4216, label: 'CPMC Mission Bernal (Cesar Chavez + Valencia)' },
    { lat: 37.7631, lng: -122.4574, label: 'UCSF Parnassus (505 Parnassus)' },
    { lat: 37.7896, lng: -122.4079, label: '450 Sutter Medical Building' },
    { lat: 37.7887, lng: -122.4072, label: 'Apple Store Union Square' },
    { lat: 37.7960, lng: -122.4054, label: "Yummy's (607 Jackson, Chinatown)" },
    { lat: 37.7822, lng: -122.4789, label: 'Lung Fung Bakery (1823 Clement)' },
    { lat: 37.7805, lng: -122.4806, label: 'Dragon Beaux (5700 Geary)' },
  ],
  extraRoutes: [],
}

const CITIES: Record<string, CityConfig> = { berlin: BERLIN, sf: SF }

// ── Main ─────────────────────────────────────────────────────────────────

interface RoutePair { origin: { lat: number; lng: number; label: string }; dest: { lat: number; lng: number; label: string } }

async function main() {
  const skipExternal = process.argv.includes('--no-external')
  const cityFlag = process.argv.find((a) => a.startsWith('--city='))
  const cityKey = cityFlag ? cityFlag.slice('--city='.length) : 'berlin'
  const city = CITIES[cityKey]
  if (!city) {
    console.error(`Unknown city "${cityKey}". Available: ${Object.keys(CITIES).join(', ')}`)
    process.exit(1)
  }

  console.log(`=== Routing Benchmark: ${city.displayName} · Client (5 modes)${skipExternal ? '' : ' + Valhalla + BRouter'} ===\n`)

  const allWays = await fetchTilesForCity(city.displayName, city.bbox)

  // Build all the pairs we want to test.
  const pairs: RoutePair[] = []
  for (const origin of city.origins) {
    for (const dest of city.destinations) pairs.push({ origin, dest })
  }
  for (const p of city.extraRoutes) pairs.push(p)

  // Per-mode client routing: build a graph per mode and route every pair.
  interface ModeRow {
    mode: ModeKey
    pair: string
    found: boolean
    distanceKm: number
    durationMin: number
    preferredPct: number
    walkingPct: number
    levelPct: LevelBreakdown
  }
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
        const scored = scoreRouteCoords(result.coordinates, allWays, mode, preferred)
        modeRows.push({
          mode, pair: pairLabel, found: true,
          distanceKm: result.distanceKm,
          durationMin: result.durationS / 60,
          preferredPct: scored.preferredPct,
          walkingPct: result.walkingPct,
          levelPct: scored.levelPct,
        })
      } else {
        modeRows.push({ mode, pair: pairLabel, found: false, distanceKm: 0, durationMin: 0, preferredPct: 0, walkingPct: 0, levelPct: emptyBreakdown() })
      }
    }
    console.log(`  Routes found: ${found}/${pairs.length}`)
  }

  // External routers (Valhalla / BRouter) called per mode with the
  // best-matching profile for that mode. Scored against the SAME mode's
  // preferred-item set, so client vs external is apples-to-apples.
  interface ExtRow { mode: ModeKey; pair: string; valhalla: RouteResult | null; brouter: RouteResult | null }
  const extRows: ExtRow[] = []
  if (!skipExternal) {
    for (const mode of MODES) {
      const preferred = getDefaultPreferredItems(mode)
      console.log(`\n=== External routers for ${mode} (Valhalla profile=${VALHALLA_PROFILES[mode].bicycle_type}/cs${VALHALLA_PROFILES[mode].cycling_speed}, BRouter=${BROUTER_PROFILES[mode]}) ===\n`)
      for (const { origin, dest } of pairs) {
        console.log(`  ${origin.label} -> ${dest.label}`)
        const valhalla = await valhallaRoute(origin.lat, origin.lng, dest.lat, dest.lng, allWays, mode, preferred)
        await new Promise((r) => setTimeout(r, 2000))
        const brouter  = await brouterRoute(origin.lat, origin.lng, dest.lat, dest.lng, allWays, mode, preferred)
        await new Promise((r) => setTimeout(r, 2000))
        extRows.push({ mode, pair: `${origin.label} -> ${dest.label}`, valhalla, brouter })
      }
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

  console.log('\n=== PER-MODE LEVEL BREAKDOWN (% of route distance per PathLevel) ===\n')
  console.log('| Mode | LTS 1a | LTS 1b | LTS 2a | LTS 2b | LTS 3 | LTS 4 |')
  console.log('|------|:---:|:---:|:---:|:---:|:---:|:---:|')
  const pctOf = (rows: ModeRow[], lvl: PathLevel): string =>
    `${(avg(rows.map((r) => r.levelPct[lvl])) * 100).toFixed(0)}%`
  for (const mode of MODES) {
    const rows = modeRows.filter((r) => r.mode === mode && r.found)
    console.log(
      `| ${mode} | ${pctOf(rows, '1a')} | ${pctOf(rows, '1b')} | ${pctOf(rows, '2a')} | ${pctOf(rows, '2b')} | ${pctOf(rows, '3')} | ${pctOf(rows, '4')} |`
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
    // Per-mode averages — client vs Valhalla vs BRouter, all scored against
    // that mode's preferred set.
    console.log('\n=== EXTERNAL ROUTER SUMMARY (per mode) ===\n')
    console.log('| Mode | Client found | Valhalla found | BRouter found | Client avg | Valhalla avg | BRouter avg |')
    console.log('|------|:---:|:---:|:---:|:---:|:---:|:---:|')
    for (const mode of MODES) {
      const client = modeRows.filter((r) => r.mode === mode && r.found)
      const ext = extRows.filter((r) => r.mode === mode)
      const vOk = ext.filter((r) => r.valhalla).map((r) => r.valhalla!.preferredPct)
      const bOk = ext.filter((r) => r.brouter).map((r) => r.brouter!.preferredPct)
      console.log(
        `| ${mode} | ${client.length}/${pairs.length} | ${vOk.length}/${pairs.length} | ${bOk.length}/${pairs.length} | ${(avg(client.map((r) => r.preferredPct)) * 100).toFixed(0)}% | ${(avg(vOk) * 100).toFixed(0)}% | ${(avg(bOk) * 100).toFixed(0)}% |`
      )
    }

    // Head-to-head counts per mode (wins / ties / losses for client vs each).
    console.log('\n=== HEAD-TO-HEAD (client vs external, per mode) ===\n')
    console.log('| Mode | vs Valhalla (W/T/L) | vs BRouter (W/T/L) |')
    console.log('|------|:---:|:---:|')
    for (const mode of MODES) {
      let vW = 0, vT = 0, vL = 0
      let bW = 0, bT = 0, bL = 0
      for (const ext of extRows.filter((r) => r.mode === mode)) {
        const client = modeRows.find((r) => r.mode === mode && r.pair === ext.pair)
        if (!client?.found) continue
        const cp = client.preferredPct
        if (ext.valhalla) {
          const d = cp - ext.valhalla.preferredPct
          if      (d >  0.05) vW++
          else if (d < -0.05) vL++
          else                vT++
        }
        if (ext.brouter) {
          const d = cp - ext.brouter.preferredPct
          if      (d >  0.05) bW++
          else if (d < -0.05) bL++
          else                bT++
        }
      }
      console.log(`| ${mode} | ${vW}/${vT}/${vL} | ${bW}/${bT}/${bL} |`)
    }

    // Per-pair table per mode.
    for (const mode of MODES) {
      console.log(`\n=== ${mode} — per route ===\n`)
      console.log('| Pair | Client | Valhalla | BRouter |')
      console.log('|------|:---:|:---:|:---:|')
      for (const ext of extRows.filter((r) => r.mode === mode)) {
        const client = modeRows.find((r) => r.mode === mode && r.pair === ext.pair)
        const c = client?.found ? `${(client.preferredPct * 100).toFixed(0)}%` : 'FAIL'
        const v = ext.valhalla ? `${(ext.valhalla.preferredPct * 100).toFixed(0)}%` : 'FAIL'
        const b = ext.brouter ? `${(ext.brouter.preferredPct * 100).toFixed(0)}%` : 'FAIL'
        console.log(`| ${ext.pair} | ${c} | ${v} | ${b} |`)
      }
    }
  }
}

main().catch(console.error)
