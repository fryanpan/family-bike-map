#!/usr/bin/env bun
/**
 * Diagnostic for the "car-free / shared-use foot paths no longer preferred"
 * bug, spanning SF (JFK Promenade) and Berlin (Treptower Park).
 *
 * Part A — does the Hancock St → Hook Fish Co route use the car-free JFK
 * Promenade? Fetches the corridor with OLD vs NEW buildQuery and routes.
 *
 * Part B — for Treptower Park, replicate the BikeMapOverlay filter chain over
 * real OSM + real Mapbox elevation and report, per fetched way, which gate (if
 * any) drops it from the browse overlay for kid-confident.
 *
 * Tiles are fetched through the production Worker proxy (Cloudflare egress —
 * not IP-rate-limited like a local Overpass call) with synthetic cache keys so
 * the worker always proxies our exact query body instead of serving a cached
 * standard tile.
 *
 * Run: bun scripts/diag-jfk-route.ts
 */
import { buildRoutingGraph, routeOnGraph, haversineM } from '../src/services/clientRouter'
import {
  buildQuery, classifyOsmTagsToItem, isOverlayCrossing, isOverlayHiddenSurface, isRoughSurface,
} from '../src/services/overpass'
import { getDefaultPreferredItems, getOverlayMaxGradientPct, getDisplayPathLevel } from '../src/utils/classify'
import { classifyEdge } from '../src/utils/lts'
import {
  prefetchElevation, overlayGradientPct, setElevationDecoder, setElevationReferer,
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
const MODES = ['kid-starting-out', 'kid-confident', 'kid-traffic-savvy', 'carrying-kid', 'training'] as const

function oldQuery(b: { south: number; west: number; north: number; east: number }): string {
  const bb = `${b.south},${b.west},${b.north},${b.east}`
  return `
[out:json][timeout:25];
(
  way["highway"="cycleway"](${bb});
  way["bicycle_road"="yes"](${bb});
  way["highway"="living_street"](${bb});
  way["highway"~"^(residential|path|track)$"]["bicycle"!="no"](${bb});
  way["highway"="footway"]["bicycle"~"^(yes|designated)$"](${bb});
  way[~"^cycleway(:right|:left|:both)?$"~"^(track|lane|opposite_track|opposite_lane|share_busway)$"](${bb});
);
out geom;
`
}

async function fetchTile(tag: string, row: number, col: number, q: (b: any) => string): Promise<OsmWay[]> {
  const bbox = { south: row * TILE_DEGREES, north: (row + 1) * TILE_DEGREES, west: col * TILE_DEGREES, east: (col + 1) * TILE_DEGREES }
  for (let attempt = 0; attempt < 4; attempt++) {
    const resp = await fetch(`${PROXY}?row=${tag}-${row}&col=${col}`, {
      method: 'POST', body: `data=${encodeURIComponent(q(bbox))}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    if (resp.ok) {
      const data = await resp.json() as { elements: Array<{ type: string; id: number; tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> }> }
      return data.elements.filter((el) => el.type === 'way' && el.geometry != null)
        .map((el) => ({ osmId: el.id, coordinates: el.geometry!.map((p): [number, number] => [p.lat, p.lon]), tags: el.tags ?? {}, itemName: null }))
    }
    await new Promise((r) => setTimeout(r, (attempt + 1) * 2000))
  }
  console.warn(`tile ${tag} ${row}:${col} failed`); return []
}

async function fetchBox(tag: string, b: { south: number; west: number; north: number; east: number }, q: (x: any) => string): Promise<OsmWay[]> {
  const tiles: Array<{ row: number; col: number }> = []
  for (let r = Math.floor(b.south / TILE_DEGREES); r <= Math.floor(b.north / TILE_DEGREES); r++)
    for (let c = Math.floor(b.west / TILE_DEGREES); c <= Math.floor(b.east / TILE_DEGREES); c++)
      tiles.push({ row: r, col: c })
  const all: OsmWay[] = []
  for (const t of tiles) { all.push(...await fetchTile(tag, t.row, t.col, q)); await new Promise((r) => setTimeout(r, 400)) }
  return all
}

// ───────────────── Part A — JFK route ─────────────────
const START = { lat: 37.7607, lng: -122.4310 }
const END = { lat: 37.7624, lng: -122.5069 }

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

async function partA() {
  const box = { south: Math.min(START.lat, END.lat) - 0.05, north: Math.max(START.lat, END.lat) + 0.05, west: Math.min(START.lng, END.lng) - 0.05, east: Math.max(START.lng, END.lng) + 0.05 }
  console.log('\n########## PART A: JFK route (118 Hancock → Hook Fish Co) ##########')
  for (const [label, q] of [['OLD query', oldQuery], ['NEW query', buildQuery]] as const) {
    const ways = await fetchBox(label === 'OLD query' ? 'jfkold' : 'jfknew', box, q)
    const pedWays = ways.filter((w) => w.tags.highway === 'pedestrian')
    console.log(`\n--- ${label} --- (${ways.length} ways, ${pedWays.length} highway=pedestrian)`)
    console.log('| mode | found | km | min | walk% | promenade m (%) | names |')
    console.log('|---|---|---|---|---|---|---|')
    for (const mode of MODES) {
      const pref = getDefaultPreferredItems(mode)
      const g = buildRoutingGraph(ways, mode, pref)
      const r = routeOnGraph(g, START.lat, START.lng, END.lat, END.lng, mode, pref)
      if (!r) { console.log(`| ${mode} | NO | - | - | - | - | - |`); continue }
      const { total, ped, names } = pedMeters(r.coordinates, ways)
      console.log(`| ${mode} | yes | ${r.distanceKm.toFixed(2)} | ${(r.durationS / 60).toFixed(0)} | ${(r.walkingPct * 100).toFixed(0)}% | ${ped.toFixed(0)} (${(100 * ped / total).toFixed(0)}%) | ${[...names].join('; ') || '—'} |`)
    }
  }
}

// ───────────────── Part B — Treptower overlay filter chain ─────────────────
const TREP = { south: 52.487, west: 13.456, north: 52.497, east: 13.473 }

async function partB() {
  console.log('\n########## PART B: Treptower overlay filter chain (kid-confident) ##########')
  const ways = await fetchBox('trep', TREP, buildQuery)
  console.log(`fetched ${ways.length} ways`)
  await prefetchElevation({ south: TREP.south - 0.01, west: TREP.west - 0.01, north: TREP.north + 0.01, east: TREP.east + 0.01 })

  const mode = 'kid-confident'
  const pref = getDefaultPreferredItems(mode)
  const maxGrad = getOverlayMaxGradientPct(mode)
  const drop = { lts4: 0, crossing: 0, roughSurface: 0, notPreferred: 0, tooSteep: 0, shown: 0 }
  const shownByItem: Record<string, number> = {}
  const steepExamples: string[] = []
  for (const w of ways) {
    const { pathLevel } = classifyEdge(w.tags)
    if (pathLevel === '4') { drop.lts4++; continue }
    if (isOverlayCrossing(w.tags)) { drop.crossing++; continue }
    if (isOverlayHiddenSurface(w.tags)) { drop.roughSurface++; continue }
    const itemName = classifyOsmTagsToItem(w.tags, mode)
    const isPref = itemName !== null && pref.has(itemName)
    if (!isPref) { drop.notPreferred++; continue }
    const gp = overlayGradientPct(w.coordinates)
    if (gp != null && gp > maxGrad) {
      drop.tooSteep++
      if (steepExamples.length < 8) steepExamples.push(`way ${w.osmId} ${w.tags.highway} ${itemName} grad=${gp.toFixed(1)}% surf=${w.tags.surface}`)
      continue
    }
    drop.shown++
    shownByItem[itemName!] = (shownByItem[itemName!] ?? 0) + 1
  }
  console.log('drop reasons:', JSON.stringify(drop, null, 0))
  console.log('shown by item:', JSON.stringify(shownByItem))
  if (steepExamples.length) { console.log('examples hidden as too-steep:'); steepExamples.forEach((e) => console.log('  ' + e)) }
}

async function main() {
  await partA()
  await partB()
}
main().catch(console.error)
