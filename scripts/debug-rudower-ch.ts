#!/usr/bin/env bun
/**
 * Investigation: training mode reportedly skips Kotbusser Damm + Mauerweg
 * for Brandenburg Gate → Rudower Chaussee 12, 12489 Berlin.
 *
 * Computes the actual route in training mode (and a couple of others for
 * comparison) and dumps:
 *   - per-segment {itemName, pathLevel, isPreferred for training, length}
 *   - aggregate %preferred / %other / %walking
 *   - which segments cover Kotbusser Damm / Mauerweg way IDs (if any)
 *   - whether training's classifier sees any of those ways as non-preferred
 */

import { buildQuery, classifyOsmTagsToItem, latLngToTile, injectCachedTile } from '../src/services/overpass'
import { clientRoute } from '../src/services/clientRouter'
import { getDefaultPreferredItems, getLegendItem } from '../src/utils/classify'
import { classifyEdge } from '../src/utils/lts'
import type { OsmWay } from '../src/utils/types'

const OVERPASS_URL = 'https://bike-map.fryanpan.com/api/overpass'
const TILE_DEG = 0.1

// Bryan: actual start is Dresdener Str 112 in Kreuzberg; the original
// version used Brandenburg Gate (saved Home in localStorage), which threw
// off the route comparison. Updated 2026-04-29.
const START = { lat: 52.5020, lng: 13.4350, label: 'Dresdener Str 112, Kreuzberg' }
const END   = { lat: 52.4332, lng: 13.5362, label: 'Rudower Chaussee 12' }
const MODES = ['kid-traffic-savvy', 'training'] as const

