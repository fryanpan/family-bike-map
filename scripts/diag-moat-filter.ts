#!/usr/bin/env bun
/**
 * Steep-moat filter diagnostic: run the PRODUCTION classify + gradient +
 * moat functions (classifyOsmTagsToItem / overlayGradientPct /
 * computeMoatIsolation) over real OSM + terrain tiles and report how much
 * painted car-free length the moat filter hides.
 *
 * Two regions:
 *  (a) Marin Headlands — hilly; the plan expects >50% of painted car-free
 *      length hidden at kid-confident (strict mode, pushBudgetM=0).
 *  (b) Flat central SF (Wiggle / Panhandle / Mission) — expects ~0% hidden.
 *
 * Each region is reported under two isTileLoaded variants:
 *  - production: only the fetched tile grid is "loaded", so components
 *    touching the outermost fetched tiles get the edge fail-soft (kept).
 *  - full-coverage: every tile reports loaded → no tile is outermost → pure
 *    connectivity, i.e. the algorithm's raw discrimination power.
 *
 * Run: bun scripts/diag-moat-filter.ts
 */
import {
  buildQuery, tileKey, classifyOsmTagsToItem, isOverlayCrossing, isOverlayHiddenSurface,
} from '../src/services/overpass'
import { getDefaultPreferredItems, getOverlayMaxGradientPct } from '../src/utils/classify'
import { classifyEdge } from '../src/utils/lts'
import {
  prefetchElevation, overlayGradientPct, setElevationDecoder, setElevationReferer,
} from '../src/services/elevation'
import { computeMoatIsolation } from '../src/services/overlayReachability'
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

const PROFILE_KEY = 'kid-confident'

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

// Fetch every 0.1° OSM tile in [rows] × [cols]; returns the ways deduped by
// osmId (a way crossing a tile border appears in both tiles' payloads) plus
// the loaded-tile key set that feeds the moat filter's edge fail-soft.
async function fetchGrid(
  tag: string, rows: [number, number], cols: [number, number],
): Promise<{ ways: OsmWay[]; loadedKeys: Set<string> }> {
  const byId = new Map<number, OsmWay>()
  const loadedKeys = new Set<string>()
  for (let r = rows[0]; r <= rows[1]; r++) {
    for (let c = cols[0]; c <= cols[1]; c++) {
      const tileWays = await fetchTile(tag, r, c)
      loadedKeys.add(tileKey(r, c))
      for (const w of tileWays) if (!byId.has(w.osmId)) byId.set(w.osmId, w)
      await new Promise((res) => setTimeout(res, 400))
    }
  }
  return { ways: [...byId.values()], loadedKeys }
}

// Local equirectangular metres — same private pattern as elevation.ts.
function segMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const meanLat = ((lat1 + lat2) / 2) * (Math.PI / 180)
  const x = dLng * Math.cos(meanLat)
  return Math.sqrt(dLat * dLat + x * x) * R
}

function wayLengthM(coords: Array<[number, number]>): number {
  let m = 0
  for (let i = 1; i < coords.length; i++) m += segMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
  return m
}

interface Bbox { south: number; north: number; west: number; east: number }

function midpointIn(way: OsmWay, b: Bbox): boolean {
  const [lat, lng] = way.coordinates[Math.floor(way.coordinates.length / 2)]
  return lat >= b.south && lat <= b.north && lng >= b.west && lng <= b.east
}

function wayLabel(w: OsmWay): string {
  const name = w.tags.name ?? `(${w.tags.highway ?? '?'})`
  return `${name} [${w.osmId}]`
}

