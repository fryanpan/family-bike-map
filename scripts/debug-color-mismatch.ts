#!/usr/bin/env bun
/**
 * Debug Bryan's "colors on map don't match colors in panel" bug.
 *
 * Plan: compute a real client route in kid-traffic-savvy mode, then for
 * every segment dump:
 *   - itemName
 *   - pathLevel (set by clientRouter)
 *   - legendItem.level (the fallback the painter / bar would use)
 *   - isPreferred (against preferredItemNames)
 *   - painter_color (what Map.tsx would draw)
 *   - bar_bucket (what DirectionsPanel would put it under)
 *
 * Specifically checking: do any segments produce a tier color the bar
 * doesn't bucket, or a tier color that doesn't match the panel?
 */

import { buildQuery } from '../src/services/overpass'
import { injectCachedTile, latLngToTile } from '../src/services/overpass'
import { clientRoute } from '../src/services/clientRouter'
import {
  getDefaultPreferredItems,
  getLegendItem,
  PREFERRED_COLOR,
  OTHER_COLOR,
  WALKING_COLOR,
  computeRouteQuality,
} from '../src/utils/classify'
import { PATH_LEVEL_LABELS } from '../src/utils/lts'
import type { OsmWay } from '../src/utils/types'

const OVERPASS_URL = 'https://bike-map.fryanpan.com/api/overpass'
const TILE_DEG = 0.1
const MODE = 'kid-traffic-savvy'

// Approximation of the route in Bryan's recording — Berlin Mitte area.
// Start: top of frame ~ around Hausvogteiplatz
// End: 'A' pin around Märkisches Museum / Spittelmarkt
const START = { lat: 52.5230, lng: 13.3920, label: 'Friedrichstr area' }
const END   = { lat: 52.5113, lng: 13.4078, label: 'Märkisches Museum area' }

