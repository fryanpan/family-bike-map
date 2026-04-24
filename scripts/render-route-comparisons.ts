#!/usr/bin/env bun
/**
 * Route-comparison sample generator — manual, on-demand tool.
 *
 * By default generates ONE HTML per (city × pair × mode) combo using the
 * shared fixtures in scripts/lib/fixtures.ts. For the current set that's
 * 22 × 5 = 110 Berlin + 17 × 5 = 85 SF = **195 samples**. Each shows our
 * client router, Valhalla, and BRouter overlaid on OSM tiles.
 *
 * Every run:
 *   1. Nominatim-verifies every fixture — aborts if any Δ ≥ 150 m (wrong
 *      coord would produce a misleading comparison).
 *   2. Builds a kid-starting-out graph per city, reused across modes.
 *   3. Routes + renders per sample.
 *   4. Writes `public/route-compare/<YYYY-MM-DD>/`:
 *        - one <NN>-<city>-<mode>-<slug>.html per sample
 *        - index.html (sort by city → mode → pair, filter UI, summary)
 *        - metrics.json (full per-sample data INCLUDING path coords so
 *          historical runs can be re-scored against updated classifiers)
 *   5. Appends a one-line-per-run summary to `public/route-compare/history.jsonl`
 *
 * Not invoked on deploy — explicit manual run only. Bryan asked for this
 * boundary so the prod site reflects a known-good snapshot, not whatever
 * routing state happens to be live on the day of the last push.
 *
 * Run:  bun scripts/render-route-comparisons.ts [--city=berlin|sf]
 *                                                [--no-verify]
 *                                                [--no-external]
 */

import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildRoutingGraph, routeOnGraph, haversineM } from '../src/services/clientRouter'
import { buildQuery, classifyOsmTagsToItem } from '../src/services/overpass'
import { getDefaultPreferredItems } from '../src/utils/classify'
import type { OsmWay, LegendItem } from '../src/utils/types'
import {
  CITIES, MODES, verifyFixtures, printVerifyReport, hasVerifyErrors,
  type CityConfig, type Location, type ModeKey,
} from './lib/fixtures'

const OVERPASS_URL = 'https://bike-map.fryanpan.com/api/overpass'
const TILE_DEG = 0.1

// ── Valhalla / BRouter profiles (same as benchmark-routing.ts) ────────

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

// ── Tiles ──────────────────────────────────────────────────────────────

const tileCache = new Map<string, OsmWay[]>()

