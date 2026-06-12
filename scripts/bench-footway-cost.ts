#!/usr/bin/env bun
/**
 * Measures the routing-graph build-time + memory cost of ALWAYS fetching
 * footway/pedestrian ways (the "always fetch so they're available for
 * bridge-walk" approach) vs the current query (only bike-access footways).
 *
 * For SF and a Berlin slice: fetch each tile twice (current query vs
 * broad-footway query) through the prod Worker with synthetic cache keys,
 * then run the production buildRoutingGraph and report nodes/edges/buildMs +
 * process RSS per mode.
 *
 * Run: bun scripts/bench-footway-cost.ts
 */
import { buildRoutingGraph } from '../src/services/clientRouter'
import { buildQuery } from '../src/services/overpass'
import { getDefaultPreferredItems } from '../src/utils/classify'
import type { OsmWay } from '../src/utils/types'

const PROXY = 'https://bike-map.fryanpan.com/api/overpass'
const T = 0.1
const MODES = ['kid-starting-out', 'kid-traffic-savvy'] as const // extremes of graph size

// Broad variant: current query + ALL footway/pedestrian (no bike-access filter).
function broadQuery(bbox: { south: number; west: number; north: number; east: number }): string {
  const base = buildQuery(bbox)
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`
  // Insert an all-footway/pedestrian line as the last member of the union.
  return base.replace(');\nout geom;', `  way["highway"~"^(footway|pedestrian)$"](${b});\n);\nout geom;`)
}

async function fetchTile(tag: string, row: number, col: number, q: (b: any) => string): Promise<OsmWay[]> {
  const bbox = { south: row * T, north: (row + 1) * T, west: col * T, east: (col + 1) * T }
  for (let a = 0; a < 5; a++) {
    const r = await fetch(`${PROXY}?row=${tag}-${row}&col=${col}`, {
      method: 'POST', body: `data=${encodeURIComponent(q(bbox))}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    if (r.ok) {
      const d = await r.json() as any
      if (d.remark) { console.warn(`  ${tag} ${row}:${col} PARTIAL (remark), retrying`); await new Promise(s => setTimeout(s, 8000)); continue }
      return (d.elements ?? []).filter((e: any) => e.type === 'way' && e.geometry).map((e: any) => ({ osmId: e.id, coordinates: e.geometry.map((p: any) => [p.lat, p.lon]), tags: e.tags ?? {}, itemName: null }))
    }
    await new Promise(s => setTimeout(s, (a + 1) * 4000))
  }
  console.warn(`  ${tag} ${row}:${col} FAILED`); return []
}

async function fetchCity(tag: string, tiles: [number, number][], q: (b: any) => string): Promise<OsmWay[]> {
  const all: OsmWay[] = []
  for (const [r, c] of tiles) { all.push(...await fetchTile(tag, r, c, q)); await new Promise(s => setTimeout(s, 2500)) }
  return all
}

function mb(n: number) { return (n / 1024 / 1024).toFixed(0) }
function gc() { const g = (globalThis as any).Bun; if (g?.gc) g.gc(true) }

async function measure(label: string, ways: OsmWay[]) {
  const footways = ways.filter(w => w.tags.highway === 'footway' || w.tags.highway === 'pedestrian').length
  console.log(`\n### ${label}: ${ways.length} ways (${footways} footway/pedestrian)`)
  console.log('| mode | nodes | edges | buildMs | rss after |')
  console.log('|---|---|---|---|---|')
  for (const mode of MODES) {
    gc(); const t0 = performance.now()
    const g = buildRoutingGraph(ways, mode, getDefaultPreferredItems(mode))
    const ms = (performance.now() - t0).toFixed(0)
    const rss = process.memoryUsage().rss
    console.log(`| ${mode} | ${g.getNodeCount()} | ${g.getLinkCount()} | ${ms} | ${mb(rss)} MB |`)
  }
}

async function main() {
  const SF: [number, number][] = []
  for (let r = 377; r <= 378; r++) for (let c = -1226; c <= -1224; c++) SF.push([r, c])
  console.log('Fetching SF — current query...'); const sfBase = await fetchCity('fwbase', SF, buildQuery)
  console.log('Fetching SF — broad-footway query...'); const sfBroad = await fetchCity('fwbroad', SF, broadQuery)
  await measure('SF · CURRENT query (bike-access footways only)', sfBase)
  await measure('SF · BROAD query (ALL footway/pedestrian)', sfBroad)

  const BERLIN: [number, number][] = [[525, 133], [525, 134], [525, 135]]
  console.log('\nFetching Berlin slice — current query...'); const beBase = await fetchCity('fwbase', BERLIN, buildQuery)
  console.log('Fetching Berlin slice — broad-footway query...'); const beBroad = await fetchCity('fwbroad', BERLIN, broadQuery)
  await measure('Berlin(3 tiles) · CURRENT query', beBase)
  await measure('Berlin(3 tiles) · BROAD query', beBroad)
  console.log('\nbench-footway-cost done')
}
main().catch(console.error)
