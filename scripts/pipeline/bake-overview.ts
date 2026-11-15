// Overview-level bake: 0.1° enriched tiles → 1.0° overview cells (chunk WP2 of
// docs/product/plans/2026-07-12-overlay-zoom-scale-plan.md).
//
//   bun scripts/pipeline/bake-overview.ts --tiles data/tiles/california \
//       [--out data/tiles/california/overview] [--tolerance 0.001] [--min-length 200]
//
// The overlay has no zoom pyramid: 0.1° tiles at every zoom, capped at 64
// nearest-to-centre, so a NorCal-scale view downloads maximum full-detail data
// and still only covers a blob around the cursor. This bake produces the coarse
// level used below OVERVIEW_MAX_ZOOM (z12), served from the same R2 bucket under
// the same manifest (`<version>/overview/<row>_<col>.json`).
//
// TWO deliberate reductions — both are DISPLAY decisions, and the router never
// reads these tiles (it keeps using the 0.1° level via fetchBikeInfraForTile):
//
//   1. BIKE-INFRASTRUCTURE NETWORK ONLY. Keep ways where the production
//      classifier (classifyEdge) yields carFree || bikePriority || bikeInfra.
//      Plain quiet residential is excluded: at z10 one pixel ≈ 150 m, so
//      painting every residential street is a colour wash that answers no
//      question. The overview answers "where is the good bike network?".
//   2. SIMPLIFIED GEOMETRY. Douglas-Peucker at ~0.001° (~110 m — well under one
//      z10 pixel), then drop ways shorter than ~200 m post-simplification
//      (sub-pixel at overview zoom).
//
// Ways keep their FULL tags and enriched fields (gradientPct,
// accessGradientPct, componentPaintedLenM) so the client runs the SAME
// classifier and the SAME visibility gates as on a detail tile. Every function
// that decides anything here is a production import — there is no
// pipeline-local classifier (.claude/rules/routing-changes.md).
//
// Size budget: <= 1.5 MB per overview cell, measured on the RAW JSON. Per-cell
// raw AND gzipped sizes are printed (gzip is what the wire actually carries —
// Cloudflare compresses application/json responses).
//
// MEASURED 2026-07-12 (Bay Area bake, tolerance 0.001°, min-length 200 m):
// the two densest SF cells are 2.7 MB / 2.1 MB raw — OVER the raw budget — but
// 447 KB / ~350 KB gzipped. Tightening --tolerance does NOT fix this: DP already
// leaves 2.6 points per way on average, and raising the tolerance from 0.001° to
// 0.003° moved the worst cell only 2672 KB → 2523 KB. The payload is dominated
// by TAGS (1169 KB of 2672 KB) plus per-way JSON scaffolding, and the tag set is
// deliberately untouchable: the client must run the SAME classifier on an
// overview way as on a detail way. If the raw budget has to be met, the levers
// are --min-length (a geometry/simplification lever: drop more sub-pixel ways)
// or dropping the enriched fields — NOT the tags.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { gzipSync } from 'node:zlib'
import { parseArgs } from 'node:util'

import { classifyEdge } from '../../src/utils/lts'
import { isControlNode } from '../../src/services/overpass'
import { simplifyToTolerance } from '../../src/utils/simplifyPath'
import { wayLengthM } from './lib/graph'
import { tileFileName, type EnrichedTile, type EnrichedTileMeta, type EnrichedWay } from './lib/tiles'

/** Douglas-Peucker tolerance in degrees. ~0.001° ≈ 110 m ≈ 0.7 px at z10. */
export const DEFAULT_TOLERANCE_DEG = 0.001
/** Post-simplification length floor in metres. Below this a way is sub-pixel at overview zoom. */
export const DEFAULT_MIN_LENGTH_M = 200
/** Per-cell size budget (bytes). Exceeding it is a warning, not a hard failure. */
export const SIZE_BUDGET_BYTES = 1_500_000
/** Overview grid pitch, in degrees. Mirrors OVERVIEW_TILE_DEGREES (src/utils/overlayZoom.ts). */
const OVERVIEW_DEGREES = 1