async function fetchTile(row: number, col: number): Promise<OsmWay[]> {
  const key = `${row}:${col}`
  if (tileCache.has(key)) return tileCache.get(key)!
  const bbox = { south: row * TILE_DEG, north: (row + 1) * TILE_DEG, west: col * TILE_DEG, east: (col + 1) * TILE_DEG }
  const query = buildQuery(bbox)
  const resp = await fetch(`${OVERPASS_URL}?row=${row}&col=${col}`, {
    method: 'POST', body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  if (!resp.ok) { tileCache.set(key, []); return [] }
  const data = await resp.json() as { elements: Array<{ type: string; id: number; tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> }> }
  const ways: OsmWay[] = data.elements.filter((el) => el.type === 'way' && el.geometry != null).map((el) => ({
    osmId: el.id,
    coordinates: el.geometry!.map((pt): [number, number] => [pt.lat, pt.lon]),
    tags: el.tags ?? {},
    itemName: null as LegendItem | null,
  }))
  tileCache.set(key, ways)
  return ways
}

async function fetchTilesForCity(city: CityConfig): Promise<OsmWay[]> {
  const minRow = Math.floor(city.bbox.south / TILE_DEG)
  const maxRow = Math.floor(city.bbox.north / TILE_DEG)
  const minCol = Math.floor(city.bbox.west  / TILE_DEG)
  const maxCol = Math.floor(city.bbox.east  / TILE_DEG)
  const tiles: Array<[number, number]> = []
  for (let r = minRow; r <= maxRow; r++) for (let c = minCol; c <= maxCol; c++) tiles.push([r, c])
  console.log(`[${city.displayName}] fetching ${tiles.length} tiles…`)
  const out: OsmWay[] = []
  for (let i = 0; i < tiles.length; i += 2) {
    const batch = tiles.slice(i, i + 2)
    const results = await Promise.all(batch.map(([r, c]) => fetchTile(r, c)))
    for (const ws of results) out.push(...ws)
    process.stdout.write(`\r  ${Math.min(i + 2, tiles.length)}/${tiles.length} tiles`)
    if (i + 2 < tiles.length) await new Promise((r) => setTimeout(r, 500))
  }
  console.log(`\n  ${out.length} ways`)
  return out
}

// ── External routers ───────────────────────────────────────────────────

interface RoutedLeg { coords: [number, number][]; distanceKm: number; durationMin: number }

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

async function valhallaRoute(o: Location, d: Location, mode: ModeKey): Promise<RoutedLeg | null> {
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
  } catch (e) { console.warn(`  Valhalla error: ${e}`); return null }
}

async function brouterRoute(o: Location, d: Location, mode: ModeKey): Promise<RoutedLeg | null> {
  try {
    const profile = BROUTER_PROFILES[mode]
    const url = `https://brouter.de/brouter?lonlats=${o.lng},${o.lat}|${d.lng},${d.lat}&profile=${profile}&alternativeidx=0&format=geojson`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json() as { features: Array<{ properties: Record<string, number>; geometry: { coordinates: [number, number, number][] } }> }
    const f = data.features[0]
    const coords: [number, number][] = f.geometry.coordinates.map(([lng, lat]) => [lat, lng])
    return { coords, distanceKm: f.properties['track-length'] / 1000, durationMin: f.properties['total-time'] / 60 }
  } catch (e) { console.warn(`  BRouter error: ${e}`); return null }
}

// ── Scoring ────────────────────────────────────────────────────────────
//
// The nearest-way lookup runs 3 times per sample (client/valhalla/
// brouter) × ~300 points per route × ~150k ways (Berlin): linear scan
// is ~20 s/sample, which is the sole reason the full 195-sample run
// used to take 90 minutes. Spatial grid brings it to <1 s/sample.
//
// Grid: lat/lng binned to 0.001° ≈ 100 m cells. For each query point
// we only check the cell + 8 neighbours (≈ 300 m radius), which safely
// contains the 55 m (0.0005°) match threshold.

const GRID_BIN = 0.001

function buildWaySpatialGrid(ways: OsmWay[]): Map<string, OsmWay[]> {
  const grid = new Map<string, OsmWay[]>()
  for (const way of ways) {
    // Add the way to every cell any of its vertices touches. Same way
    // can land in many cells; that's fine — duplicates are cheap.
    const seen = new Set<string>()
    for (const [lat, lng] of way.coordinates) {
      const key = `${Math.floor(lat / GRID_BIN)},${Math.floor(lng / GRID_BIN)}`
      if (seen.has(key)) continue
      seen.add(key)
      const arr = grid.get(key)
      if (arr) arr.push(way)
      else grid.set(key, [way])
    }
  }
  return grid
}

function scorePreferred(
  coords: [number, number][],
  grid: Map<string, OsmWay[]>,
  mode: ModeKey,
  preferred: Set<string>,
): number {
  // classifyOsmTagsToItem is pure of `tags`, so cache by way within this
  // single route — same way visited many times along the path shouldn't
  // re-classify.
  const classifyCache = new Map<OsmWay, string | null>()
  let total = 0, pref = 0
  for (let i = 1; i < coords.length; i++) {
    const d = haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
    total += d
    const [lat, lng] = coords[i]
    const bLat = Math.floor(lat / GRID_BIN)
    const bLng = Math.floor(lng / GRID_BIN)
    let nearest: OsmWay | null = null, best = Infinity
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ways = grid.get(`${bLat + dy},${bLng + dx}`)
        if (!ways) continue
        for (const way of ways) {
          for (const [wLat, wLng] of way.coordinates) {
            const wd = Math.abs(lat - wLat) + Math.abs(lng - wLng)
            if (wd < best && wd < 0.0005) { best = wd; nearest = way }
          }
        }
      }
    }
    if (nearest) {
      let item = classifyCache.get(nearest)
      if (item === undefined) {
        item = classifyOsmTagsToItem(nearest.tags, mode)
        classifyCache.set(nearest, item)
      }
      if (item && preferred.has(item)) pref += d
    }
  }
  return total > 0 ? pref / total : 0
}

// ── Sample types ───────────────────────────────────────────────────────

interface ScoredLeg extends RoutedLeg { preferredPct: number; walkingPct?: number }

interface Sample {
  index: number
  city: 'berlin' | 'sf'
  cityDisplay: string
  mode: ModeKey
  origin: Location
  dest: Location
  client: ScoredLeg | null
  valhalla: ScoredLeg | null
  brouter: ScoredLeg | null
  /**
   * Google's bike route is the same for every mode (Google has no
   * mode concept), so it's fetched once per pair via scripts/fetch-
   * google-routes.ts and cached. Null if the cache is missing or the
   * fetch failed.
   */
  google: ScoredLeg | null
  /** client distance > 1.2 × min(valhalla, brouter, google) → flagged */
  distanceFlag: boolean
}

function computeDistanceFlag(s: Pick<Sample, 'client' | 'valhalla' | 'brouter' | 'google'>): boolean {
  if (!s.client) return false
  const externals = [s.valhalla, s.brouter, s.google].filter((x): x is ScoredLeg => x != null)
  if (externals.length === 0) return false
  const minExt = Math.min(...externals.map((x) => x.distanceKm))
  if (minExt <= 0) return false
  return s.client.distanceKm > 1.2 * minExt
}

// ── Rendering ──────────────────────────────────────────────────────────

function safeSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
}

