#!/usr/bin/env bun
/**
 * Route-comparison image generator
 *
 * Samples 30 random (city, origin, dest, mode) combos and renders each as
 * a self-contained HTML file showing the routes chosen by our client
 * router, Valhalla (osm.org profile), and BRouter overlaid on an OSM tile
 * backdrop.
 *
 * Output: `docs/research/YYYY-MM-DD-route-compare/` with
 *   - one HTML per sample: `NN-<city>-<mode>-<origin>-to-<dest>.html`
 *   - an `index.html` with a summary table and links
 *
 * Run:   bun scripts/render-route-comparisons.ts [--count=30] [--seed=42]
 *
 * The sample is seeded (deterministic mulberry32) so re-running without
 * args gives the same 30; use `--seed=<n>` to reroll.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildRoutingGraph, routeOnGraph, haversineM } from '../src/services/clientRouter'
import { buildQuery, classifyOsmTagsToItem } from '../src/services/overpass'
import { getDefaultPreferredItems } from '../src/utils/classify'
import type { OsmWay, LegendItem } from '../src/utils/types'

// ── Config ─────────────────────────────────────────────────────────────

const OVERPASS_URL = 'https://bike-map.fryanpan.com/api/overpass'
const TILE_DEGREES = 0.1
const DEFAULT_COUNT = 30
const DEFAULT_SEED = 42

type ModeKey =
  | 'kid-starting-out'
  | 'kid-confident'
  | 'kid-traffic-savvy'
  | 'carrying-kid'
  | 'training'

const MODES: ModeKey[] = [
  'kid-starting-out',
  'kid-confident',
  'kid-traffic-savvy',
  'carrying-kid',
  'training',
]

// Mirrors benchmark-routing.ts — same profile choices so the visuals are
// comparable to the benchmark table numbers.
interface ValhallaCostingOptions {
  bicycle_type: 'Road' | 'Hybrid' | 'Cross' | 'Mountain'
  cycling_speed: number
  use_roads: number
  use_hills: number
  avoid_bad_surfaces: number
  use_living_streets: number
  use_ferry: number
}
const VALHALLA_PROFILES: Record<ModeKey, ValhallaCostingOptions> = {
  'kid-starting-out':  { bicycle_type: 'Hybrid', cycling_speed: 5,  use_roads: 0.0,  avoid_bad_surfaces: 0.9, use_living_streets: 1.0, use_hills: 0.1, use_ferry: 0.0 },
  'kid-confident':     { bicycle_type: 'Hybrid', cycling_speed: 10, use_roads: 0.05, avoid_bad_surfaces: 0.6, use_living_streets: 1.0, use_hills: 0.2, use_ferry: 0.0 },
  'kid-traffic-savvy': { bicycle_type: 'Hybrid', cycling_speed: 15, use_roads: 0.3,  avoid_bad_surfaces: 0.5, use_living_streets: 0.7, use_hills: 0.3, use_ferry: 0.0 },
  'carrying-kid':      { bicycle_type: 'Hybrid', cycling_speed: 15, use_roads: 0.2,  avoid_bad_surfaces: 0.9, use_living_streets: 0.7, use_hills: 0.4, use_ferry: 0.0 },
  'training':          { bicycle_type: 'Road',   cycling_speed: 25, use_roads: 0.6,  avoid_bad_surfaces: 0.8, use_living_streets: 0.3, use_hills: 0.3, use_ferry: 0.0 },
}
const BROUTER_PROFILES: Record<ModeKey, string> = {
  'kid-starting-out':  'safety',
  'kid-confident':     'safety',
  'kid-traffic-savvy': 'trekking',
  'carrying-kid':      'trekking',
  'training':          'fastbike',
}

// ── Route fixtures ─────────────────────────────────────────────────────

type LatLng = { lat: number; lng: number; label: string }
interface CityConfig { key: 'berlin' | 'sf'; displayName: string; bbox: { south: number; west: number; north: number; east: number }; pairs: Array<{ origin: LatLng; dest: LatLng }> }

const BERLIN_ORIGINS: LatLng[] = [
  { lat: 52.5016, lng: 13.4103, label: 'Home' },
  { lat: 52.5105, lng: 13.4247, label: 'School' },
]
const BERLIN_DESTS: LatLng[] = [
  { lat: 52.5079, lng: 13.3376, label: 'Berlin Zoo' },
  { lat: 52.5284, lng: 13.3727, label: 'Hamburger Bahnhof' },
  { lat: 52.5219, lng: 13.4133, label: 'Alexanderplatz' },
  { lat: 52.5130, lng: 13.4070, label: 'Fischerinsel Swimming' },
  { lat: 52.5169, lng: 13.4019, label: 'Humboldt Forum' },
  { lat: 52.4910, lng: 13.4220, label: 'Nonne und Zwerg' },
  { lat: 52.4750, lng: 13.4340, label: 'Stadtbad Neukoelln' },
  { lat: 52.5410, lng: 13.5790, label: 'Garten der Welt' },
  // Omit SSE Schwimmhalle — bbox-limited FAIL per benchmark.
  { lat: 52.4898, lng: 13.3904, label: 'Ararat Bergmannstr' },
]
const BERLIN_EXTRA: Array<{ origin: LatLng; dest: LatLng }> = [
  { origin: { lat: 52.5163, lng: 13.3777, label: 'Brandenburger Tor' }, dest: { lat: 52.5079, lng: 13.3376, label: 'Berlin Zoo' } },
  { origin: { lat: 52.4921, lng: 13.3147, label: 'Thaipark' },         dest: { lat: 52.4867, lng: 13.3546, label: 'Tranxx' } },
]
const BERLIN: CityConfig = {
  key: 'berlin',
  displayName: 'Berlin',
  bbox: { south: 52.34, west: 13.08, north: 52.68, east: 13.80 },
  pairs: [
    ...BERLIN_ORIGINS.flatMap((o) => BERLIN_DESTS.map((d) => ({ origin: o, dest: d }))),
    ...BERLIN_EXTRA,
  ],
}

const SF_ORIGIN: LatLng = { lat: 37.7605, lng: -122.4311, label: 'Home (Castro)' }
const SF_DESTS: LatLng[] = [
  { lat: 37.7955, lng: -122.3935, label: 'Ferry Building' },
  { lat: 37.7507, lng: -122.5085, label: 'Sunset Dunes' },
  { lat: 37.7619, lng: -122.4219, label: 'Dumpling Story' },
  { lat: 37.7573, lng: -122.3924, label: '22nd St Caltrain' },
  { lat: 37.7769, lng: -122.3951, label: '4th+King Caltrain' },
  { lat: 37.7475, lng: -122.4216, label: 'CPMC Mission Bernal' },
  { lat: 37.7631, lng: -122.4574, label: 'UCSF Parnassus' },
  { lat: 37.7822, lng: -122.4789, label: 'Lung Fung Bakery' },
  { lat: 37.7805, lng: -122.4806, label: 'Dragon Beaux' },
]
// Only the 9 SF destinations that succeeded in the 2026-04-22 benchmark
// are in SF_DESTS. The bbox-limited FAIL pairs would just render empty
// client polylines against Valhalla/BRouter fallback — not informative.
const SF: CityConfig = {
  key: 'sf',
  displayName: 'San Francisco',
  bbox: { south: 37.70, west: -122.52, north: 37.82, east: -122.38 },
  pairs: SF_DESTS.map((d) => ({ origin: SF_ORIGIN, dest: d })),
}

const CITIES = [BERLIN, SF]

// ── Seeded RNG (mulberry32) ────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pickN<T>(rng: () => number, items: T[], n: number): T[] {
  const arr = items.slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.slice(0, n)
}

// ── Tiles ──────────────────────────────────────────────────────────────

const tileCache = new Map<string, OsmWay[]>()

async function fetchTile(row: number, col: number): Promise<OsmWay[]> {
  const key = `${row}:${col}`
  if (tileCache.has(key)) return tileCache.get(key)!
  const bbox = { south: row * TILE_DEGREES, north: (row + 1) * TILE_DEGREES, west: col * TILE_DEGREES, east: (col + 1) * TILE_DEGREES }
  const query = buildQuery(bbox)
  const resp = await fetch(`${OVERPASS_URL}?row=${row}&col=${col}`, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  if (!resp.ok) { tileCache.set(key, []); return [] }
  const data = await resp.json() as { elements: Array<{ type: string; id: number; tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> }> }
  const ways: OsmWay[] = data.elements
    .filter((el) => el.type === 'way' && el.geometry != null)
    .map((el) => ({
      osmId: el.id,
      coordinates: el.geometry!.map((pt): [number, number] => [pt.lat, pt.lon]),
      tags: el.tags ?? {},
      itemName: null as LegendItem | null,
    }))
  tileCache.set(key, ways)
  return ways
}

async function fetchTilesForCity(city: CityConfig): Promise<OsmWay[]> {
  const minRow = Math.floor(city.bbox.south / TILE_DEGREES)
  const maxRow = Math.floor(city.bbox.north / TILE_DEGREES)
  const minCol = Math.floor(city.bbox.west / TILE_DEGREES)
  const maxCol = Math.floor(city.bbox.east / TILE_DEGREES)
  const tiles: Array<[number, number]> = []
  for (let r = minRow; r <= maxRow; r++)
    for (let c = minCol; c <= maxCol; c++)
      tiles.push([r, c])
  console.log(`[${city.displayName}] fetching ${tiles.length} tiles…`)
  const out: OsmWay[] = []
  for (let i = 0; i < tiles.length; i += 2) {
    const batch = tiles.slice(i, i + 2)
    const results = await Promise.all(batch.map(([r, c]) => fetchTile(r, c)))
    for (const ways of results) out.push(...ways)
    process.stdout.write(`\r  ${Math.min(i + 2, tiles.length)}/${tiles.length} tiles`)
    if (i + 2 < tiles.length) await new Promise((r) => setTimeout(r, 500))
  }
  console.log(`\n  ${out.length} ways`)
  return out
}

// ── External routers (returning coords) ────────────────────────────────

interface RoutedLeg { coords: [number, number][]; distanceKm: number; durationMin: number }

async function valhallaRoute(o: LatLng, d: LatLng, mode: ModeKey): Promise<RoutedLeg | null> {
  try {
    const body = {
      locations: [{ lat: o.lat, lon: o.lng }, { lat: d.lat, lon: d.lng }],
      costing: 'bicycle',
      costing_options: { bicycle: VALHALLA_PROFILES[mode] },
      directions_options: { units: 'km', language: 'en-US' },
    }
    const resp = await fetch('https://valhalla1.openstreetmap.de/route', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) return null
    const data = await resp.json() as { trip: { summary: { length: number; time: number }; legs: Array<{ shape: string }> } }
    const coords: [number, number][] = data.trip.legs.flatMap((leg) => decodePolyline6(leg.shape))
    return { coords, distanceKm: data.trip.summary.length, durationMin: data.trip.summary.time / 60 }
  } catch (e) {
    console.warn(`    Valhalla error: ${e}`)
    return null
  }
}

function decodePolyline6(encoded: string): [number, number][] {
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
}

async function brouterRoute(o: LatLng, d: LatLng, mode: ModeKey): Promise<RoutedLeg | null> {
  try {
    const profile = BROUTER_PROFILES[mode]
    const url = `https://brouter.de/brouter?lonlats=${o.lng},${o.lat}|${d.lng},${d.lat}&profile=${profile}&alternativeidx=0&format=geojson`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json() as { features: Array<{ properties: Record<string, number>; geometry: { coordinates: [number, number, number][] } }> }
    const f = data.features[0]
    const coords: [number, number][] = f.geometry.coordinates.map(([lng, lat]) => [lat, lng])
    return { coords, distanceKm: f.properties['track-length'] / 1000, durationMin: f.properties['total-time'] / 60 }
  } catch (e) {
    console.warn(`    BRouter error: ${e}`)
    return null
  }
}

// ── HTML rendering ─────────────────────────────────────────────────────

function safeSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
}

interface Sample {
  index: number
  city: 'berlin' | 'sf'
  cityDisplay: string
  mode: ModeKey
  origin: LatLng
  dest: LatLng
  client: (RoutedLeg & { preferredPct: number; walkingPct: number }) | null
  valhalla: RoutedLeg | null
  brouter: RoutedLeg | null
}

function renderSampleHtml(s: Sample): string {
  const j = JSON.stringify
  const title = `#${s.index + 1}: ${s.origin.label} → ${s.dest.label} [${s.mode}] (${s.cityDisplay})`
  const statRow = (label: string, leg: RoutedLeg | null, color: string, extra?: string) => {
    if (!leg) return `<span class="stat" style="color:${color}"><b>${label}:</b> FAIL</span>`
    const km = leg.distanceKm.toFixed(1)
    const min = leg.durationMin.toFixed(0)
    return `<span class="stat" style="color:${color}"><b>${label}:</b> ${km} km · ${min} min${extra ?? ''}</span>`
  }
  const clientExtra = s.client ? ` · ${(s.client.preferredPct * 100).toFixed(0)}% preferred` : ''
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${title}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin=""/>
<style>
  html,body{margin:0;padding:0;height:100%;font-family:system-ui,sans-serif}
  #hdr{padding:8px 12px;border-bottom:1px solid #e5e7eb;background:#f9fafb}
  #hdr h1{font-size:14px;margin:0 0 4px}
  .stat{font-family:ui-monospace,Menlo,monospace;font-size:12px;margin-right:14px}
  #map{position:absolute;top:60px;left:0;right:0;bottom:0}
</style>
</head><body>
<div id="hdr">
  <h1>${title}</h1>
  ${statRow('Client', s.client, '#2563eb', clientExtra)}
  ${statRow('Valhalla', s.valhalla, '#ea580c')}
  ${statRow('BRouter', s.brouter, '#059669')}
</div>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
<script>
  const client   = ${s.client ? j(s.client.coords) : 'null'};
  const valhalla = ${s.valhalla ? j(s.valhalla.coords) : 'null'};
  const brouter  = ${s.brouter ? j(s.brouter.coords) : 'null'};
  const start    = ${j([s.origin.lat, s.origin.lng])};
  const end      = ${j([s.dest.lat, s.dest.lng])};
  const m = L.map('map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
  const lines = [];
  if (client)   lines.push(L.polyline(client,   { color: '#2563eb', weight: 6, opacity: 0.85 }).bindTooltip('Client').addTo(m));
  if (valhalla) lines.push(L.polyline(valhalla, { color: '#ea580c', weight: 4, opacity: 0.75 }).bindTooltip('Valhalla').addTo(m));
  if (brouter)  lines.push(L.polyline(brouter,  { color: '#059669', weight: 4, opacity: 0.75 }).bindTooltip('BRouter').addTo(m));
  L.circleMarker(start, { radius: 6, color: '#000', fillColor: '#10b981', fillOpacity: 1 }).bindTooltip('Start').addTo(m);
  L.circleMarker(end,   { radius: 6, color: '#000', fillColor: '#ef4444', fillOpacity: 1 }).bindTooltip('End').addTo(m);
  const allCoords = [start, end].concat(client || []).concat(valhalla || []).concat(brouter || []);
  m.fitBounds(L.latLngBounds(allCoords), { padding: [30, 30] });
</script>
</body></html>
`
}

function renderIndexHtml(samples: Sample[]): string {
  const rows = samples.map((s) => {
    const fn = sampleFilename(s)
    const c = s.client ? `${s.client.distanceKm.toFixed(1)}km / ${(s.client.preferredPct * 100).toFixed(0)}%` : 'FAIL'
    const v = s.valhalla ? `${s.valhalla.distanceKm.toFixed(1)}km` : 'FAIL'
    const b = s.brouter ? `${s.brouter.distanceKm.toFixed(1)}km` : 'FAIL'
    return `<tr>
      <td>${s.index + 1}</td>
      <td>${s.cityDisplay}</td>
      <td>${s.mode}</td>
      <td>${s.origin.label} → ${s.dest.label}</td>
      <td style="color:#2563eb">${c}</td>
      <td style="color:#ea580c">${v}</td>
      <td style="color:#059669">${b}</td>
      <td><a href="${fn}">open</a></td>
    </tr>`
  }).join('\n')
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>Route-compare samples (${samples.length})</title>
<style>
  body{font-family:system-ui,sans-serif;padding:20px;max-width:1200px;margin:0 auto}
  h1{font-size:20px}
  .legend{margin:14px 0;font-size:13px}
  .legend span{display:inline-block;margin-right:14px}
  .sw{display:inline-block;width:14px;height:4px;vertical-align:middle;margin-right:4px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{padding:6px 10px;border-bottom:1px solid #eee;text-align:left}
  th{background:#f9fafb;font-weight:600}
  td:nth-child(5),td:nth-child(6),td:nth-child(7){font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
</style>
</head><body>
<h1>Route-compare samples (${samples.length})</h1>
<div class="legend">
  <span><span class="sw" style="background:#2563eb"></span>Client router</span>
  <span><span class="sw" style="background:#ea580c"></span>Valhalla (osm.org profile)</span>
  <span><span class="sw" style="background:#059669"></span>BRouter</span>
</div>
<p>Each row opens a standalone map with all three routes overlaid. Distances are km; the client column also shows preferred-%.</p>
<table>
<thead><tr><th>#</th><th>City</th><th>Mode</th><th>Route</th><th>Client</th><th>Valhalla</th><th>BRouter</th><th></th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body></html>
`
}

function sampleFilename(s: Sample): string {
  const n = String(s.index + 1).padStart(2, '0')
  const origin = safeSlug(s.origin.label)
  const dest = safeSlug(s.dest.label)
  return `${n}-${s.city}-${s.mode}-${origin}-to-${dest}.html`
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const countArg = process.argv.find((a) => a.startsWith('--count='))
  const seedArg = process.argv.find((a) => a.startsWith('--seed='))
  const count = countArg ? parseInt(countArg.slice('--count='.length), 10) : DEFAULT_COUNT
  const seed  = seedArg  ? parseInt(seedArg.slice('--seed='.length),   10) : DEFAULT_SEED

  const today = new Date().toISOString().slice(0, 10)
  const outDir = join(process.cwd(), 'docs/research', `${today}-route-compare`)
  await mkdir(outDir, { recursive: true })
  console.log(`Output: ${outDir}`)

  // Build the combo universe, then sample.
  const universe: Array<{ city: CityConfig; pair: { origin: LatLng; dest: LatLng }; mode: ModeKey }> = []
  for (const city of CITIES)
    for (const pair of city.pairs)
      for (const mode of MODES)
        universe.push({ city, pair, mode })
  console.log(`Universe: ${universe.length} (city × pair × mode) combos`)

  const rng = mulberry32(seed)
  const chosen = pickN(rng, universe, Math.min(count, universe.length))
  console.log(`Sampling ${chosen.length} (seed=${seed})`)

  // Fetch tiles per city once, build graphs per (city, mode) once.
  const tilesByCity = new Map<string, OsmWay[]>()
  for (const city of CITIES) {
    if (chosen.some((s) => s.city === city)) {
      tilesByCity.set(city.key, await fetchTilesForCity(city))
    }
  }

  const graphCache = new Map<string, { graph: ReturnType<typeof buildRoutingGraph>; preferred: Set<string> }>()
  function getGraph(city: CityConfig, mode: ModeKey) {
    const key = `${city.key}:${mode}`
    const cached = graphCache.get(key)
    if (cached) return cached
    const tiles = tilesByCity.get(city.key)!
    const preferred = getDefaultPreferredItems(mode)
    console.log(`Building graph [${key}]…`)
    const graph = buildRoutingGraph(tiles, mode, preferred)
    const entry = { graph, preferred }
    graphCache.set(key, entry)
    return entry
  }

  // Produce a sample per chosen combo.
  const samples: Sample[] = []
  for (let i = 0; i < chosen.length; i++) {
    const { city, pair, mode } = chosen[i]
    console.log(`\n[${i + 1}/${chosen.length}] ${city.displayName} · ${mode} · ${pair.origin.label} → ${pair.dest.label}`)

    const { graph, preferred } = getGraph(city, mode)
    const clientRes = routeOnGraph(graph, pair.origin.lat, pair.origin.lng, pair.dest.lat, pair.dest.lng, mode, preferred)

    // Score client preferred-% using actual way lookup.
    let clientPreferred = 0
    if (clientRes) {
      const tiles = tilesByCity.get(city.key)!
      clientPreferred = scoreClientPreferred(clientRes.coordinates, tiles, mode, preferred)
    }

    const valhalla = await valhallaRoute(pair.origin, pair.dest, mode)
    await new Promise((r) => setTimeout(r, 1500))
    const brouter = await brouterRoute(pair.origin, pair.dest, mode)
    await new Promise((r) => setTimeout(r, 1500))

    samples.push({
      index: i,
      city: city.key,
      cityDisplay: city.displayName,
      mode,
      origin: pair.origin,
      dest: pair.dest,
      client: clientRes ? {
        coords: clientRes.coordinates,
        distanceKm: clientRes.distanceKm,
        durationMin: clientRes.durationS / 60,
        preferredPct: clientPreferred,
        walkingPct: clientRes.walkingPct,
      } : null,
      valhalla,
      brouter,
    })

    const s = samples[samples.length - 1]
    const fn = sampleFilename(s)
    await writeFile(join(outDir, fn), renderSampleHtml(s))
    console.log(`  → ${fn}`)
  }

  await writeFile(join(outDir, 'index.html'), renderIndexHtml(samples))
  console.log(`\n✓ Wrote ${samples.length} samples + index.html to ${outDir}`)
  console.log(`  open ${join(outDir, 'index.html')}`)
}

function scoreClientPreferred(coords: [number, number][], tiles: OsmWay[], mode: ModeKey, preferred: Set<string>): number {
  // Same nearest-way lookup as benchmark-routing.ts's scoreRouteCoords, but
  // only returns preferred-%.
  let total = 0, pref = 0
  for (let i = 1; i < coords.length; i++) {
    const d = haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
    total += d
    let nearest: OsmWay | null = null, best = Infinity
    for (const way of tiles) {
      for (const [wLat, wLng] of way.coordinates) {
        const wd = Math.abs(coords[i][0] - wLat) + Math.abs(coords[i][1] - wLng)
        if (wd < best && wd < 0.0005) { best = wd; nearest = way }
      }
    }
    if (nearest) {
      const item = classifyOsmTagsToItem(nearest.tags, mode)
      if (item && preferred.has(item)) pref += d
    }
  }
  return total > 0 ? pref / total : 0
}

main().catch(console.error)