async function fetchTile(row: number, col: number): Promise<OsmWay[]> {
  const bbox = {
    south: row * TILE_DEG,
    north: (row + 1) * TILE_DEG,
    west:  col * TILE_DEG,
    east:  (col + 1) * TILE_DEG,
  }
  const query = buildQuery(bbox)
  const resp = await fetch(`${OVERPASS_URL}?row=${row}&col=${col}`, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  if (!resp.ok) {
    console.error(`Tile fetch ${row},${col} failed: ${resp.status}`)
    return []
  }
  const data = await resp.json() as { elements: Array<{ type: string; id: number; tags?: Record<string,string>; geometry?: Array<{ lat: number; lon: number }> }> }
  return data.elements
    .filter((e) => e.type === 'way' && e.geometry != null)
    .map((e) => ({
      osmId: e.id,
      coordinates: e.geometry!.map((p): [number, number] => [p.lat, p.lon]),
      tags: e.tags ?? {},
    }))
}

async function main() {
  const preferredItemNames = getDefaultPreferredItems(MODE)
  console.log(`Mode: ${MODE}`)
  console.log(`preferredItemNames (${preferredItemNames.size}): ${[...preferredItemNames].join(', ')}`)
  console.log()

  // Pre-fetch tiles spanning start..end (with 1-tile margin)
  const startTile = latLngToTile(START.lat, START.lng)
  const endTile = latLngToTile(END.lat, END.lng)
  const minRow = Math.min(startTile.row, endTile.row) - 1
  const maxRow = Math.max(startTile.row, endTile.row) + 1
  const minCol = Math.min(startTile.col, endTile.col) - 1
  const maxCol = Math.max(startTile.col, endTile.col) + 1

  const tilesNeeded: Array<{row:number, col:number}> = []
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) tilesNeeded.push({row: r, col: c})
  }
  console.log(`Fetching ${tilesNeeded.length} tiles...`)

  for (const t of tilesNeeded) {
    const ways = await fetchTile(t.row, t.col)
    injectCachedTile(t.row, t.col, ways)
    console.log(`  tile ${t.row},${t.col}: ${ways.length} ways`)
  }
  console.log()

  // Compute route
  const route = await clientRoute(
    START.lat, START.lng, END.lat, END.lng,
    MODE, preferredItemNames,
    undefined, undefined, undefined, undefined,
  )

  if (!route) { console.error('No route found'); return }

  const segments = route.segments ?? []
  console.log(`Route: ${segments.length} segments, ${(route.summary.distance/1000).toFixed(2)}km, ${(route.summary.duration/60).toFixed(0)}min`)
  console.log()

  // Painter logic from Map.tsx:436-447
  const paint = (seg: typeof segments[0]) => {
    if (seg.isWalking) return { color: WALKING_COLOR, branch: 'walking' }
    const isPreferred = seg.itemName !== null && preferredItemNames.has(seg.itemName)
    const legendItem = getLegendItem(seg.itemName, MODE)
    const tierLevel = seg.pathLevel ?? legendItem?.level
    if (tierLevel && isPreferred) {
      return { color: tierLevelColor(tierLevel), branch: `tier-${tierLevel}` }
    }
    return { color: isPreferred ? PREFERRED_COLOR : OTHER_COLOR, branch: isPreferred ? 'preferred-default' : 'other' }
  }

  const tierLevelColor = (level: string) => PATH_LEVEL_LABELS[level as keyof typeof PATH_LEVEL_LABELS]?.defaultColor ?? '???'

  // Bar bucket logic from classify.ts:267-279
  const bucket = (seg: typeof segments[0]) => {
    if (seg.isWalking) return { kind: 'walking' as const }
    if (seg.itemName && preferredItemNames.has(seg.itemName)) {
      const lvl = seg.pathLevel ?? getLegendItem(seg.itemName, MODE)?.level
      return { kind: 'preferred' as const, byLevel: lvl }
    }
    return { kind: 'other' as const }
  }

  console.log('SEGMENT-BY-SEGMENT:')
  console.log('idx  itemName                               pathLvl legLvl  pref   painter_color  bar_bucket')
  console.log('---  -------------------------------------- ------- ------  -----  -------------  ----------')
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    const legendItem = getLegendItem(s.itemName, MODE)
    const isPref = s.itemName !== null && preferredItemNames.has(s.itemName)
    const p = paint(s)
    const b = bucket(s)
    const itemName = (s.itemName ?? '<null>').padEnd(38)
    const pathLvl  = (s.pathLevel ?? '-').padEnd(7)
    const legLvl   = (legendItem?.level ?? '-').padEnd(6)
    const pref     = (isPref ? 'YES' : 'no').padEnd(5)
    const painter  = `${p.branch}/${p.color}`.padEnd(13)
    const bar      = b.kind === 'preferred' ? `pref byLvl=${b.byLevel}` : b.kind
    console.log(`${i.toString().padStart(3)}  ${itemName} ${pathLvl} ${legLvl}  ${pref}  ${painter}  ${bar}`)
  }
  console.log()

  // Specifically: any segments where painter ≠ bar?
  const mismatches: Array<{i:number, painter:string, bar:string, seg:any}> = []
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    const p = paint(s)
    const b = bucket(s)
    // Map painter color back to a "category" comparable to bar:
    //   - tier-XX color  → preferred byLevel=XX
    //   - preferred-default → preferred no-byLevel
    //   - other → other (orange)
    //   - walking → walking
    let painterCat: string
    if (p.branch === 'walking') painterCat = 'walking'
    else if (p.branch === 'other') painterCat = 'other'
    else if (p.branch === 'preferred-default') painterCat = 'preferred-no-byLevel'
    else painterCat = `preferred-byLevel=${p.branch.slice(5)}`

    let barCat: string
    if (b.kind === 'walking') barCat = 'walking'
    else if (b.kind === 'other') barCat = 'other'
    else barCat = b.byLevel ? `preferred-byLevel=${b.byLevel}` : 'preferred-no-byLevel'

    if (painterCat !== barCat) {
      mismatches.push({ i, painter: painterCat, bar: barCat, seg: s })
    }
  }

  console.log(`MISMATCHES: ${mismatches.length}`)
  for (const m of mismatches) {
    console.log(`  seg ${m.i}: painter=${m.painter} bar=${m.bar} itemName=${m.seg.itemName} pathLevel=${m.seg.pathLevel}`)
  }
  console.log()

  // Quality bar percentages
  const q = computeRouteQuality(segments, preferredItemNames, MODE)
  console.log('QUALITY:')
  console.log(`  preferred=${(q.preferred*100).toFixed(1)}% other=${(q.other*100).toFixed(1)}% walking=${(q.walking*100).toFixed(1)}%`)
  console.log(`  byLevel:`, Object.fromEntries(Object.entries(q.byLevel).map(([k,v]) => [k, `${((v as number)*100).toFixed(1)}%`])))
}

main().catch((e) => { console.error(e); process.exit(1) })