function analyze(label: string, ways: OsmWay[], loadedKeys: Set<string>, statsBbox: Bbox) {
  const preferred = getDefaultPreferredItems(PROFILE_KEY)
  const maxGradientPct = getOverlayMaxGradientPct(PROFILE_KEY)

  // Same per-way gradient cache the overlay keeps (gradient depends only
  // on geometry + elevation, shared across the paint gate and the moat).
  const gradientCache = new Map<number, number>()
  const gradientPct = (way: OsmWay): number | null => {
    let g = gradientCache.get(way.osmId) ?? null
    if (g == null) {
      g = overlayGradientPct(way.coordinates)
      if (g != null) gradientCache.set(way.osmId, g)
    }
    return g
  }

  // Mirror of BikeMapOverlay pass 0 (no region rules — global legend).
  const painted = (way: OsmWay): boolean => {
    if (way.coordinates.length < 2) return false
    if (classifyEdge(way.tags).pathLevel === '4') return false
    if (isOverlayCrossing(way.tags)) return false
    if (isOverlayHiddenSurface(way.tags)) return false
    const itemName = classifyOsmTagsToItem(way.tags, PROFILE_KEY)
    if (itemName == null || !preferred.has(itemName)) return false
    const g = gradientPct(way)
    return !(g != null && g > maxGradientPct)
  }

  // Painted car-free ways inside the stats bbox (moat runs on ALL ways —
  // every highway class is a potential connector).
  const paintedCarFree = ways.filter((w) =>
    midpointIn(w, statsBbox) && painted(w) && classifyEdge(w.tags).carFree)
  const totalM = paintedCarFree.reduce((s, w) => s + wayLengthM(w.coordinates), 0)
  console.log(`\n${label} — kid-confident (ceiling ${maxGradientPct}%, pushBudgetM=0)`)
  console.log(`  painted car-free: ${paintedCarFree.length} ways, ${(totalM / 1000).toFixed(1)} km`)

  const variants: Array<[string, (row: number, col: number) => boolean]> = [
    ['production   ', (row, col) => loadedKeys.has(tileKey(row, col))],
    ['full-coverage', () => true],
  ]
  for (const [name, isTileLoaded] of variants) {
    const isolated = computeMoatIsolation(ways, { maxGradientPct, pushBudgetM: 0, gradientPct, isTileLoaded })
    const hidden = paintedCarFree.filter((w) => isolated.has(w.osmId))
    const hiddenM = hidden.reduce((s, w) => s + wayLengthM(w.coordinates), 0)
    const pct = totalM > 0 ? (100 * hiddenM / totalM) : 0
    console.log(`  ${name}  hidden: ${hidden.length} ways, ${(hiddenM / 1000).toFixed(1)} km (${pct.toFixed(0)}% of painted car-free length)`)
    const kept = paintedCarFree.filter((w) => !isolated.has(w.osmId))
    const namedFirst = (a: OsmWay, b: OsmWay) => Number(b.tags.name != null) - Number(a.tags.name != null)
    console.log(`    sample hidden: ${hidden.sort(namedFirst).slice(0, 10).map(wayLabel).join(', ') || '(none)'}`)
    console.log(`    sample kept:   ${kept.sort(namedFirst).slice(0, 10).map(wayLabel).join(', ') || '(none)'}`)
  }
}

async function main() {
  console.log('########## (a) Marin Headlands ##########')
  // Fetch a 3×4 grid so the headlands tiles (row 378, cols -1226/-1225) are
  // INTERIOR — otherwise every component touches an outermost tile and the
  // edge fail-soft keeps everything. Row 377 = north SF, row 379 = Mill
  // Valley / Tiburon; the mainland street grid is well represented.
  const marin = await fetchGrid('moatm', [377, 379], [-1227, -1224])
  console.log(`fetched ${marin.ways.length} ways`)
  await prefetchElevation({ south: 37.69, west: -122.71, north: 38.01, east: -122.39 })
  analyze('Marin Headlands', marin.ways, marin.loadedKeys,
    { south: 37.81, north: 37.90, west: -122.60, east: -122.47 })

  console.log('\n\n########## (b) Flat central SF ##########')
  // 1×2 grid (Wiggle / Panhandle / Mission / JFK-east). Both tiles are
  // outermost, so the production variant is trivially all-kept; the
  // full-coverage variant is the meaningful ~0% check here.
  const sf = await fetchGrid('moats', [377, 377], [-1225, -1224])
  console.log(`fetched ${sf.ways.length} ways`)
  await prefetchElevation({ south: 37.69, west: -122.51, north: 37.81, east: -122.29 })
  analyze('Flat central SF', sf.ways, sf.loadedKeys,
    { south: 37.75, north: 37.79, west: -122.47, east: -122.41 })
}
main().catch(console.error)
