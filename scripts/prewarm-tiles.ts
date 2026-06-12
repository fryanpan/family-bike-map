#!/usr/bin/env bun
/**
 * One-off: pre-warm the production Worker edge cache for the active SF + Berlin
 * tiles after a cache-version bump, using the REAL row/col keys and the exact
 * buildQuery() the app sends — so the first real user gets a complete HIT
 * instead of a cold ~19s Overpass fetch (and never a poisoned/partial tile).
 *
 * Run: bun scripts/prewarm-tiles.ts
 */
import { buildQuery } from '../src/services/overpass'

const PROXY = 'https://bike-map.fryanpan.com/api/overpass'
const TILE = 0.1

// SF: bbox 37.70–37.82, -122.52 to -122.38  → rows 377-378 × cols -1226..-1224
// Berlin core: rows 524-526 × cols 133-135 (Mitte/Kreuzberg/Treptower)
const tiles: Array<{ row: number; col: number; city: string }> = []
for (let r = 377; r <= 378; r++) for (let c = -1226; c <= -1224; c++) tiles.push({ row: r, col: c, city: 'SF' })
for (let r = 524; r <= 526; r++) for (let c = 133; c <= 135; c++) tiles.push({ row: r, col: c, city: 'Berlin' })

for (const { row, col, city } of tiles) {
  const bbox = { south: row * TILE, north: (row + 1) * TILE, west: col * TILE, east: (col + 1) * TILE }
  const t0 = performance.now()
  try {
    const resp = await fetch(`${PROXY}?row=${row}&col=${col}`, {
      method: 'POST',
      body: `data=${encodeURIComponent(buildQuery(bbox))}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    const xc = resp.headers.get('X-Cache')
    let ways = -1, partial = false
    if (resp.ok) {
      const d = await resp.json() as { elements?: unknown[]; remark?: string }
      ways = (d.elements ?? []).length
      partial = !!d.remark
    }
    const ms = ((performance.now() - t0) / 1000).toFixed(1)
    console.log(`${city} ${row}:${col} → HTTP ${resp.status} ${xc} ${ways} ways ${partial ? '⚠️PARTIAL(remark, not cached)' : ''} (${ms}s)`)
    // If partial, retry once — a complete response should cache.
    if (resp.ok && partial) {
      const r2 = await fetch(`${PROXY}?row=${row}&col=${col}`, {
        method: 'POST', body: `data=${encodeURIComponent(buildQuery(bbox))}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      const d2 = await r2.json() as { elements?: unknown[]; remark?: string }
      console.log(`   retry ${row}:${col} → ${(d2.elements ?? []).length} ways ${d2.remark ? '⚠️still partial' : '✓complete'}`)
    }
  } catch (e) {
    console.log(`${city} ${row}:${col} → ERROR ${e}`)
  }
  await new Promise((r) => setTimeout(r, 1500))
}
console.log('prewarm done')
