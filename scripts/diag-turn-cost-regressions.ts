#!/usr/bin/env bun
/**
 * Reproduce the two PR #200 turn-cost regressions BEFORE fixing them
 * (learnings: reproduce-before-fixing).
 *
 *   1. kid-confident summits Buena Vista Park (suboptimal — slope). The hill's
 *      ascent cost should dominate, but stop/signal costs on the flat Page St
 *      boulevard + Haight/Fell corridors may exceed it (park paths have zero
 *      controls). Castro → Inner Sunset; assert route does NOT enter the
 *      Buena Vista Park bbox, and report ascent gain.
 *
 *   2. carrying-kid + training abandon the JFK Promenade. GGP is junction-dense
 *      (path forks ~every 100 m); gentle ≥30° bends accumulate turn time +
 *      penalties while Lincoln Way is one same-name corridor paying half signal
 *      waits. Castro → Hook Fish Co; assert promenade usage > ~15% of distance.
 *
 * Tiles fetched through the prod Worker proxy with SYNTHETIC cache keys
 * (`row=<tag>-<row>`) so the worker proxies our exact query body and never
 * touches a real standard tile (a real-key reuse poisoned prod once already).
 *
 * Run: bun scripts/diag-turn-cost-regressions.ts
 */
import { buildRoutingGraph, routeOnGraph, haversineM } from '../src/services/clientRouter'
import { buildQuery } from '../src/services/overpass'
import { getDefaultPreferredItems } from '../src/utils/classify'
import {
  prefetchElevation, lookupElevation, setElevationDecoder, setElevationReferer, wayAscentMeters,
} from '../src/services/elevation'
import type { OsmWay } from '../src/utils/types'
import { PNG } from 'pngjs'

// ── elevation decoder (Bun has no OffscreenCanvas) ──
setElevationDecoder((bytes) => new Promise((resolve) => {
  new PNG().parse(Buffer.from(bytes), (err, data) => {
    if (err || !data) { resolve(null); return }
    resolve(new Uint8ClampedArray(data.data.buffer, data.data.byteOffset, data.data.byteLength))
  })
}))
setElevationReferer('https://bike-map.fryanpan.com/')

const PROXY = 'https://bike-map.fryanpan.com/api/overpass'
const TILE_DEGREES = 0.1

