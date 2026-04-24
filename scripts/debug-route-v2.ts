#!/usr/bin/env bun
/**
 * Deeper route debug — runs 3 probes, all on the kid-confident graph:
 *   1. School → Stadtbad (the "weird" route)
 *   2. Mariannenstraße midpoint → Stadtbad   (to see if the "expected"
 *      corridor is even reachable/cheap from Bryan's preferred route)
 *   3. School → Mariannenstraße midpoint     (what the router does if
 *      you force it to head toward the expected corridor)
 *
 * For each probe, dumps every way on the chosen path (in order), with
 * wayId, name, pathLevel, cost, speed, walk flag. Plus nearest-node
 * snapping + neighbour-edge survey for the start point.
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
const BERLIN_BBOX = { south: 52.34, west: 13.08, north: 52.68, east: 13.80 }
const MODE = 'kid-confident' as const

// Known fixtures.
const SCHOOL      = { lat: 52.5105, lng: 13.4247, label: 'School' }
const STADTBAD    = { lat: 52.4792, lng: 13.4397, label: 'Stadtbad' }
// Mid Mariannenstraße (Kreuzberg) — picked from an obvious Fahrradstraße stretch.
const MARIANNEN_MID = { lat: 52.5000, lng: 13.4193, label: 'Mariannenstr mid' }

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
  console.error(`  ${out.length} ways`)
  return out
}

// ───────────────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function routeAndDump(graph: any, from: { lat: number; lng: number; label: string }, to: { lat: number; lng: number; label: string }, label: string) {
  console.log(`\n========== ${label}: ${from.label} → ${to.label} ==========`)
  // Find nearest node
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const nearest = (lat: number, lng: number): { id: string; dist: number; degree: number } => {
    let best: string | null = null, bd = Infinity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graph.forEachNode((n: any) => {
      const d = haversineM(lat, lng, n.data.lat, n.data.lng)
      if (d < bd) { bd = d; best = n.id as string }
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let degree = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    graph.forEachLinkedNode(best!, () => { degree++ })
    return { id: best!, dist: bd, degree }
  }
  const s = nearest(from.lat, from.lng)
  const d = nearest(to.lat, to.lng)
  console.log(`  Start node ${s.id} (${s.dist.toFixed(0)}m from origin, deg=${s.degree})`)
  console.log(`  End   node ${d.id} (${d.dist.toFixed(0)}m from dest,   deg=${d.degree})`)

  const maxSpeedMs = MODE_RULES[MODE].ridingSpeedKmh / 3.6
  const pf = aStar(graph, {
    oriented: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    distance: (_f: any, _t: any, link: any) => link.data.cost,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    heuristic: (f: any, t: any) => haversineM(f.data.lat, f.data.lng, t.data.lat, t.data.lng) / maxSpeedMs,
  })
  const path = pf.find(s.id, d.id)
  if (!path || path.length === 0) { console.log(`  NO PATH`); return }
  const nodes = [...path].reverse()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const edges: any[] = []
  let totalDist = 0, totalCost = 0, walkDist = 0
  for (let i = 1; i < nodes.length; i++) {
    const link = graph.getLink(nodes[i - 1].id, nodes[i].id)
    if (!link) continue
    const ld = link.data
    edges.push(ld)
    totalDist += ld.distance
    totalCost += ld.cost
    if (ld.isWalking) walkDist += ld.distance
  }
  console.log(`  ${edges.length} edges · ${(totalDist / 1000).toFixed(2)} km · ${(totalCost / 60).toFixed(1)} min · walked ${(walkDist / 1000).toFixed(2)} km (${((walkDist / totalDist) * 100).toFixed(0)}%)`)

  // Aggregate by wayId in path order
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byWay: Array<{ wayId: number; tags: any; dist: number; cost: number; walk: boolean }> = []
  for (const e of edges) {
    const last = byWay[byWay.length - 1]
    if (last && last.wayId === e.wayId) {
      last.dist += e.distance
      last.cost += e.cost
      last.walk = last.walk || !!e.isWalking
    } else {
      byWay.push({ wayId: e.wayId, tags: e.wayTags, dist: e.distance, cost: e.cost, walk: !!e.isWalking })
    }
  }
  console.log('\n  way_id       name                     hw          lvl  item                              m      s     spd    walk  surface  smooth    br')
  for (const w of byWay) {
    const { pathLevel } = classifyEdge(w.tags)
    const item = classifyOsmTagsToItem(w.tags, MODE) ?? '?'
    const name = (w.tags.name ?? '').padEnd(24).slice(0, 24)
    const hw = (w.tags.highway ?? '').padEnd(11).slice(0, 11)
    const speed = w.dist > 0 ? (w.dist / w.cost * 3.6).toFixed(1) : '?'
    const br = w.tags.bicycle_road ?? w.tags.cyclestreet ?? '-'
    console.log(
      `  ${String(w.wayId).padStart(12)} ${name} ${hw} ${pathLevel.padEnd(3)}  ${(item.padEnd(32).slice(0, 32))}  ${Math.round(w.dist).toString().padStart(5)}m ${Math.round(w.cost).toString().padStart(4)}s ${speed.padStart(5)}  ${w.walk ? 'WALK' : '    '}  ${(w.tags.surface ?? '-').padEnd(8)} ${(w.tags.smoothness ?? '-').padEnd(9)} ${br}`,
    )
  }
}

async function main() {
  const ways = await fetchAllTiles()
  const preferred = getDefaultPreferredItems(MODE)
  console.error(`Building ${MODE} graph…`)
  const graph = buildRoutingGraph(ways, MODE, preferred)
  console.error(`  nodes=${graph.getNodeCount()}, edges=${graph.getLinkCount()}\n`)

  routeAndDump(graph, SCHOOL, STADTBAD, '1. School → Stadtbad (observed)')
  routeAndDump(graph, MARIANNEN_MID, STADTBAD, '2. Mariannenstr mid → Stadtbad (should use Fahrradstraße corridor)')
  routeAndDump(graph, SCHOOL, MARIANNEN_MID, '3. School → Mariannenstr mid (what does it take to GET there?)')
}

main().catch((e) => { console.error(e); process.exit(1) })