/**
 * Is this way part of the bike-infrastructure NETWORK — the only thing the
 * overview level paints? Production classifier, no local re-derivation.
 */
export function isOverviewCandidate(tags: Record<string, string>): boolean {
  const { carFree, bikePriority, bikeInfra } = classifyEdge(tags)
  return carFree || bikePriority || bikeInfra
}

/** Overview cell (integer degrees) for a coordinate. Mirrors latLngToOverviewCell. */
export function latLngToOverviewCell(lat: number, lng: number): { row: number; col: number } {
  return {
    row: Math.floor(lat / OVERVIEW_DEGREES),
    col: Math.floor(lng / OVERVIEW_DEGREES),
  }
}

export interface ReduceOptions {
  toleranceDeg: number
  minLengthM: number
}

/**
 * Apply both reductions to one way. Returns the reduced way, or null when it
 * doesn't belong on the overview level (not bike infra, a control node, or too
 * short once simplified).
 */
export function reduceWay(way: EnrichedWay, opts: ReduceOptions): EnrichedWay | null {
  // Control-node pseudo-ways are ROUTER input (intersection wait costs) and the
  // router never reads overview tiles — they'd be pure payload here.
  if (isControlNode(way)) return null
  if (way.coordinates.length < 2) return null
  if (!isOverviewCandidate(way.tags)) return null

  const coordinates = simplifyToTolerance(way.coordinates, opts.toleranceDeg)
  if (wayLengthM(coordinates) < opts.minLengthM) return null

  // Everything else rides along untouched — the client's classifier and gates
  // must see exactly what they'd see on a detail tile.
  return { ...way, coordinates }
}

/**
 * Bucket reduced ways into 1.0° cells. A way lands in every cell containing at
 * least one of its (simplified) vertices, carrying its full geometry — same
 * semantics as bucketIntoTiles at the detail level, so a way crossing a cell
 * seam paints continuously on both sides.
 */
export function bucketIntoOverviewCells(
  ways: EnrichedWay[],
): Map<string, { row: number; col: number; ways: EnrichedWay[] }> {
  const cells = new Map<string, { row: number; col: number; ways: EnrichedWay[] }>()
  for (const way of ways) {
    const seen = new Set<string>()
    for (const [lat, lng] of way.coordinates) {
      const { row, col } = latLngToOverviewCell(lat, lng)
      const key = `${row}:${col}`
      if (seen.has(key)) continue
      seen.add(key)
      let cell = cells.get(key)
      if (!cell) {
        cell = { row, col, ways: [] }
        cells.set(key, cell)
      }
      cell.ways.push(way)
    }
  }
  for (const cell of cells.values()) cell.ways.sort((a, z) => a.osmId - z.osmId)
  return cells
}

/** Canonical serialization — same field order as serializeEnrichedTile. */
export function serializeOverviewTile(tile: EnrichedTile): string {
  return JSON.stringify(tile) + '\n'
}

// ── Runner ────────────────────────────────────────────────────────────────

const TILE_FILE_RE = /^-?\d+_-?\d+\.json$/

/**
 * Read every 0.1° tile in `dir`, de-duplicating ways by osmId (a way with
 * vertices in several tiles is stored in each of them, with identical full
 * geometry — bucketIntoTiles).
 */