async function fetchTile(row: number, col: number): Promise<{ ways: OsmWay[]; signals: [number, number][] }> {
  const bbox = {
    south: row * TILE_DEG, north: (row + 1) * TILE_DEG,
    west: col * TILE_DEG, east: (col + 1) * TILE_DEG,
  }
  const resp = await fetch(`${OVERPASS_URL}?row=${row}&col=${col}`, {
    method: 'POST',
    body: `data=${encodeURIComponent(buildQuery(bbox))}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  if (!resp.ok) { console.error(`tile ${row},${col} ${resp.status}`); return { ways: [], signals: [] } }
  const data = await resp.json() as { elements: Array<{ type: string; id: number; tags?: Record<string,string>; geometry?: Array<{lat:number;lon:number}>; lat?: number; lon?: number }> }
  const ways: OsmWay[] = []
  const signals: [number, number][] = []
  for (const e of data.elements) {
    if (e.type === 'way' && e.geometry) {
      ways.push({ osmId: e.id, coordinates: e.geometry.map((p): [number,number] => [p.lat, p.lon]), tags: e.tags ?? {} })
    } else if (e.type === 'node' && e.lat != null && e.lon != null && e.tags?.highway === 'traffic_signals') {
      signals.push([e.lat, e.lon])
    }
  }
  return { ways, signals }
}

function haversineKm(a: {lat:number;lng:number}, b: {lat:number;lng:number}): number {
  const R = 6371
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const x = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x))
}

async function main() {
  const startTile = latLngToTile(START.lat, START.lng)
  const endTile = latLngToTile(END.lat, END.lng)
  const minR = Math.min(startTile.row, endTile.row) - 1
  const maxR = Math.max(startTile.row, endTile.row) + 1
  const minC = Math.min(startTile.col, endTile.col) - 1
  const maxC = Math.max(startTile.col, endTile.col) + 1

  const tiles: Array<{row:number,col:number}> = []
  for (let r = minR; r <= maxR; r++) for (let c = minC; c <= maxC; c++) tiles.push({row:r, col:c})
  console.log(`Pre-fetching ${tiles.length} tiles for ${START.label} (${START.lat},${START.lng}) → ${END.label} (${END.lat},${END.lng})`)
  console.log(`Direct distance: ${haversineKm(START, END).toFixed(2)} km`)

  const allWays = new Map<number, OsmWay>() // dedupe
  let totalSignals = 0
  for (const t of tiles) {
    const { ways, signals } = await fetchTile(t.row, t.col)
    injectCachedTile(t.row, t.col, ways, signals)
    for (const w of ways) if (w.osmId != null) allWays.set(w.osmId, w)
    totalSignals += signals.length
    console.log(`  tile ${t.row},${t.col}: ${ways.length} ways, ${signals.length} signals`)
  }
  console.log(`Total unique ways: ${allWays.size}, total signals: ${totalSignals}`)
  console.log()

  // Find Kotbusser Damm + Mauerweg ways for sanity-check
  const KOTB = [...allWays.values()].filter(w => /kott?bu(s|ß)ser damm/i.test(w.tags.name ?? '') || w.tags['name:de']?.match(/kott?bu(s|ß)ser damm/i))
  const MAUE = [...allWays.values()].filter(w => /mauerweg|mauerradweg/i.test(w.tags.name ?? '') || w.tags['ref']?.match(/mauerweg/i))
  console.log(`Kotbusser Damm ways found: ${KOTB.length}`)
  for (const w of KOTB.slice(0, 6)) {
    const item = classifyOsmTagsToItem(w.tags, 'training')
    const { pathLevel } = classifyEdge(w.tags)
    console.log(`  way ${w.osmId} hwy=${w.tags.highway} cycleway=${w.tags.cycleway ?? ''} cw:right=${w.tags['cycleway:right'] ?? ''} cw:left=${w.tags['cycleway:left'] ?? ''} → pathLevel=${pathLevel} item="${item}"`)
  }
  console.log(`Mauerweg ways found: ${MAUE.length}`)
  // Compute centroid + extents of Mauerweg corridor + which way is nearest to the
  // Brandenburg → Rudower straight line
  function centroid(coords: [number, number][]): [number, number] {
    let lat = 0, lng = 0
    for (const c of coords) { lat += c[0]; lng += c[1] }
    return [lat / coords.length, lng / coords.length]
  }
  const mauerCentroids = MAUE.map(w => ({ wayId: w.osmId, c: centroid(w.coordinates), tags: w.tags }))
  let mauerLat = 0, mauerLng = 0
  for (const m of mauerCentroids) { mauerLat += m.c[0]; mauerLng += m.c[1] }
  mauerLat /= mauerCentroids.length
  mauerLng /= mauerCentroids.length
  console.log(`  Mauerweg corridor centroid: ${mauerLat.toFixed(4)},${mauerLng.toFixed(4)}`)

  // Distance from Brandenburg→Rudower direct line to each Mauerweg way's centroid
  // Find the Mauerweg way whose centroid is most aligned with the corridor (i.e. has
  // smallest sum-of-distances to start + end while being roughly on-line)
  function dKm(a: {lat:number;lng:number}, b: {lat:number;lng:number}): number {
    return haversineKm(a, b)
  }
  const corridorRanked = mauerCentroids.map(m => {
    const cLat = m.c[0], cLng = m.c[1]
    const dStart = dKm(START, { lat: cLat, lng: cLng })
    const dEnd = dKm(END, { lat: cLat, lng: cLng })
    const detour = (dStart + dEnd) - haversineKm(START, END)
    return { wayId: m.wayId, c: m.c, name: m.tags.name ?? m.tags.ref ?? '?', dStart, dEnd, detour }
  }).sort((a, b) => a.detour - b.detour)
  console.log(`  Top 6 Mauerweg ways by lowest detour from straight line:`)
  for (const m of corridorRanked.slice(0, 6)) {
    console.log(`    way ${m.wayId} @ ${m.c[0].toFixed(4)},${m.c[1].toFixed(4)} | start→${m.dStart.toFixed(2)}km, end→${m.dEnd.toFixed(2)}km, detour=+${m.detour.toFixed(2)}km`)
  }

  for (const w of MAUE.slice(0, 6)) {
    const item = classifyOsmTagsToItem(w.tags, 'training')
    const { pathLevel } = classifyEdge(w.tags)
    console.log(`  way ${w.osmId} hwy=${w.tags.highway} bicycle=${w.tags.bicycle ?? ''} → pathLevel=${pathLevel} item="${item}"`)
  }

  // Best Mauerweg waypoint = the one with smallest detour
  const BEST_MAUER = corridorRanked[0]
  console.log(`  BEST Mauerweg waypoint: way ${BEST_MAUER.wayId} @ ${BEST_MAUER.c[0].toFixed(4)},${BEST_MAUER.c[1].toFixed(4)} (+${BEST_MAUER.detour.toFixed(2)} km detour over straight line)`)
  console.log()

  // Run a route in each MODE and dump segments
  for (const mode of MODES) {
    console.log(`\n=== MODE: ${mode} ===`)
    const prefs = getDefaultPreferredItems(mode)
    console.log(`preferredItemNames (${prefs.size}): ${[...prefs].join(', ')}`)
    const route = await clientRoute(
      START.lat, START.lng, END.lat, END.lng,
      mode, prefs,
      undefined, undefined, undefined, undefined,
    )
    if (!route) { console.log('  NO ROUTE'); continue }
    const segs = route.segments ?? []
    console.log(`  ${segs.length} segments | ${(route.summary.distance/1000).toFixed(2)} km | ${(route.summary.duration/60).toFixed(0)} min`)

    // Aggregate
    let preferredM = 0, otherM = 0, walkM = 0
    const byItem: Record<string, number> = {}
    for (const seg of segs) {
      let lenM = 0
      for (let i = 1; i < seg.coordinates.length; i++) {
        lenM += haversineKm(
          { lat: seg.coordinates[i-1][0], lng: seg.coordinates[i-1][1] },
          { lat: seg.coordinates[i][0], lng: seg.coordinates[i][1] },
        ) * 1000
      }
      if (seg.isWalking) walkM += lenM
      else if (seg.itemName && prefs.has(seg.itemName)) preferredM += lenM
      else otherM += lenM
      const key = seg.itemName ?? '(walking)'
      byItem[key] = (byItem[key] ?? 0) + lenM
    }
    const total = preferredM + otherM + walkM
    console.log(`  preferred: ${(preferredM/total*100).toFixed(1)}% (${(preferredM/1000).toFixed(2)} km)`)
    console.log(`  other:     ${(otherM/total*100).toFixed(1)}% (${(otherM/1000).toFixed(2)} km)`)
    console.log(`  walking:   ${(walkM/total*100).toFixed(1)}% (${(walkM/1000).toFixed(2)} km)`)
    console.log(`  by item:`)
    const sorted = Object.entries(byItem).sort((a, b) => b[1] - a[1])
    for (const [item, m] of sorted) {
      const isPref = item !== '(walking)' && prefs.has(item)
      const lvl = item !== '(walking)' ? getLegendItem(item, mode)?.level ?? '-' : '-'
      console.log(`    ${item.padEnd(40)} ${(m/1000).toFixed(2).padStart(6)} km   lvl=${lvl}  pref=${isPref ? 'YES' : 'no'}`)
    }

    // Did the route touch Kotbusser Damm or Mauerweg?
    const routeWayIds = new Set<number>()
    for (const seg of segs) for (const id of (seg.wayIds ?? [])) routeWayIds.add(id)
    const kotbHit = KOTB.filter(w => w.osmId != null && routeWayIds.has(w.osmId)).length
    const maueHit = MAUE.filter(w => w.osmId != null && routeWayIds.has(w.osmId)).length
    console.log(`  Route uses ${kotbHit}/${KOTB.length} Kotbusser Damm ways, ${maueHit}/${MAUE.length} Mauerweg ways`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
