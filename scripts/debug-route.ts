#!/usr/bin/env bun
/**
 * Debug a single route: build the Berlin graph for a given mode, route
 * origin→dest, and dump every chosen edge (way-id, tags, cost) plus every
 * near-the-path way that was NOT chosen. Helps answer "why did the router
 * take that detour?"
 *
 * Usage (default is School → Stadtbad Neukölln, kid-confident):
 *   bun scripts/debug-route.ts
 *   bun scripts/debug-route.ts --origin=52.5105,13.4247 --dest=52.4792,13.4397 --mode=kid-confident
 */

import ngraphPath from 'ngraph.path'
const aStar = ngraphPath.aStar
import { buildRoutingGraph, haversineM } from '../src/services/clientRouter'
import { buildQuery, classifyOsmTagsToItem } from '../src/services/overpass'
import { getDefaultPreferredItems } from '../src/utils/classify'
import { classifyEdge } from '../src/utils/lts'
import type { OsmWay, LegendItem } from '../src/utils/types'

const OVERPASS_URL = 'https://bike-map.fryanpan.com/api/overpass'
const TILE_DEG = 0.1
const BERLIN_BBOX = { south: 52.34, west: 13.08, north: 52.68, east: 13.80 }

type ModeKey =
  | 'kid-starting-out' | 'kid-confident' | 'kid-traffic-savvy'
  | 'carrying-kid' | 'training'

interface Args {
  origin: [number, number]
  dest: [number, number]
  mode: ModeKey
}

function parseArgs(): Args {
  const get = (k: string, d: string) =>
    process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d
  const [oLat, oLng] = get('origin', '52.5105,13.4247').split(',').map(parseFloat) // School
  const [dLat, dLng] = get('dest',   '52.4792,13.4397').split(',').map(parseFloat) // Stadtbad Neukölln
  const mode = get('mode', 'kid-confident') as ModeKey
  return { origin: [oLat, oLng], dest: [dLat, dLng], mode }
}