function sampleFilename(s: Sample): string {
  const n = String(s.index + 1).padStart(3, '0')
  return `${n}-${s.city}-${s.mode}-${safeSlug(s.origin.label)}-to-${safeSlug(s.dest.label)}.html`
}

function renderSampleHtml(s: Sample): string {
  const j = JSON.stringify
  const title = `#${s.index + 1}: ${s.origin.label} → ${s.dest.label} [${s.mode}] (${s.cityDisplay})`
  const stat = (label: string, leg: ScoredLeg | null, color: string) =>
    leg
      ? `<span class="stat" style="color:${color}"><b>${label}:</b> ${leg.distanceKm.toFixed(1)} km · ${leg.durationMin.toFixed(0)} min · ${(leg.preferredPct * 100).toFixed(0)}% preferred</span>`
      : `<span class="stat" style="color:${color}"><b>${label}:</b> FAIL</span>`
  const flagBadge = s.distanceFlag ? `<span class="flag" title="Client > 1.2× min(external)">⚠ long detour</span>` : ''
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossorigin=""/>
<style>
  html,body{margin:0;padding:0;height:100%;font-family:system-ui,sans-serif}
  #hdr{padding:8px 12px;border-bottom:1px solid #e5e7eb;background:#f9fafb}
  #hdr h1{font-size:14px;margin:0 0 4px}
  .stat{font-family:ui-monospace,Menlo,monospace;font-size:12px;margin-right:14px}
  .flag{font-size:12px;color:#b45309;background:#fef3c7;padding:1px 6px;border-radius:4px;margin-left:6px}
  #map{position:absolute;top:60px;left:0;right:0;bottom:0}
</style>
</head><body>
<div id="hdr"><h1>${title} ${flagBadge}</h1>${stat('Client', s.client, '#2563eb')} ${stat('Valhalla', s.valhalla, '#ea580c')} ${stat('BRouter', s.brouter, '#059669')} ${stat('Google', s.google, '#dc2626')}</div>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js" crossorigin=""></script>
<script>
  const client   = ${s.client   ? j(s.client.coords)   : 'null'};
  const valhalla = ${s.valhalla ? j(s.valhalla.coords) : 'null'};
  const brouter  = ${s.brouter  ? j(s.brouter.coords)  : 'null'};
  const google   = ${s.google   ? j(s.google.coords)   : 'null'};
  const start    = ${j([s.origin.lat, s.origin.lng])};
  const end      = ${j([s.dest.lat,   s.dest.lng])};
  const m = L.map('map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m);
  function paint(coords, color, weight, label) {
    L.polyline(coords, { color: '#fff', weight: weight + 4, opacity: 0.9 }).addTo(m);
    L.polyline(coords, { color, weight, opacity: 0.95 }).bindTooltip(label).addTo(m);
  }
  if (google)   paint(google,   '#dc2626', 4, 'Google');
  if (valhalla) paint(valhalla, '#ea580c', 4, 'Valhalla');
  if (brouter)  paint(brouter,  '#059669', 4, 'BRouter');
  if (client)   paint(client,   '#2563eb', 6, 'Client');
  L.circleMarker(start, { radius: 6, color: '#000', fillColor: '#10b981', fillOpacity: 1 }).bindTooltip('Start').addTo(m);
  L.circleMarker(end,   { radius: 6, color: '#000', fillColor: '#ef4444', fillOpacity: 1 }).bindTooltip('End').addTo(m);
  const all = [start, end].concat(client || []).concat(valhalla || []).concat(brouter || []).concat(google || []);
  m.fitBounds(L.latLngBounds(all), { padding: [30, 30] });
</script>
</body></html>`
}

function renderIndexHtml(samples: Sample[], runDate: string, version: string): string {
  // Sort city → mode → pair (alphabetical by origin then dest).
  const sorted = [...samples].sort((a, b) => {
    if (a.city !== b.city) return a.city < b.city ? -1 : 1
    if (a.mode !== b.mode) return a.mode < b.mode ? -1 : 1
    const pa = `${a.origin.label} → ${a.dest.label}`
    const pb = `${b.origin.label} → ${b.dest.label}`
    return pa < pb ? -1 : pa > pb ? 1 : 0
  })

  const cities = [...new Set(sorted.map((s) => s.cityDisplay))]
  const modes = [...new Set(sorted.map((s) => s.mode))].sort()

  // Aggregate stats.
  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  const cPrefs  = sorted.filter((s) => s.client)  .map((s) => s.client! .preferredPct)
  const vPrefs  = sorted.filter((s) => s.valhalla).map((s) => s.valhalla!.preferredPct)
  const bPrefs  = sorted.filter((s) => s.brouter) .map((s) => s.brouter! .preferredPct)
  const gPrefs  = sorted.filter((s) => s.google)  .map((s) => s.google!  .preferredPct)
  const cDists  = sorted.filter((s) => s.client)  .map((s) => s.client! .distanceKm)
  const vDists  = sorted.filter((s) => s.valhalla).map((s) => s.valhalla!.distanceKm)
  const bDists  = sorted.filter((s) => s.brouter) .map((s) => s.brouter! .distanceKm)
  const gDists  = sorted.filter((s) => s.google)  .map((s) => s.google!  .distanceKm)
  const flagged = sorted.filter((s) => s.distanceFlag).length

  // ── Heatmap palettes (colorblind-safe) ───────────────────────────
  //
  //   Preferred %: sequential "Blues" — light=worst-in-row, dark=best.
  //   Distance:    divergent blue→white→orange. Blue=best (min of row),
  //                neutral at 1.25× best, orange at 1.5× best or more.
  //                Orange is distinct from blue for deutan/protan and
  //                doesn't collide with red/green confusion.
  //
  // Per-row (not per-column) scaling — the point is "which router wins
  // THIS route," not "how does this route rank globally."
  function hexToRgb(h: string): [number, number, number] {
    const s = h.replace('#', '')
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]
  }
  function rgbToHex(r: number, g: number, b: number): string {
    return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
  }
  function lerpColor(a: string, b: string, t: number): string {
    const pa = hexToRgb(a), pb = hexToRgb(b)
    return rgbToHex(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t)
  }
  function relLuminance(hex: string): number {
    const [r, g, b] = hexToRgb(hex).map((v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }) as [number, number, number]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  function textColorFor(bg: string): string {
    return relLuminance(bg) < 0.55 ? '#fff' : '#111827'
  }
  /** Sequential Blues stop list — matches ColorBrewer "Blues" 9-class. */
  const PREF_LIGHT = '#f7fbff'
  const PREF_DARK  = '#08306b'
  /** Divergent: blue (best) → near-white at 1.25× → orange (1.5×+). */
  const DIST_BEST    = '#2166ac'
  const DIST_NEUTRAL = '#f7f7f7'
  const DIST_WORST   = '#e66101'

  function prefColor(val: number | null, maxInRow: number): string | null {
    if (val == null || maxInRow <= 0) return null
    const t = Math.max(0, Math.min(1, val / maxInRow))
    return lerpColor(PREF_LIGHT, PREF_DARK, t)
  }
  function distColor(val: number | null, minInRow: number): string | null {
    if (val == null || minInRow <= 0) return null
    const ratio = val / minInRow  // 1.0 best, 1.5+ worst-end
    const t = Math.max(0, Math.min(1, (ratio - 1) / 0.5))  // 0..1 across best→worst
    // Two-stop gradient through neutral at 0.5.
    return t <= 0.5
      ? lerpColor(DIST_BEST, DIST_NEUTRAL, t * 2)
      : lerpColor(DIST_NEUTRAL, DIST_WORST, (t - 0.5) * 2)
  }

  const rows = sorted.map((s) => {
    const fn = sampleFilename(s)
    const routers = [s.client, s.valhalla, s.brouter, s.google]

    const prefs = routers.map((r) => r?.preferredPct ?? null)
    const dists = routers.map((r) => r?.distanceKm   ?? null)
    const maxPref = Math.max(...prefs.filter((v): v is number => v != null), 0)
    const validDists = dists.filter((v): v is number => v != null && v > 0)
    const minDist = validDists.length ? Math.min(...validDists) : 0

    const distCell = (v: number | null): string => {
      if (v == null) return `<td class="heat fail">FAIL</td>`
      const bg = distColor(v, minDist) ?? ''
      const fg = bg ? textColorFor(bg) : '#111827'
      return `<td class="heat" style="background:${bg};color:${fg}">${v.toFixed(1)}</td>`
    }
    const prefCell = (v: number | null): string => {
      if (v == null) return `<td class="heat fail">FAIL</td>`
      const bg = prefColor(v, maxPref) ?? ''
      const fg = bg ? textColorFor(bg) : '#111827'
      return `<td class="heat" style="background:${bg};color:${fg}">${(v * 100).toFixed(0)}%</td>`
    }

    return `<tr data-city="${s.cityDisplay}" data-mode="${s.mode}" data-pair="${(s.origin.label + ' → ' + s.dest.label).toLowerCase()}" data-flagged="${s.distanceFlag ? '1' : '0'}">
      <td>${s.cityDisplay}</td>
      <td>${s.mode}</td>
      <td>${s.origin.label} → ${s.dest.label}</td>
      ${distCell(dists[0])}${distCell(dists[1])}${distCell(dists[2])}${distCell(dists[3])}
      ${prefCell(prefs[0])}${prefCell(prefs[1])}${prefCell(prefs[2])}${prefCell(prefs[3])}
      <td>${s.distanceFlag ? '<span class="flag">⚠</span>' : ''}</td>
      <td><a href="${fn}">open</a></td>
    </tr>`
  }).join('\n')

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><title>Route-compare ${version} — ${runDate} (${sorted.length})</title>
<style>
  body { font-family: system-ui, sans-serif; padding: 20px; max-width: 1400px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .subtitle { color: #6b7280; font-size: 13px; margin: 0 0 16px; }
  .legend { margin: 12px 0 18px; font-size: 13px; }
  .legend span { display: inline-block; margin-right: 14px; }
  .sw { display: inline-block; width: 14px; height: 4px; vertical-align: middle; margin-right: 4px; }

  .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 16px 0 20px; }
  .summary-card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; }
  .summary-card h3 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #374151; margin: 0 0 6px; }
  .summary-card .client   { color: #2563eb; }
  .summary-card .valhalla { color: #ea580c; }
  .summary-card .brouter  { color: #059669; }
  .summary-card .google   { color: #dc2626; }
  .summary-card .metric   { font-family: ui-monospace, Menlo, monospace; font-size: 13px; margin: 2px 0; }

  .flag-banner { background: #fef3c7; color: #78350f; padding: 8px 12px; border-radius: 6px; margin: 14px 0; font-size: 13px; }

  .filters { display: flex; flex-wrap: wrap; gap: 12px; margin: 14px 0; padding: 10px 14px; background: #f9fafb; border-radius: 6px; align-items: center; }
  .filters label { font-size: 12px; font-weight: 600; color: #374151; margin-right: 4px; }
  .filters select, .filters input { font-size: 13px; padding: 4px 8px; border: 1px solid #d1d5db; border-radius: 4px; }
  .filters input { min-width: 200px; }
  .filters button { font-size: 12px; padding: 4px 10px; border: 1px solid #d1d5db; border-radius: 4px; background: #fff; cursor: pointer; }
  .filters .count { font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: #6b7280; margin-left: auto; }

  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #eee; text-align: left; }
  th { background: #f9fafb; font-weight: 600; position: sticky; top: 0; font-size: 12px; }
  /* Heatmap cells: right-aligned, monospace, thin vertical borders so
     the per-router columns read cleanly. */
  td.heat { font-family: ui-monospace, Menlo, monospace; text-align: right; padding: 6px 8px; border-right: 1px solid rgba(255,255,255,0.5); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .sub { font-size: 11px; font-weight: 500; color: #6b7280; border-bottom: 1px solid #e5e7eb; text-align: center; padding: 4px 8px; }
  .group-dist { border-left: 3px solid #2166ac; }
  .group-pref { border-left: 3px solid #08306b; }
  tr.hidden { display: none; }
  .fail { color: #b91c1c; font-weight: 600; background: #fef2f2; text-align: center; }
  .flag { color: #b45309; font-weight: 600; }
  /* Heatmap legend strip next to each column group title. */
  .scale { display: inline-block; vertical-align: middle; margin-left: 6px; font-weight: 400; color: #6b7280; font-size: 10.5px; }
  .scale-bar { display: inline-block; width: 60px; height: 8px; vertical-align: middle; border-radius: 2px; margin: 0 4px; }
</style>
</head><body>
<h1>Route-compare samples</h1>
<p class="subtitle">Run: ${runDate} · version <code>${version}</code> · ${sorted.length} samples · City × mode × pair</p>

<div class="legend">
  <span><span class="sw" style="background:#2563eb"></span>Client router (ours)</span>
  <span><span class="sw" style="background:#ea580c"></span>Valhalla (osm.org bicycle)</span>
  <span><span class="sw" style="background:#059669"></span>BRouter</span>
  <span><span class="sw" style="background:#dc2626"></span>Google Maps (bicycling)</span>
</div>

<div class="summary">
  <div class="summary-card">
    <h3>Avg preferred %</h3>
    <div class="metric client">Client:   ${(avg(cPrefs) * 100).toFixed(0)}% <span style="color:#9ca3af">(n=${cPrefs.length})</span></div>
    <div class="metric valhalla">Valhalla: ${(avg(vPrefs) * 100).toFixed(0)}% <span style="color:#9ca3af">(n=${vPrefs.length})</span></div>
    <div class="metric brouter">BRouter:  ${(avg(bPrefs) * 100).toFixed(0)}% <span style="color:#9ca3af">(n=${bPrefs.length})</span></div>
    <div class="metric google">Google:   ${(avg(gPrefs) * 100).toFixed(0)}% <span style="color:#9ca3af">(n=${gPrefs.length})</span></div>
  </div>
  <div class="summary-card">
    <h3>Avg distance</h3>
    <div class="metric client">Client:   ${avg(cDists).toFixed(2)} km</div>
    <div class="metric valhalla">Valhalla: ${avg(vDists).toFixed(2)} km</div>
    <div class="metric brouter">BRouter:  ${avg(bDists).toFixed(2)} km</div>
    <div class="metric google">Google:   ${avg(gDists).toFixed(2)} km</div>
  </div>
  <div class="summary-card">
    <h3>Distance flags</h3>
    <div class="metric">${flagged} / ${sorted.length} routes where client &gt; 1.2× min(Valhalla, BRouter)</div>
    <div class="metric" style="color:#6b7280;font-size:11px;margin-top:6px">Likely detour. Worth reviewing on the map — may still be correct (e.g. safer corridor) but flag it.</div>
  </div>
</div>

${flagged > 0 ? `<div class="flag-banner">⚠ ${flagged} route(s) flagged for long detour. Use the “flagged only” filter below.</div>` : ''}

<div class="filters">
  <label>City <select id="f-city"><option value="">all</option>${cities.map((c) => `<option>${c}</option>`).join('')}</select></label>
  <label>Mode <select id="f-mode"><option value="">all</option>${modes.map((m) => `<option>${m}</option>`).join('')}</select></label>
  <label>Pair <input id="f-pair" type="search" placeholder="search origin/dest…" /></label>
  <label><input id="f-flag" type="checkbox" /> flagged only</label>
  <button id="f-clear" type="button">clear</button>
  <span class="count" id="f-count"></span>
</div>

<table>
  <thead>
    <tr>
      <th rowspan="2">City</th>
      <th rowspan="2">Mode</th>
      <th rowspan="2">Route</th>
      <th colspan="4" class="group-dist" style="text-align:center">
        Distance (km)
        <span class="scale">
          <span class="scale-bar" style="background:linear-gradient(to right, ${DIST_BEST}, ${DIST_NEUTRAL}, ${DIST_WORST})"></span>
          best → 1.5× best
        </span>
      </th>
      <th colspan="4" class="group-pref" style="text-align:center">
        Preferred %
        <span class="scale">
          <span class="scale-bar" style="background:linear-gradient(to right, ${PREF_LIGHT}, ${PREF_DARK})"></span>
          low → best-in-row
        </span>
      </th>
      <th rowspan="2">Flag</th>
      <th rowspan="2"></th>
    </tr>
    <tr>
      <th class="sub group-dist">Client</th><th class="sub">Valhalla</th><th class="sub">BRouter</th><th class="sub">Google</th>
      <th class="sub group-pref">Client</th><th class="sub">Valhalla</th><th class="sub">BRouter</th><th class="sub">Google</th>
    </tr>
  </thead>
  <tbody id="rows">${rows}</tbody>
</table>

<script>
  const city = document.getElementById('f-city')
  const mode = document.getElementById('f-mode')
  const pair = document.getElementById('f-pair')
  const flag = document.getElementById('f-flag')
  const clear = document.getElementById('f-clear')
  const count = document.getElementById('f-count')
  const rows = document.querySelectorAll('#rows tr')
  function apply() {
    const c = city.value, m = mode.value, p = pair.value.trim().toLowerCase(), f = flag.checked
    let shown = 0
    for (const r of rows) {
      const ok = (!c || r.dataset.city === c)
        && (!m || r.dataset.mode === m)
        && (!p || r.dataset.pair.includes(p))
        && (!f || r.dataset.flagged === '1')
      r.classList.toggle('hidden', !ok)
      if (ok) shown++
    }
    count.textContent = shown + ' / ' + rows.length
  }
  city.addEventListener('change', apply)
  mode.addEventListener('change', apply)
  pair.addEventListener('input', apply)
  flag.addEventListener('change', apply)
  clear.addEventListener('click', () => { city.value=''; mode.value=''; pair.value=''; flag.checked=false; apply() })
  apply()
</script>
</body></html>`
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv
  const cityArg = args.find((a) => a.startsWith('--city='))?.slice('--city='.length) ?? null
  const skipVerify = args.includes('--no-verify')
  const skipExternal = args.includes('--no-external')

  const cities = cityArg ? CITIES.filter((c) => c.key === cityArg) : CITIES
  if (cities.length === 0) { console.error(`Unknown city "${cityArg}"`); process.exit(1) }

  // ── Fixture verification ─────────────────────────────────────────
  if (!skipVerify) {
    console.log('Verifying fixtures against Nominatim…')
    const report = await verifyFixtures(cities, {
      onProgress: (done, total) => process.stdout.write(`\r  ${done}/${total}`),
    })
    console.log('')
    printVerifyReport(report)
    if (hasVerifyErrors(report)) {
      console.error('\n✘ Fixture verification failed (≥150 m error). Fix the fixtures before re-running, or pass --no-verify to skip.')
      process.exit(1)
    }
  } else {
    console.log('Skipping fixture verification (--no-verify).')
  }

  const today = new Date().toISOString().slice(0, 10)
  // Folder is named <YYYY-MM-DD>-<version> so a benchmark result can be
  // traced back to the exact bundle that produced it. Locally the version
  // is 0.1.0-dev-<sha>[-dirty]; in CI it would be 0.1.<run_number>. We
  // derive it the same way vite.config.ts does so the value matches what
  // src/version.ts would read.
  const version = await resolveVersion()
  const folderName = `${today}-${version}`
  const outDir = join(process.cwd(), 'public/route-compare', folderName)
  await mkdir(outDir, { recursive: true })
  console.log(`\nOutput: ${outDir}`)

  // Load Google routes cache (written by scripts/fetch-google-routes.ts).
  // Key format: "<city>:<origin.label>→<dest.label>". Missing file or
  // missing keys are non-fatal; those samples render without a Google
  // line and Google columns show FAIL.
  interface GoogleCacheEntry { coords: [number, number][]; distanceKm: number; durationMin: number }
  let googleCache: Record<string, GoogleCacheEntry | null> = {}
  try {
    const raw = await readFile(join(process.cwd(), 'public/route-compare/google-routes.json'), 'utf-8')
    googleCache = JSON.parse(raw)
    const hits = Object.values(googleCache).filter((v) => v != null).length
    console.log(`Loaded Google routes cache: ${hits} pairs`)
  } catch {
    console.log(`No Google routes cache found (public/route-compare/google-routes.json). Run scripts/fetch-google-routes.ts first if you want Google in the comparison.`)
  }

  // ── Enumerate samples ────────────────────────────────────────────
  const combos: Array<{ city: CityConfig; pair: { origin: Location; dest: Location }; mode: ModeKey }> = []
  for (const city of cities)
    for (const pair of city.pairs)
      for (const mode of MODES)
        combos.push({ city, pair, mode })
  console.log(`${combos.length} samples across ${cities.length} cit${cities.length === 1 ? 'y' : 'ies'} × pairs × ${MODES.length} modes\n`)

  // ── Tiles + graphs + spatial grid ────────────────────────────────
  const tilesByCity = new Map<string, OsmWay[]>()
  const gridByCity = new Map<string, Map<string, OsmWay[]>>()
  for (const city of cities) {
    const ws = await fetchTilesForCity(city)
    tilesByCity.set(city.key, ws)
    console.log(`  building spatial index for ${city.displayName}…`)
    gridByCity.set(city.key, buildWaySpatialGrid(ws))
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

  // ── Generate samples ─────────────────────────────────────────────
  const samples: Sample[] = []
  for (let i = 0; i < combos.length; i++) {
    const { city, pair, mode } = combos[i]
    console.log(`[${i + 1}/${combos.length}] ${city.displayName} · ${mode} · ${pair.origin.label} → ${pair.dest.label}`)

    const { graph, preferred } = getGraph(city, mode)
    const grid = gridByCity.get(city.key)!
    const clientRes = routeOnGraph(graph, pair.origin.lat, pair.origin.lng, pair.dest.lat, pair.dest.lng, mode, preferred)

    let valhalla: RoutedLeg | null = null, brouter: RoutedLeg | null = null
    if (!skipExternal) {
      // Valhalla + BRouter are independent public services — run in
      // parallel. Still pace 1.2 s between iterations so a single
      // service isn't getting hit faster than ~1 req/s from us.
      ;[valhalla, brouter] = await Promise.all([
        valhallaRoute(pair.origin, pair.dest, mode),
        brouterRoute(pair.origin, pair.dest, mode),
      ])
      await new Promise((r) => setTimeout(r, 1200))
    }

    const score = (coords: [number, number][]) => scorePreferred(coords, grid, mode, preferred)
    const client: ScoredLeg | null = clientRes ? {
      coords: clientRes.coordinates,
      distanceKm: clientRes.distanceKm,
      durationMin: clientRes.durationS / 60,
      preferredPct: score(clientRes.coordinates),
      walkingPct: clientRes.walkingPct,
    } : null
    const v: ScoredLeg | null = valhalla ? { ...valhalla, preferredPct: score(valhalla.coords) } : null
    const b: ScoredLeg | null = brouter  ? { ...brouter,  preferredPct: score(brouter.coords)  } : null
    // Google: same route for every mode, but preferredPct is scored
    // against THIS mode's preferred-items set so the comparison is
    // apples-to-apples per mode.
    const gKey = `${city.key}:${pair.origin.label}→${pair.dest.label}`
    const gCached = googleCache[gKey]
    const g: ScoredLeg | null = gCached
      ? { coords: gCached.coords, distanceKm: gCached.distanceKm, durationMin: gCached.durationMin, preferredPct: score(gCached.coords) }
      : null
    const distanceFlag = computeDistanceFlag({ client, valhalla: v, brouter: b, google: g })

    const s: Sample = {
      index: i,
      city: city.key,
      cityDisplay: city.displayName,
      mode,
      origin: pair.origin,
      dest: pair.dest,
      client, valhalla: v, brouter: b, google: g,
      distanceFlag,
    }
    samples.push(s)
    await writeFile(join(outDir, sampleFilename(s)), renderSampleHtml(s))
  }

  // ── Index + metrics ──────────────────────────────────────────────
  await writeFile(join(outDir, 'index.html'), renderIndexHtml(samples, today, version))

  // Full metrics dump including coord arrays so historical runs can be
  // re-scored against an updated classifier later.
  const commit = await gitHead().catch(() => null)
  const avg = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  const cPrefs = samples.filter((s) => s.client)  .map((s) => s.client! .preferredPct)
  const vPrefs = samples.filter((s) => s.valhalla).map((s) => s.valhalla!.preferredPct)
  const bPrefs = samples.filter((s) => s.brouter) .map((s) => s.brouter! .preferredPct)
  const gPrefs = samples.filter((s) => s.google)  .map((s) => s.google!  .preferredPct)
  const cDists = samples.filter((s) => s.client)  .map((s) => s.client! .distanceKm)
  const vDists = samples.filter((s) => s.valhalla).map((s) => s.valhalla!.distanceKm)
  const bDists = samples.filter((s) => s.brouter) .map((s) => s.brouter! .distanceKm)
  const gDists = samples.filter((s) => s.google)  .map((s) => s.google!  .distanceKm)
  const flagged = samples.filter((s) => s.distanceFlag).length

  const metrics = {
    runDate: today,
    version,
    commit,
    count: samples.length,
    summary: {
      avgPreferredPct: { client: avg(cPrefs), valhalla: avg(vPrefs), brouter: avg(bPrefs), google: avg(gPrefs) },
      avgDistanceKm:   { client: avg(cDists), valhalla: avg(vDists), brouter: avg(bDists), google: avg(gDists) },
      flaggedCount: flagged,
    },
    samples: samples.map((s) => ({
      index: s.index,
      city: s.city,
      mode: s.mode,
      origin: { label: s.origin.label, lat: s.origin.lat, lng: s.origin.lng },
      dest:   { label: s.dest.label,   lat: s.dest.lat,   lng: s.dest.lng },
      distanceFlag: s.distanceFlag,
      client:   s.client   ? { km: s.client.distanceKm,   min: s.client.durationMin,   preferredPct: s.client.preferredPct,   coords: s.client.coords }   : null,
      valhalla: s.valhalla ? { km: s.valhalla.distanceKm, min: s.valhalla.durationMin, preferredPct: s.valhalla.preferredPct, coords: s.valhalla.coords } : null,
      brouter:  s.brouter  ? { km: s.brouter.distanceKm,  min: s.brouter.durationMin,  preferredPct: s.brouter.preferredPct,  coords: s.brouter.coords  } : null,
      google:   s.google   ? { km: s.google.distanceKm,   min: s.google.durationMin,   preferredPct: s.google.preferredPct,   coords: s.google.coords }   : null,
    })),
  }
  await writeFile(join(outDir, 'metrics.json'), JSON.stringify(metrics, null, 2))

  // Append summary-only line to history.jsonl so a future viewer can
  // plot preferred-%/distance over commits without loading ~3 MB
  // per-run metrics files.
  const historyLine = JSON.stringify({
    runDate: today,
    version,
    commit,
    count: samples.length,
    ...metrics.summary,
  }) + '\n'
  const historyPath = join(process.cwd(), 'public/route-compare/history.jsonl')
  await appendFile(historyPath, historyLine)

  console.log(`\n✓ Wrote ${samples.length} samples + index.html + metrics.json to ${outDir}`)
  console.log(`  appended 1 line to ${historyPath}`)
  console.log(`  Browse: http://localhost:5173/route-compare/${folderName}/index.html`)
}

async function gitHead(): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', 'rev-parse', '--short', 'HEAD'], { stdout: 'pipe' })
    const out = await new Response(proc.stdout).text()
    return out.trim() || null
  } catch { return null }
}

/**
 * Version string used as the benchmark folder prefix. Three layers:
 *   1. $VITE_APP_VERSION       (set in CI — pass-through)
 *   2. Live prod version from https://bike-map.fryanpan.com/version.json
 *      composed with local git sha — folder is "<prod-version>-local-<sha>[-dirty]"
 *      so the folder tells you both what's deployed AND what you
 *      actually ran the benchmark against.
 *   3. Fall-through to "0.1.0-dev-<sha>[-dirty]" if prod is unreachable.
 */
async function resolveVersion(): Promise<string> {
  const envVer = process.env.VITE_APP_VERSION
  if (envVer) return envVer

  // Local git sha + dirty flag.
  let sha = 'unknown'
  let dirty = false
  try {
    const shaProc = Bun.spawn(['git', 'rev-parse', '--short', 'HEAD'], { stdout: 'pipe' })
    sha = (await new Response(shaProc.stdout).text()).trim() || 'unknown'
    const dirtyProc = Bun.spawn(['git', 'status', '--porcelain'], { stdout: 'pipe' })
    dirty = (await new Response(dirtyProc.stdout).text()).trim().length > 0
  } catch { /* sha stays 'unknown' */ }

  // Prod version (optional). Short timeout — we're just building a
  // folder name; don't block the whole benchmark on a slow/offline
  // network.
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    const resp = await fetch('https://bike-map.fryanpan.com/version.json', { signal: controller.signal })
    clearTimeout(timer)
    if (resp.ok) {
      const data = await resp.json() as { version?: string }
      if (data.version) {
        return `${data.version}-local-${sha}${dirty ? '-dirty' : ''}`
      }
    }
  } catch { /* fall through to local-only format */ }

  return `0.1.0-dev-${sha}${dirty ? '-dirty' : ''}`
}

main().catch((e) => { console.error(e); process.exit(1) })