export function readDetailWays(dir: string): { ways: EnrichedWay[]; meta: EnrichedTileMeta } {
  const files = fs.readdirSync(dir).filter((n) => TILE_FILE_RE.test(n)).sort()
  if (files.length === 0) throw new Error(`no tile files (<row>_<col>.json) found in ${dir}`)

  const byId = new Map<number, EnrichedWay>()
  let meta: EnrichedTileMeta | null = null
  for (const name of files) {
    const tile = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as EnrichedTile
    meta ??= tile.meta
    for (const way of tile.ways) {
      if (!byId.has(way.osmId)) byId.set(way.osmId, way)
    }
  }
  return {
    ways: [...byId.values()].sort((a, z) => a.osmId - z.osmId),
    meta: meta!,
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tiles: { type: 'string' },
      out: { type: 'string' },
      tolerance: { type: 'string' },
      'min-length': { type: 'string' },
    },
  })

  if (!values.tiles) {
    console.error('usage: bun scripts/pipeline/bake-overview.ts --tiles <0.1°-tile-dir> [--out <dir>] [--tolerance 0.001] [--min-length 200]')
    process.exit(2)
  }

  const tilesDir = path.resolve(values.tiles)
  // Default: the `overview/` subdir of the tile dir — that's where
  // upload-tiles.ts looks for the overview level (uploaded under
  // `<version>/overview/`, resolved through the same manifest).
  const outDir = path.resolve(values.out ?? path.join(tilesDir, 'overview'))
  const opts: ReduceOptions = {
    toleranceDeg: values.tolerance ? Number(values.tolerance) : DEFAULT_TOLERANCE_DEG,
    minLengthM: values['min-length'] ? Number(values['min-length']) : DEFAULT_MIN_LENGTH_M,
  }

  console.log(`Baking overview tiles from ${tilesDir}`)
  console.log(`  tolerance: ${opts.toleranceDeg}° (~${Math.round(opts.toleranceDeg * 111_000)} m), min length: ${opts.minLengthM} m`)

  const { ways, meta } = readDetailWays(tilesDir)
  const reduced: EnrichedWay[] = []
  for (const way of ways) {
    const r = reduceWay(way, opts)
    if (r) reduced.push(r)
  }
  console.log(`  ${ways.length} distinct ways → ${reduced.length} kept (${((reduced.length / Math.max(1, ways.length)) * 100).toFixed(1)}%)`)

  const cells = bucketIntoOverviewCells(reduced)
  fs.mkdirSync(outDir, { recursive: true })

  const sorted = [...cells.values()].sort((a, z) => a.row - z.row || a.col - z.col)
  let overBudget = 0
  let totalBytes = 0
  for (const cell of sorted) {
    const tile: EnrichedTile = { meta, ways: cell.ways }
    const body = serializeOverviewTile(tile)
    const bytes = Buffer.byteLength(body)
    totalBytes += bytes
    const file = path.join(outDir, tileFileName(cell.row, cell.col))
    fs.writeFileSync(file, body)
    const gzipped = gzipSync(body).byteLength
    const over = bytes > SIZE_BUDGET_BYTES
    if (over) overBudget++
    console.log(
      `  ${tileFileName(cell.row, cell.col)}: ${cell.ways.length} ways, ` +
      `${(bytes / 1024).toFixed(0)} KB raw / ${(gzipped / 1024).toFixed(0)} KB gzipped` +
      `${over ? '  ⚠ OVER RAW BUDGET' : ''}`,
    )
  }

  console.log(`\nWrote ${sorted.length} overview cells to ${outDir} (${(totalBytes / 1024 / 1024).toFixed(1)} MB total)`)
  if (overBudget > 0) {
    console.warn(
      `⚠ ${overBudget} cell(s) exceed the ${(SIZE_BUDGET_BYTES / 1_000_000).toFixed(1)} MB RAW budget.\n` +
      `  Check the gzipped column first — that's what the wire carries. If raw size must come down,\n` +
      `  --tolerance is a weak lever here (measured: 0.001° → 0.003° moved the worst cell 2.7 → 2.5 MB);\n` +
      `  use --min-length. Do NOT strip tags: the client runs the same classifier on both levels.`,
    )
  }
  console.log('Upload with: bun scripts/pipeline/upload-tiles.ts --tiles <tile-dir>  (the overview/ subdir rides along)')
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(String(err?.stack ?? err))
    process.exit(1)
  })
}