async function fetchTile(row: number, col: number): Promise<OsmWay[]> {
  const bbox = { south: row * TILE_DEG, north: (row + 1) * TILE_DEG, west: col * TILE_DEG, east: (col + 1) * TILE_DEG }
  const query = buildQuery(bbox)
  const resp = await fetch(`${OVERPASS_URL}?row=${row}&col=${col}`, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  if (!resp.ok) return []
  const data = await resp.json() as { elements: Array<{ type: string; id: number; tags?: Record<string, string>; geometry?: Array<{ lat: number; lon: number }> }> }
  return data.elements
    .filter((el) => el.type === 'way' && el.geometry != null)
    .map((el) => ({
      osmId: el.id,
      coordinates: el.geometry!.map((pt): [number, number] => [pt.lat, pt.lon]),
      tags: el.tags ?? {},
      itemName: null as LegendItem | null,
    }))
}

async function fetchAllTiles(): Promise<OsmWay[]> {
  const minRow = Math.floor(BERLIN_BBOX.south / TILE_DEG)
  const maxRow = Math.floor(BERLIN_BBOX.north / TILE_DEG)
  const minCol = Math.floor(BERLIN_BBOX.west  / TILE_DEG)
  const maxCol = Math.floor(BERLIN_BBOX.east  / TILE_DEG)
  const out: OsmWay[] = []
  const tiles: Array<[number, number]> = []
  for (let r = minRow; r <= maxRow; r++)
    for (let c = minCol; c <= maxCol; c++) tiles.push([r, c])
  console.error(`Fetching ${tiles.length} tiles…`)
  for (let i = 0; i < tiles.length; i += 2) {
    const batch = tiles.slice(i, i + 2)
    const results = await Promise.all(batch.map(([r, c]) => fetchTile(r, c)))
    for (const ways of results) out.push(...ways)
    if (i + 2 < tiles.length) await new Promise((r) => setTimeout(r, 400))
  }
  console.error(`  ${out.length} ways fetched`)
  return out
}

async function main() {
  const { origin, dest, mode } = parseArgs()
  console.log(`\nRoute: (${origin.join(',')}) → (${dest.join(',')}) · mode=${mode}\n`)

  const ways = await fetchAllTiles()
  const preferred = getDefaultPreferredItems(mode)
  console.error(`Building graph…`)
  const graph = buildRoutingGraph(ways, mode, preferred)
  console.error(`  nodes=${graph.getNodeCount()}, edges=${graph.getLinkCount()}`)

  // Find nearest node to start/end
  const nearestNode = (lat: number, lng: number) => {
    let best: string | null = null, bestD = Infinity
    graph.forEachNode((n) => {
      const d = haversineM(lat, lng, n.data.lat, n.data.lng)
      if (d < bestD) { bestD = d; best = n.id as string }
    })
    return { id: best, dist: bestD }
  }
  const s = nearestNode(origin[0], origin[1])
  const d = nearestNode(dest[0], dest[1])
  console.log(`Start node ${s.id} (${s.dist.toFixed(0)}m from origin)`)
  console.log(`End   node ${d.id} (${d.dist.toFixed(0)}m from dest)\n`)

  // Run A* with same config as routeOnGraph
  const { MODE_RULES } = await import('../src/data/modes')
  const maxSpeedMs = MODE_RULES[mode].ridingSpeedKmh / 3.6
  const pf = aStar(graph, {
    oriented: true,
    distance: (_f, _t, link: any) => link.data.cost,
    heuristic: (f: any, t: any) => haversineM(f.data.lat, f.data.lng, t.data.lat, t.data.lng) / maxSpeedMs,
  })
  const path = pf.find(s.id!, d.id!)
  if (!path || path.length === 0) { console.log('NO PATH'); return }
  const nodes = [...path].reverse()

  // Walk edges, aggregate by way-id
  interface EdgeUsage { wayId: number; tags: Record<string,string>; distance: number; cost: number; isWalking: boolean }
  const edges: EdgeUsage[] = []
  let totalDist = 0, totalCost = 0, totalWalk = 0
  for (let i = 1; i < nodes.length; i++) {
    const link = graph.getLink(nodes[i - 1].id, nodes[i].id)
    if (!link) continue
    const ld = link.data as any
    edges.push({ wayId: ld.wayId, tags: ld.wayTags, distance: ld.distance, cost: ld.cost, isWalking: !!ld.isWalking })
    totalDist += ld.distance
    totalCost += ld.cost
    if (ld.isWalking) totalWalk += ld.distance
  }
  console.log(`Path: ${nodes.length} nodes, ${edges.length} edges, ${(totalDist/1000).toFixed(2)} km, walking=${(totalWalk/1000).toFixed(2)}km, cost=${totalCost.toFixed(0)}s`)

  // Group by way-id for readability
  const byWay = new Map<number, EdgeUsage[]>()
  for (const e of edges) {
    const arr = byWay.get(e.wayId) ?? []
    arr.push(e)
    byWay.set(e.wayId, arr)
  }
  const waySummaries = [...byWay.entries()].map(([wayId, es]) => {
    const sample = es[0]
    const d = es.reduce((a, e) => a + e.distance, 0)
    const c = es.reduce((a, e) => a + e.cost, 0)
    const { pathLevel } = classifyEdge(sample.tags)
    const item = classifyOsmTagsToItem(sample.tags, mode)
    const walk = es.some((e) => e.isWalking)
    return { wayId, name: sample.tags.name ?? '?', highway: sample.tags.highway, pathLevel, item, bikeRoad: sample.tags.bicycle_road ?? sample.tags.cyclestreet, surface: sample.tags.surface, smoothness: sample.tags.smoothness, distance: d, cost: c, speed: d / c * 3.6, walk }
  })
  // Sort in path order
  const pathOrder = [...new Set(edges.map((e) => e.wayId))]
  waySummaries.sort((a, b) => pathOrder.indexOf(a.wayId) - pathOrder.indexOf(b.wayId))

  console.log('\n=== Ways on chosen path (in order) ===')
  console.log('way_id       name                         hw          lvl  item                              dist   cost  spd  walk  surface    smoothness    bikeRoad')
  for (const w of waySummaries) {
    const name = (w.name ?? '').padEnd(28).slice(0, 28)
    const hw = (w.highway ?? '').padEnd(11).slice(0, 11)
    const item = (w.item ?? '').padEnd(32).slice(0, 32)
    console.log(
      `${String(w.wayId).padStart(12)} ${name} ${hw} ${w.pathLevel.padEnd(3)}  ${item}  ${(w.distance/1000).toFixed(2).padStart(5)}km ${w.cost.toFixed(0).padStart(4)}s ${w.speed.toFixed(1).padStart(4)}k/h ${w.walk ? 'WALK' : '    '}  ${(w.surface ?? '-').padEnd(10)} ${(w.smoothness ?? '-').padEnd(12)} ${w.bikeRoad ?? '-'}`,
    )
  }

  // Expected route: is Mariannenstraße / Weserstraße in the graph at all?
  console.log('\n=== Key "expected" ways in the graph (Mariannenstraße + Weserstraße) ===')
  const expectedNames = ['Mariannenstraße', 'Weserstraße']
  const inGraph = new Set<number>()
  graph.forEachLink((link: any) => { if (link.data.wayId) inGraph.add(link.data.wayId) })
  for (const name of expectedNames) {
    const candidates = ways.filter((w) => w.tags.name === name)
    const hits = candidates.filter((w) => inGraph.has(w.osmId))
    console.log(`${name}: ${candidates.length} OSM ways, ${hits.length} in graph`)
    for (const w of candidates.slice(0, 8)) {
      const inG = inGraph.has(w.osmId) ? 'IN ' : 'OUT'
      const { pathLevel } = classifyEdge(w.tags)
      console.log(`  ${inG} ${String(w.osmId).padStart(12)} lvl=${pathLevel} hw=${w.tags.highway} bikeRoad=${w.tags.bicycle_road ?? w.tags.cyclestreet ?? '-'} surface=${w.tags.surface ?? '-'} smoothness=${w.tags.smoothness ?? '-'}`)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