async function fetchTile(tag: string, row: number, col: number): Promise<OsmWay[]> {
  const bbox = { south: row * TILE_DEGREES, north: (row + 1) * TILE_DEGREES, west: col * TILE_DEGREES, east: (col + 1) * TILE_DEGREES }
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch(`${PROXY}?row=${tag}-${row}&col=${col}`, {
      method: 'POST', body: `data=${encodeURIComponent(buildQuery(bbox))}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    if (resp.ok) {
      const data = await resp.json() as { elements: Array<{ type: string; id: number; tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }>; lat?: number; lon?: number }> }
      const ways: OsmWay[] = []
      for (const el of data.elements) {
        if (el.type === 'way' && el.geometry != null) {
          ways.push({ osmId: el.id, coordinates: el.geometry.map((p): [number, number] => [p.lat, p.lon]), tags: el.tags ?? {}, itemName: null })
        } else if (el.type === 'node' && el.lat != null && el.lon != null) {
          // Single-coordinate pseudo-way for traffic-control nodes (mirrors
          // parseOverpassResponse): isControlNode keys off these.
          ways.push({ osmId: el.id, coordinates: [[el.lat, el.lon]], tags: el.tags ?? {}, itemName: null })
        }
      }
      return ways
    }
    await new Promise((r) => setTimeout(r, (attempt + 1) * 2000))
  }
  console.warn(`tile ${tag} ${row}:${col} failed`); return []
}

async function fetchBox(tag: string, b: { south: number; west: number; north: number; east: number }): Promise<OsmWay[]> {
  const tiles: Array<{ row: number; col: number }> = []
  for (let r = Math.floor(b.south / TILE_DEGREES); r <= Math.floor(b.north / TILE_DEGREES); r++)
    for (let c = Math.floor(b.west / TILE_DEGREES); c <= Math.floor(b.east / TILE_DEGREES); c++)
      tiles.push({ row: r, col: c })
  const all: OsmWay[] = []
  for (const t of tiles) { all.push(...await fetchTile(tag, t.row, t.col)); await new Promise((r) => setTimeout(r, 400)) }
  return all
}

// ── Buena Vista Park bbox (route should avoid this) ──
const BVP = { south: 37.766, north: 37.770, west: -122.444, east: -122.437 }
function inBVP(lat: number, lng: number): boolean {
  return lat >= BVP.south && lat <= BVP.north && lng >= BVP.west && lng <= BVP.east
}

function routeAscent(coords: [number, number][]): number {
  // Sum positive elevation deltas along the chosen route polyline.
  const { forwardM } = wayAscentMeters(coords, lookupElevation)
  return forwardM
}

function pedMeters(coords: [number, number][], ways: OsmWay[]): { total: number; ped: number; names: Set<string> } {
  let total = 0, ped = 0; const names = new Set<string>()
  for (let i = 1; i < coords.length; i++) {
    const d = haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]); total += d
    let near: OsmWay | null = null, nd = Infinity
    for (const w of ways) for (const [wl, wn] of w.coordinates) {
      const m = Math.abs(coords[i][0] - wl) + Math.abs(coords[i][1] - wn)
      if (m < nd && m < 0.0004) { nd = m; near = w }
    }
    if (near && near.tags.highway === 'pedestrian') { ped += d; if (near.tags.name) names.add(near.tags.name) }
  }
  return { total, ped, names }
}

// ───────────────── Case 1 — Buena Vista hill ─────────────────
const BV_START = { lat: 37.7605, lng: -122.4311 }   // Castro
const BV_END = { lat: 37.7640, lng: -122.4690 }     // Inner Sunset

async function caseBuenaVista() {
  console.log('\n########## CASE 1: kid-confident Castro → Inner Sunset (Buena Vista hill) ##########')
  const box = {
    south: Math.min(BV_START.lat, BV_END.lat) - 0.02, north: Math.max(BV_START.lat, BV_END.lat) + 0.02,
    west: Math.min(BV_START.lng, BV_END.lng) - 0.02, east: Math.max(BV_START.lng, BV_END.lng) + 0.02,
  }
  const ways = await fetchBox('bvp', box)
  await prefetchElevation({ south: box.south - 0.01, west: box.west - 0.01, north: box.north + 0.01, east: box.east + 0.01 })
  console.log(`fetched ${ways.length} ways`)

  for (const mode of ['kid-confident'] as const) {
    const pref = getDefaultPreferredItems(mode)
    const g = buildRoutingGraph(ways, mode, pref)
    const r = routeOnGraph(g, BV_START.lat, BV_START.lng, BV_END.lat, BV_END.lng, mode, pref)
    if (!r) { console.log(`| ${mode} | NO ROUTE |`); continue }
    const ptsInPark = r.coordinates.filter(([lat, lng]) => inBVP(lat, lng)).length
    const ascent = routeAscent(r.coordinates)
    console.log(`\n${mode}: ${r.distanceKm.toFixed(2)} km, ${(r.durationS / 60).toFixed(0)} min, ${r.turnCount} turns, walk ${(r.walkingPct * 100).toFixed(0)}%`)
    console.log(`  ascent ${ascent.toFixed(0)} m | points inside Buena Vista Park bbox: ${ptsInPark} / ${r.coordinates.length} ${ptsInPark > 0 ? '❌ ENTERS PARK' : '✅ avoids park'}`)
  }
}

// ───────────────── Case 2 — JFK Promenade ─────────────────
const JFK_START = { lat: 37.7607, lng: -122.4310 }   // Castro
const JFK_END = { lat: 37.7624, lng: -122.5069 }     // Hook Fish Co

async function caseJFK() {
  console.log('\n########## CASE 2: carrying-kid + training Castro → Hook Fish Co (JFK Promenade) ##########')
  const box = {
    south: Math.min(JFK_START.lat, JFK_END.lat) - 0.03, north: Math.max(JFK_START.lat, JFK_END.lat) + 0.03,
    west: Math.min(JFK_START.lng, JFK_END.lng) - 0.03, east: Math.max(JFK_START.lng, JFK_END.lng) + 0.03,
  }
  const ways = await fetchBox('jfk', box)
  await prefetchElevation({ south: box.south - 0.01, west: box.west - 0.01, north: box.north + 0.01, east: box.east + 0.01 })
  const pedWays = ways.filter((w) => w.tags.highway === 'pedestrian')
  console.log(`fetched ${ways.length} ways (${pedWays.length} highway=pedestrian)`)
  console.log('| mode | km | min | turns | walk% | promenade m (%) | names |')
  console.log('|---|---|---|---|---|---|---|')
  for (const mode of ['kid-confident', 'carrying-kid', 'training'] as const) {
    const pref = getDefaultPreferredItems(mode)
    const g = buildRoutingGraph(ways, mode, pref)
    const r = routeOnGraph(g, JFK_START.lat, JFK_START.lng, JFK_END.lat, JFK_END.lng, mode, pref)
    if (!r) { console.log(`| ${mode} | NO ROUTE |`); continue }
    const { total, ped, names } = pedMeters(r.coordinates, ways)
    const pct = total > 0 ? 100 * ped / total : 0
    const flag = mode === 'kid-confident' ? '' : pct > 15 ? ' ✅' : ' ❌'
    console.log(`| ${mode} | ${r.distanceKm.toFixed(2)} | ${(r.durationS / 60).toFixed(0)} | ${r.turnCount} | ${(r.walkingPct * 100).toFixed(0)}% | ${ped.toFixed(0)} (${pct.toFixed(0)}%)${flag} | ${[...names].join('; ') || '—'} |`)
  }
}

async function main() {
  await caseBuenaVista()
  await caseJFK()
}
main().catch(console.error)
