#!/usr/bin/env bun
/**
 * Does the in-app `getTilesForCorridor` graph produce a different route
 * than the whole-Berlin graph for the same pair? This probe runs Home →
 * Stadtbad Neukölln on both graph sizes and prints the chosen path for
 * each.
 */

import ngraphPath from 'ngraph.path'
const aStar = ngraphPath.aStar
import { buildRoutingGraph, haversineM } from '../src/services/clientRouter'
import { buildQuery, classifyOsmTagsToItem } from '../src/services/overpass'
import { getDefaultPreferredItems } from '../src/utils/classify'
import { classifyEdge } from '../src/utils/lts'
import { MODE_RULES } from '../src/data/modes'
import type { OsmWay, LegendItem } from '../src/utils/types'

const OVERPASS_URL = 'https://bike-map.fryanpan.com/api/overpass'
const TILE_DEG = 0.1
const MODE = 'kid-confident' as const

const SCHOOL   = { lat: 52.5105, lng: 13.4247 }
const STADTBAD = { lat: 52.4750, lng: 13.4338 }

async function fetchTile(row: number, col: number): Promise<OsmWay[]> {
  const bbox = { south: row * TILE_DEG, north: (row + 1) * TILE_DEG, west: col * TILE_DEG, east: (col + 1) * TILE_DEG }
  const query = buildQuery(bbox)
  const resp = await fetch(`${OVERPASS_URL}?row=${row}&col=${col}`, {
    method: 'POST', body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  if (!resp.ok) return []
  const data = await resp.json() as { elements: Array<{ type: string; id: number; tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> }> }
  return data.elements.filter((el) => el.type === 'way' && el.geometry != null).map((el) => ({
    osmId: el.id,
    coordinates: el.geometry!.map((pt): [number, number] => [pt.lat, pt.lon]),
    tags: el.tags ?? {},
    itemName: null as LegendItem | null,
  }))
}

async function fetchBbox(south: number, west: number, north: number, east: number): Promise<OsmWay[]> {
  const minRow = Math.floor(south / TILE_DEG), maxRow = Math.floor(north / TILE_DEG)
  const minCol = Math.floor(west  / TILE_DEG), maxCol = Math.floor(east  / TILE_DEG)
  const tiles: Array<[number, number]> = []
  for (let r = minRow; r <= maxRow; r++) for (let c = minCol; c <= maxCol; c++) tiles.push([r, c])
  console.error(`  ${tiles.length} tiles`)
  const out: OsmWay[] = []
  for (let i = 0; i < tiles.length; i += 2) {
    const batch = tiles.slice(i, i + 2)
    const results = await Promise.all(batch.map(([r, c]) => fetchTile(r, c)))
    for (const ws of results) out.push(...ws)
    if (i + 2 < tiles.length) await new Promise((r) => setTimeout(r, 400))
  }
  return out
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function routeAndSummarize(graph: any, from: {lat:number;lng:number}, to: {lat:number;lng:number}, label: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nearest = (lat: number, lng: number) => {
    let best: string | null = null, bd = Infinity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graph.forEachNode((n: any) => {
      const d = haversineM(lat, lng, n.data.lat, n.data.lng)
      if (d < bd) { bd = d; best = n.id as string }
    })
    return best!
  }
  const sId = nearest(from.lat, from.lng), eId = nearest(to.lat, to.lng)
  const maxSpeedMs = MODE_RULES[MODE].ridingSpeedKmh / 3.6
  const pf = aStar(graph, {
    oriented: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    distance: (_f: any, _t: any, link: any) => link.data.cost,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    heuristic: (f: any, t: any) => haversineM(f.data.lat, f.data.lng, t.data.lat, t.data.lng) / maxSpeedMs,
  })
  const path = pf.find(sId, eId)
  if (!path || path.length === 0) { console.log(`  ${label}: NO PATH`); return }
  const nodes = [...path].reverse()
  let totalDist = 0, totalCost = 0, walkDist = 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wayHits: Array<{ id: number; name: string; hw: string; dist: number; walk: boolean; br: string | null; surface: string | null }> = []
  for (let i = 1; i < nodes.length; i++) {
    const link = graph.getLink(nodes[i - 1].id, nodes[i].id)
    if (!link) continue
    const ld = link.data
    totalDist += ld.distance
    totalCost += ld.cost
    if (ld.isWalking) walkDist += ld.distance
    const last = wayHits[wayHits.length - 1]
    if (last && last.id === ld.wayId) {
      last.dist += ld.distance
      last.walk = last.walk || ld.isWalking
    } else {
      wayHits.push({
        id: ld.wayId,
        name: ld.wayTags.name ?? '',
        hw: ld.wayTags.highway ?? '',
        dist: ld.distance,
        walk: !!ld.isWalking,
        br: ld.wayTags.bicycle_road ?? ld.wayTags.cyclestreet ?? null,
        surface: ld.wayTags.surface ?? null,
      })
    }
  }
  console.log(`  ${label}: ${(totalDist/1000).toFixed(2)}km, ${(totalCost/60).toFixed(1)}min, walked ${(walkDist/1000).toFixed(2)}km (${((walkDist/totalDist)*100).toFixed(0)}%)`)
  // Print only named ways, so we see the corridor:
  const named = wayHits.filter((w) => w.name)
  console.log(`  Named ways on path:`)
  let cur = ''
  let accDist = 0
  for (const w of named) {
    if (w.name !== cur) {
      if (cur) console.log(`    ${cur.padEnd(24)}  ${accDist.toFixed(0).padStart(5)}m`)
      cur = w.name
      accDist = 0
    }
    accDist += w.dist
  }
  if (cur) console.log(`    ${cur.padEnd(24)}  ${accDist.toFixed(0).padStart(5)}m`)
}

async function main() {
  console.error('\n=== A) Corridor graph (like the live app: start+end ± 0.05°) ===')
  const south = Math.min(SCHOOL.lat, STADTBAD.lat) - 0.05
  const north = Math.max(SCHOOL.lat, STADTBAD.lat) + 0.05
  const west  = Math.min(SCHOOL.lng, STADTBAD.lng) - 0.05
  const east  = Math.max(SCHOOL.lng, STADTBAD.lng) + 0.05
  const corridorWays = await fetchBbox(south, west, north, east)
  const preferred = getDefaultPreferredItems(MODE)
  const corridorGraph = buildRoutingGraph(corridorWays, MODE, preferred)
  console.error(`  ${corridorWays.length} ways, nodes=${corridorGraph.getNodeCount()}, edges=${corridorGraph.getLinkCount()}`)
  routeAndSummarize(corridorGraph, SCHOOL, STADTBAD, 'corridor')

  console.error('\n=== B) Whole-Berlin graph (like the benchmark) ===')
  const fullWays = await fetchBbox(52.34, 13.08, 52.68, 13.80)
  const fullGraph = buildRoutingGraph(fullWays, MODE, preferred)
  console.error(`  ${fullWays.length} ways, nodes=${fullGraph.getNodeCount()}, edges=${fullGraph.getLinkCount()}`)
  routeAndSummarize(fullGraph, SCHOOL, STADTBAD, 'full-berlin')
}

main().catch((e) => { console.error(e); process.exit(1) })
