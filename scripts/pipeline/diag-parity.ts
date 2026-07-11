// Bake-vs-runtime parity diagnostic (enriched-tiles plan, chunk C1).
//
//   bun scripts/pipeline/diag-parity.ts --tiles data/tiles/bayarea-core \
//       [--n 200] [--seed 42] [--json out.json]
//
// Samples N random baked tiles and re-runs the PRODUCTION functions on the
// exact same ways:
//
//   - `overlayGradientPct` (src/services/elevation.ts) over the *Mapbox
//     terrain-RGB* runtime DEM source — the browser's current overlay path —
//     compared against the baked terrarium `gradientPct`;
//   - `classifyOsmTagsToItem` (src/services/overpass.ts) per mode over the
//     baked tags — the tile carries tags verbatim and classification stays
//     client-side (tiles are mode-agnostic by plan decision), so classify
//     parity is exact by construction; this run proves the baked payload
//     feeds the production classifier and reports the item distribution;
//   - per-mode SHOW/HIDE verdicts (`gradient <= getOverlayMaxGradientPct(mode)`,
//     null fail-soft shown) under each DEM, quantifying how many ways cross a
//     mode ceiling (6/8/10/15%) purely from the DEM-source difference.
//
// ONE-implementation rule: every number/classification here is a production
// import (overlayGradientPct via the module's own mapbox fetch+decode path,
// classifyOsmTagsToItem, getOverlayMaxGradientPct, isPaintedCandidate which
// composes classifyEdge/isOverlayCrossing/isOverlayHiddenSurface). The script
// adds only sampling, comparison, and reporting.
//
// Requires VITE_MAPBOX_TOKEN (bun auto-loads .env). The production token is
// URL-restricted, so the script registers the prod Referer — same pattern as
// scripts/benchmark-routing.ts (see learnings: 'Elevation / terrain data').

import * as fs from 'node:fs'
import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { PNG } from 'pngjs'

import {
  overlayGradientPct,
  prefetchElevation,
  setElevationDecoder,
  setElevationReferer,
  setElevationSource,
  getElevationSource,
} from '../../src/services/elevation'
import { classifyOsmTagsToItem } from '../../src/services/overpass'
import { getOverlayMaxGradientPct } from '../../src/utils/classify'
import { isPaintedCandidate, wayLengthM } from './lib/graph'
import type { EnrichedTile, EnrichedWay } from './lib/tiles'

// The five travel modes and their overlay gradient ceilings — ceilings come
// from the production table (6 / 8 / 8 / 10 / 15 as of 2026-07-03).
const MODES = [
  'kid-starting-out',
  'kid-confident',
  'carrying-kid',
  'kid-traffic-savvy',
  'training',
] as const

// Deterministic PRNG (mulberry32) so the same --seed samples the same tiles.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seededShuffle<T>(items: readonly T[], rand: () => number): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/** Percentile over a sorted ascending array (nearest-rank). */
function pct(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[i]
}

/** The overlay's fail-soft show/hide arithmetic: null = unknown = SHOWN. */
function shownAtCeiling(gradient: number | null, ceilingPct: number): boolean {
  return gradient == null || gradient <= ceilingPct
}

