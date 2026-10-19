#!/usr/bin/env bun
/**
 * Spot-check for Joanna's own case (2026-04-29): training mode from Dresdener
 * Str in Kreuzberg to Rudower Chaussee took the painted lanes along major
 * roads rather than the bike paths, because training's `levelMultipliers` was
 * empty and so every tier it accepts cost the same per metre.
 *
 * The benchmark gate measures 22 fixed Berlin pairs and this corridor is not
 * one of them, so this is the only check that speaks to the case the research
 * actually described. It reports the preferred share and the per-item
 * breakdown, which is where the change shows up: distance on "Painted bike
 * lane on major road" should fall.
 *
 *   bun scripts/diag-rudower-training.ts
 */
import { buildQuery, latLngToTile, injectCachedTile } from '../src/services/overpass'
import { clientRoute } from '../src/services/clientRouter'
import { getDefaultPreferredItems, getLegendItem } from '../src/utils/classify'
import type { OsmWay } from '../src/utils/types'

// The Worker proxy, so this measures what production fetches, including its
// Overpass endpoint fallback.
const OVERPASS_URL = 'https://bike-map.fryanpan.com/api/overpass'
const TILE_DEG = 0.1

// Bryan corrected the start on 2026-04-29: the first run used Brandenburg
// Gate, which was a saved Home in localStorage and not the trip he meant.
const START = { lat: 52.5020, lng: 13.4350, label: 'Dresdener Str 112, Kreuzberg' }
const END = { lat: 52.4332, lng: 13.5362, label: 'Rudower Chaussee 12' }
const MODES = ['training', 'kid-traffic-savvy'] as const

function metres(a: [number, number], b: [number, number]): number {
  const R = 6_371_000
  const dLat = ((b[0] - a[0]) * Math.PI) / 180
  const dLng = ((b[1] - a[1]) * Math.PI) / 180
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

async function fetchTile(row: number, col: number): Promise<OsmWay[]> {
  const bbox = {
    south: row * TILE_DEG,
    north: (row + 1) * TILE_DEG,
    west: col * TILE_DEG,
    east: (col + 1) * TILE_DEG,
  }
  const resp = await fetch(`${OVERPASS_URL}?row=${row}&col=${col}`, {
    method: 'POST',
    body: `data=${encodeURIComponent(buildQuery(bbox))}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  if (!resp.ok) {
    console.error(`  tile ${row},${col}: HTTP ${resp.status}`)
    return []
  }
  const data = (await resp.json()) as {
    elements: Array<{
      type: string
      id: number
      tags?: Record<string, string>
      geometry?: Array<{ lat: number; lon: number }>
      lat?: number
      lon?: number
    }>
  }
  const ways: OsmWay[] = []
  for (const e of data.elements) {
    if (e.type === 'way' && e.geometry) {
      ways.push({
        itemName: null,
        osmId: e.id,
        coordinates: e.geometry.map((p): [number, number] => [p.lat, p.lon]),
        tags: e.tags ?? {},
      })
    } else if (e.type === 'node' && e.lat != null && e.lon != null) {
      // Traffic-signal and stop nodes ride the tile payload as
      // single-coordinate pseudo-ways; buildRoutingGraph picks them up with
      // isControlNode. Keeping them is what makes the control waits and the
      // unsignalized-crossing charge measurable here.
      ways.push({ itemName: null, osmId: e.id, coordinates: [[e.lat, e.lon]], tags: e.tags ?? {} })
    }
  }
  return ways
}

const startTile = latLngToTile(START.lat, START.lng)
const endTile = latLngToTile(END.lat, END.lng)
const tiles: Array<{ row: number; col: number }> = []
for (let r = Math.min(startTile.row, endTile.row) - 1; r <= Math.max(startTile.row, endTile.row) + 1; r++) {
  for (let c = Math.min(startTile.col, endTile.col) - 1; c <= Math.max(startTile.col, endTile.col) + 1; c++) {
    tiles.push({ row: r, col: c })
  }
}

console.log(`${START.label} -> ${END.label}`)
console.log(`Pre-fetching ${tiles.length} tiles`)
let total = 0
for (const t of tiles) {
  const ways = await fetchTile(t.row, t.col)
  injectCachedTile(t.row, t.col, ways)
  total += ways.length
}
console.log(`${total} ways + control nodes cached\n`)

for (const mode of MODES) {
  const prefs = getDefaultPreferredItems(mode)
  const route = await clientRoute(START.lat, START.lng, END.lat, END.lng, mode, prefs)
  console.log(`=== ${mode}`)
  if (!route) {
    console.log('  NO ROUTE')
    continue
  }
  console.log(
    `  ${(route.summary.distance / 1000).toFixed(2)} km, ${(route.summary.duration / 60).toFixed(0)} min, ${route.segments?.length ?? 0} segments`,
  )

  let preferredM = 0
  let otherM = 0
  let walkM = 0
  const byItem: Record<string, number> = {}
  for (const seg of route.segments ?? []) {
    let lenM = 0
    for (let i = 1; i < seg.coordinates.length; i++) lenM += metres(seg.coordinates[i - 1], seg.coordinates[i])
    if (seg.isWalking) walkM += lenM
    else if (seg.itemName && prefs.has(seg.itemName)) preferredM += lenM
    else otherM += lenM
    const key = seg.isWalking ? '(walking)' : (seg.itemName ?? '(unclassified)')
    byItem[key] = (byItem[key] ?? 0) + lenM
  }
  const sum = preferredM + otherM + walkM
  console.log(`  preferred ${((preferredM / sum) * 100).toFixed(1)}%   other ${((otherM / sum) * 100).toFixed(1)}%   walking ${((walkM / sum) * 100).toFixed(1)}%`)
  for (const [item, m] of Object.entries(byItem).sort((a, b) => b[1] - a[1])) {
    const pref = item.startsWith('(') ? '-' : prefs.has(item) ? 'yes' : 'no'
    const lvl = item.startsWith('(') ? '-' : (getLegendItem(item, mode)?.level ?? '-')
    console.log(`    ${item.padEnd(42)} ${(m / 1000).toFixed(2).padStart(6)} km  lvl=${String(lvl).padEnd(3)} preferred=${pref}`)
  }
  console.log()
}
