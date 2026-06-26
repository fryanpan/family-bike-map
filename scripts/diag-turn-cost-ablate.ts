#!/usr/bin/env bun
/**
 * Ablation: zero each routing-cost component in turn and measure whether the
 * route flips back onto the JFK Promenade (and off Buena Vista Park). Tells us
 * WHICH term (turn time / turn penalty / signal+stop waits / ascent / level
 * multiplier) actually caused the PR #200 regressions — instead of guessing.
 *
 * Run: bun scripts/diag-turn-cost-ablate.ts
 */
import { buildRoutingGraph, routeOnGraph, haversineM } from '../src/services/clientRouter'
import { buildQuery } from '../src/services/overpass'
import { getDefaultPreferredItems } from '../src/utils/classify'
import { MODE_RULES } from '../src/data/modes'
import type { ModeRule, RideMode } from '../src/data/modes'
import {
  prefetchElevation, lookupElevation, setElevationDecoder, setElevationReferer, wayAscentMeters,
} from '../src/services/elevation'
import type { OsmWay } from '../src/utils/types'
import { PNG } from 'pngjs'

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
        if (el.type === 'way' && el.geometry != null) ways.push({ osmId: el.id, coordinates: el.geometry.map((p): [number, number] => [p.lat, p.lon]), tags: el.tags ?? {}, itemName: null })
        else if (el.type === 'node' && el.lat != null && el.lon != null) ways.push({ osmId: el.id, coordinates: [[el.lat, el.lon]], tags: el.tags ?? {}, itemName: null })
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

function pedPct(coords: [number, number][], ways: OsmWay[]): number {
  let total = 0, ped = 0
  for (let i = 1; i < coords.length; i++) {
    const d = haversineM(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]); total += d
    let near: OsmWay | null = null, nd = Infinity
    for (const w of ways) for (const [wl, wn] of w.coordinates) {
      const m = Math.abs(coords[i][0] - wl) + Math.abs(coords[i][1] - wn)
      if (m < nd && m < 0.0004) { nd = m; near = w }
    }
    if (near && near.tags.highway === 'pedestrian') ped += d
  }
  return total > 0 ? 100 * ped / total : 0
}

const BVP = { south: 37.766, north: 37.770, west: -122.444, east: -122.437 }
function bvpPts(coords: [number, number][]): number {
  return coords.filter(([lat, lng]) => lat >= BVP.south && lat <= BVP.north && lng >= BVP.west && lng <= BVP.east).length
}

// A patched copy of MODE_RULES[mode] with the named component zeroed. The
// graph-baked ablations (ascent, level) are done by mutating the global rule
// before buildRoutingGraph; the route-time ones (turn/signal/stop) are read
// from the same global rule by routeOnGraph→resolveRule, so we mutate and
// restore around each build+route.
type Ablation = 'baseline' | 'no-turn-time' | 'no-turn-penalty' | 'no-signal-stop' | 'no-ascent' | 'no-level-mult' | 'no-all-turn-costs'

function patch(rule: ModeRule, ab: Ablation): Partial<ModeRule> {
  switch (ab) {
    case 'no-turn-time': return { turnTimeSec: undefined }
    case 'no-turn-penalty': return { turnPenaltySec: undefined }
    case 'no-signal-stop': return { signalWaitSec: undefined, stopSignWaitSec: undefined }
    case 'no-all-turn-costs': return { turnTimeSec: undefined, turnPenaltySec: undefined, signalWaitSec: undefined, stopSignWaitSec: undefined }
    case 'no-ascent': return { uphillCostSecPerMeter: 0 }
    case 'no-level-mult': return { levelMultipliers: {} }
    default: return {}
  }
}

const JFK_START = { lat: 37.7607, lng: -122.4310 }, JFK_END = { lat: 37.7624, lng: -122.5069 }
const BV_START = { lat: 37.7605, lng: -122.4311 }, BV_END = { lat: 37.7640, lng: -122.4690 }

function runAblations(label: string, ways: OsmWay[], modes: readonly RideMode[], start: { lat: number; lng: number }, end: { lat: number; lng: number }, metric: (coords: [number, number][]) => string) {
  const ABS: Ablation[] = ['baseline', 'no-turn-time', 'no-turn-penalty', 'no-signal-stop', 'no-all-turn-costs', 'no-ascent', 'no-level-mult']
  for (const mode of modes) {
    const pref = getDefaultPreferredItems(mode)
    const orig = { ...MODE_RULES[mode] }
    console.log(`\n${label} — ${mode}`)
    for (const ab of ABS) {
      Object.assign(MODE_RULES[mode], orig, patch(orig, ab))
      const g = buildRoutingGraph(ways, mode, pref)
      const r = routeOnGraph(g, start.lat, start.lng, end.lat, end.lng, mode, pref)
      Object.assign(MODE_RULES[mode], orig)
      if (!r) { console.log(`  ${ab.padEnd(18)} NO ROUTE`); continue }
      console.log(`  ${ab.padEnd(18)} ${r.distanceKm.toFixed(2)}km ${(r.durationS / 60).toFixed(0)}min turns=${String(r.turnCount).padStart(2)} walk=${(r.walkingPct * 100).toFixed(0)}%  ${metric(r.coordinates)}`)
    }
  }
}

async function main() {
  console.log('\n########## JFK ablation (Castro → Hook Fish Co) ##########')
  const jbox = { south: 37.73, north: 37.80, west: -122.54, east: -122.40 }
  const jways = await fetchBox('ajfk', jbox)
  await prefetchElevation({ south: jbox.south - 0.01, west: jbox.west - 0.01, north: jbox.north + 0.01, east: jbox.east + 0.01 })
  console.log(`fetched ${jways.length} ways`)
  runAblations('JFK', jways, ['carrying-kid', 'training'], JFK_START, JFK_END, (c) => `promenade=${pedPct(c, jways).toFixed(0)}%`)

  console.log('\n\n########## Buena Vista ablation (Castro → Inner Sunset) ##########')
  const bbox = { south: 37.74, north: 37.79, west: -122.49, east: -122.41 }
  const bways = await fetchBox('abv', bbox)
  await prefetchElevation({ south: bbox.south - 0.01, west: bbox.west - 0.01, north: bbox.north + 0.01, east: bbox.east + 0.01 })
  console.log(`fetched ${bways.length} ways`)
  runAblations('BV', bways, ['kid-confident'], BV_START, BV_END, (c) => {
    const asc = wayAscentMeters(c, lookupElevation).forwardM
    return `inPark=${bvpPts(c)} ascent=${asc.toFixed(0)}m`
  })
}
main().catch(console.error)