interface SampledWay {
  osmId: number
  tags: Record<string, string>
  coordinates: [number, number][]
  bakedGradientPct: number | null
  bakedAccessGradientPct: number | null
  bakedComponentPaintedLenM: number | null
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tiles: { type: 'string' },
      n: { type: 'string' },
      seed: { type: 'string' },
      json: { type: 'string' },
    },
  })
  if (!values.tiles) {
    console.error('Usage: bun scripts/pipeline/diag-parity.ts --tiles <baked-tile-dir> [--n 200] [--seed 42] [--json out.json]')
    process.exit(1)
  }
  const n = values.n != null ? Number(values.n) : 200
  const seed = values.seed != null ? Number(values.seed) : 42

  if (!process.env.VITE_MAPBOX_TOKEN) {
    console.error('VITE_MAPBOX_TOKEN missing — the mapbox runtime source cannot fetch. Run from the repo root (bun auto-loads .env).')
    process.exit(1)
  }

  // Non-browser mapbox setup — same pattern as scripts/benchmark-routing.ts:
  // pngjs decoder (no OffscreenCanvas in Bun) + prod Referer for the
  // URL-restricted token. Source is pinned to mapbox-terrain-rgb EXPLICITLY:
  // this diag's whole point is baked-terrarium vs the Mapbox DEM. The pin
  // is deliberate regardless of the module default (which remains mapbox
  // after the reverted 2026-07-03 terrarium flip) — relying on any default
  // risks silently comparing terrarium against itself.
  setElevationSource('mapbox-terrain-rgb')
  setElevationDecoder((bytes) => {
    try {
      const png = PNG.sync.read(Buffer.from(bytes))
      if (png.width !== 256 || png.height !== 256) return null
      return new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length)
    } catch {
      return null
    }
  })
  setElevationReferer('https://bike-map.fryanpan.com/')
  console.log(`[diag-parity] runtime DEM source: ${getElevationSource()}`)

  // ── Sample tiles ─────────────────────────────────────────────────────────
  const allTiles = fs.readdirSync(values.tiles).filter((f) => f.endsWith('.json')).sort()
  const rand = mulberry32(seed)
  const sampled = seededShuffle(allTiles, rand).slice(0, Math.min(n, allTiles.length)).sort()
  console.log(`[diag-parity] ${allTiles.length} baked tiles, sampling ${sampled.length} (seed ${seed})`)

  // ── Load ways (dedupe across tiles; skip 1-coordinate control nodes) ─────
  const ways = new Map<number, SampledWay>()
  let demSource: string | null = null
  for (const file of sampled) {
    const tile = JSON.parse(fs.readFileSync(path.join(values.tiles, file), 'utf8')) as EnrichedTile
    demSource = tile.meta.demSource
    for (const w of tile.ways as EnrichedWay[]) {
      if (w.coordinates.length < 2) continue // control-node pseudo-way — never graded
      if (ways.has(w.osmId)) continue // multi-tile way, identical payload
      ways.set(w.osmId, {
        osmId: w.osmId,
        tags: w.tags,
        coordinates: w.coordinates,
        bakedGradientPct: w.gradientPct,
        bakedAccessGradientPct: w.accessGradientPct,
        bakedComponentPaintedLenM: w.componentPaintedLenM,
      })
    }
  }
  console.log(`[diag-parity] ${ways.size} unique real ways in sample (baked demSource: ${demSource})`)

  // ── Runtime gradient over the mapbox source ──────────────────────────────
  // Per-way prefetch of the way's own bbox guarantees every vertex has fine
  // z=12 data (the bake had full coverage too), so divergences measure the
  // DEM SOURCE difference, not fetch-window truncation. prefetchElevation
  // caches per tile — repeat calls over warm areas are free.
  const runtime = new Map<number, number | null>()
  let processed = 0
  for (const way of ways.values()) {
    let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity
    for (const [lat, lng] of way.coordinates) {
      if (lat < south) south = lat
      if (lat > north) north = lat
      if (lng < west) west = lng
      if (lng > east) east = lng
    }
    await prefetchElevation({ south, west, north, east })
    // Round to the bake's 2-decimal emit precision so the comparison is
    // precision-neutral.
    const g = overlayGradientPct(way.coordinates)
    runtime.set(way.osmId, g == null ? null : Math.round(g * 100) / 100)
    processed++
    if (processed % 25000 === 0) console.log(`[diag-parity] graded ${processed}/${ways.size} ways…`)
  }

  // ── Classification (production classifier over baked tags) ───────────────
  const itemCounts = new Map<string, number>()
  let classifyErrors = 0
  for (const way of ways.values()) {
    for (const mode of MODES) {
      try {
        const item = classifyOsmTagsToItem(way.tags, mode)
        if (mode === MODES[0]) {
          const key = item ?? '(null — LTS 4, never painted)'
          itemCounts.set(key, (itemCounts.get(key) ?? 0) + 1)
        }
      } catch (err) {
        classifyErrors++
        if (classifyErrors <= 3) console.error(`[diag-parity] classify threw for way ${way.osmId}:`, err)
      }
    }
  }

  // ── Compare ───────────────────────────────────────────────────────────────
  const all = [...ways.values()]
  const painted = all.filter((w) => isPaintedCandidate(w.tags))

  interface GradientComparison {
    bothNull: number
    bothNonNull: number
    bakedOnly: number // terrarium graded, mapbox void
    runtimeOnly: number // mapbox graded, terrarium void
    deltas: number[] // |baked - runtime| where both non-null
  }
  function compareGradients(subset: readonly SampledWay[]): GradientComparison {
    const c: GradientComparison = { bothNull: 0, bothNonNull: 0, bakedOnly: 0, runtimeOnly: 0, deltas: [] }
    for (const w of subset) {
      const b = w.bakedGradientPct
      const r = runtime.get(w.osmId) ?? null
      if (b == null && r == null) c.bothNull++
      else if (b != null && r == null) c.bakedOnly++
      else if (b == null && r != null) c.runtimeOnly++
      else {
        c.bothNonNull++
        c.deltas.push(Math.abs(b! - r!))
      }
    }
    c.deltas.sort((a, z) => a - z)
    return c
  }

  interface CeilingCrossings {
    ceilingPct: number
    modes: string[]
    crossings: number // verdict differs between DEMs
    hiddenByBakeOnly: number // baked hides, runtime shows
    hiddenByRuntimeOnly: number // runtime hides, baked shows
    agreementPct: number
    examples: Array<{ osmId: number; highway: string; baked: number | null; runtime: number | null }>
  }
  function crossingsAt(subset: readonly SampledWay[], ceilingPct: number, modes: string[]): CeilingCrossings {
    const out: CeilingCrossings = {
      ceilingPct, modes, crossings: 0, hiddenByBakeOnly: 0, hiddenByRuntimeOnly: 0, agreementPct: 100, examples: [],
    }
    for (const w of subset) {
      const b = shownAtCeiling(w.bakedGradientPct, ceilingPct)
      const r = shownAtCeiling(runtime.get(w.osmId) ?? null, ceilingPct)
      if (b === r) continue
      out.crossings++
      if (!b) out.hiddenByBakeOnly++
      else out.hiddenByRuntimeOnly++
      if (out.examples.length < 5) {
        out.examples.push({
          osmId: w.osmId,
          highway: w.tags.highway ?? '(none)',
          baked: w.bakedGradientPct,
          runtime: runtime.get(w.osmId) ?? null,
        })
      }
    }
    out.agreementPct = subset.length === 0 ? 100 : (1 - out.crossings / subset.length) * 100
    return out
  }

  const ceilings = new Map<number, string[]>()
  for (const mode of MODES) {
    const c = getOverlayMaxGradientPct(mode)
    ceilings.set(c, [...(ceilings.get(c) ?? []), mode])
  }

  const gradAll = compareGradients(all)
  const gradPainted = compareGradients(painted)
  const crossingsPainted = [...ceilings.entries()]
    .sort((a, z) => a[0] - z[0])
    .map(([c, modes]) => crossingsAt(painted, c, modes))
  const crossingsAll = [...ceilings.entries()]
    .sort((a, z) => a[0] - z[0])
    .map(([c, modes]) => crossingsAt(all, c, modes))

  // Worst absolute divergences (both graded) for the report.
  const worst = all
    .filter((w) => w.bakedGradientPct != null && runtime.get(w.osmId) != null)
    .map((w) => ({
      osmId: w.osmId,
      highway: w.tags.highway ?? '(none)',
      lenM: Math.round(wayLengthM(w.coordinates)),
      baked: w.bakedGradientPct!,
      runtime: runtime.get(w.osmId)!,
      delta: Math.abs(w.bakedGradientPct! - runtime.get(w.osmId)!),
    }))
    .sort((a, z) => z.delta - a.delta)
    .slice(0, 10)

  // Baked enrichment coverage for context.
  const accessNonNull = all.filter((w) => w.bakedAccessGradientPct != null).length
  const compLenNonNull = all.filter((w) => w.bakedComponentPaintedLenM != null).length

  // ── Report ────────────────────────────────────────────────────────────────
  const fmtPct = (x: number): string => `${x.toFixed(2)}%`
  function reportGrad(label: string, c: GradientComparison, total: number): void {
    console.log(`\n  ${label} (${total} ways)`)
    console.log(`    both null (agree):        ${c.bothNull}`)
    console.log(`    both graded:              ${c.bothNonNull}`)
    console.log(`    baked-only graded:        ${c.bakedOnly}  (mapbox void / fetch failure)`)
    console.log(`    runtime-only graded:      ${c.runtimeOnly}  (terrarium void)`)
    if (c.deltas.length > 0) {
      const mean = c.deltas.reduce((a, b) => a + b, 0) / c.deltas.length
      const within05 = c.deltas.filter((d) => d <= 0.5).length
      const within1 = c.deltas.filter((d) => d <= 1).length
      const within2 = c.deltas.filter((d) => d <= 2).length
      console.log(`    |Δgradient| over both-graded: mean ${mean.toFixed(3)}pp, p50 ${pct(c.deltas, 50).toFixed(2)}pp, p90 ${pct(c.deltas, 90).toFixed(2)}pp, p99 ${pct(c.deltas, 99).toFixed(2)}pp, max ${pct(c.deltas, 100).toFixed(2)}pp`)
      console.log(`    ≤0.5pp: ${fmtPct((within05 / c.deltas.length) * 100)}   ≤1pp: ${fmtPct((within1 / c.deltas.length) * 100)}   ≤2pp: ${fmtPct((within2 / c.deltas.length) * 100)}`)
    }
  }

  console.log('\n══ diag-parity: baked terrarium vs runtime mapbox (production functions on identical ways) ══')
  console.log(`\nSample: ${sampled.length} tiles, ${all.length} unique ways, ${painted.length} painted candidates (isPaintedCandidate)`)
  console.log(`Classification: classifyOsmTagsToItem ran ${all.length * MODES.length} times, ${classifyErrors} errors — parity exact by construction (identical tags in, client-side classify unchanged)`)
  console.log('\nItem distribution (kid-starting-out):')
  for (const [item, count] of [...itemCounts.entries()].sort((a, z) => z[1] - a[1])) {
    console.log(`    ${item}: ${count}`)
  }

  console.log('\nGradient comparison:')
  reportGrad('all ways', gradAll, all.length)
  reportGrad('painted candidates', gradPainted, painted.length)

  console.log('\nPer-mode SHOW/HIDE verdict parity (null fail-soft shown), painted candidates:')
  for (const c of crossingsPainted) {
    console.log(`  ceiling ${c.ceilingPct}% (${c.modes.join(', ')}):`)
    console.log(`    verdict agreement: ${fmtPct(c.agreementPct)}  (${c.crossings} crossings / ${painted.length})`)
    console.log(`    hidden by bake only: ${c.hiddenByBakeOnly}   hidden by runtime only: ${c.hiddenByRuntimeOnly}`)
    for (const e of c.examples) {
      console.log(`      e.g. way ${e.osmId} (highway=${e.highway}): baked ${e.baked} vs runtime ${e.runtime}`)
    }
  }
  console.log('\nPer-mode SHOW/HIDE verdict parity, ALL ways:')
  for (const c of crossingsAll) {
    console.log(`  ceiling ${c.ceilingPct}%: agreement ${fmtPct(c.agreementPct)} (${c.crossings} crossings, bake-only-hide ${c.hiddenByBakeOnly}, runtime-only-hide ${c.hiddenByRuntimeOnly})`)
  }

  console.log('\nWorst |Δgradient| ways (both graded):')
  for (const w of worst) {
    console.log(`    way ${w.osmId} highway=${w.highway} len=${w.lenM}m: baked ${w.baked.toFixed(2)} vs runtime ${w.runtime.toFixed(2)} (Δ${w.delta.toFixed(2)}pp)`)
  }

  console.log('\nBaked enrichment coverage (context):')
  console.log(`    accessGradientPct non-null:     ${accessNonNull}/${all.length} (${fmtPct((accessNonNull / all.length) * 100)})`)
  console.log(`    componentPaintedLenM non-null:  ${compLenNonNull}/${all.length} (${fmtPct((compLenNonNull / all.length) * 100)}) — null = not a painted candidate`)

  if (values.json) {
    fs.writeFileSync(
      values.json,
      JSON.stringify(
        {
          sampledTiles: sampled.length,
          totalTiles: allTiles.length,
          seed,
          uniqueWays: all.length,
          paintedCandidates: painted.length,
          bakedDemSource: demSource,
          runtimeDemSource: getElevationSource(),
          gradientAll: { ...gradAll, deltas: undefined },
          gradientPainted: { ...gradPainted, deltas: undefined },
          crossingsPainted,
          crossingsAll,
          worst,
          itemCounts: Object.fromEntries(itemCounts),
        },
        null,
        2,
      ) + '\n',
    )
    console.log(`\n[diag-parity] JSON written to ${values.json}`)
  }
}

main().catch((err) => {
  console.error('[diag-parity] FAILED:', err)
  process.exit(1)
})
