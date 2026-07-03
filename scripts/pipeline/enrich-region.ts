// Enrichment pipeline — region bake.
//
//   bun scripts/pipeline/enrich-region.ts --pbf data/norcal.osm.pbf --out data/tiles \
//       [--bbox south,west,north,east] [--built-at ISO] [--seq N] \
//       [--dem-cache data/dem-cache] [--no-dem]
//
// Reads a Geofabrik-style .osm.pbf, filters to EXACTLY the bike-relevant way
// set the client fetches from Overpass (lib/filter.ts mirrors
// buildQuery() in src/services/overpass.ts), buckets ways into the client's
// 0.1-degree tiles (grid imported from src/services/overpass.ts), and emits
// one enriched tile JSON per tile (schema: lib/tiles.ts).
//
// Chunk B1 bakes the numbers, all via production functions (no parallel
// implementations — see lib/dem.ts and lib/graph.ts headers):
//   - gradientPct           computeWayGradientPct over the terrarium DEM
//                           (HTTP + on-disk cache under data/dem-cache/)
//   - accessGradientPct     minimax Dijkstra from the mainland seed
//   - componentPaintedLenM  per-component painted-candidate length
//
// Determinism: given the same PBF, the same --built-at / --seq, and the
// same DEM tiles (the on-disk cache pins them), two runs are byte-identical
// (stable way order, sorted tag keys, sorted tile emit order, deterministic
// graph passes). Pass --built-at for reproducible builds when the PBF has
// no replication timestamp header.
//
// Large downloads (source PBFs, DEM tiles) live under data/ (gitignored).

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { parseArgs } from 'node:util'

import {
  assertOsmiumAvailable,
  osmiumCatToOpl,
  osmiumCoarseTagsFilter,
  osmiumExtract,
  readPbfHeaderValue,
} from './lib/osmium'
import { parseOplLine } from './lib/opl'
import { matchesOverpassControlNodeFilter, matchesOverpassWayFilter } from './lib/filter'
import {
  PIPELINE_VERSION,
  bucketIntoTiles,
  buildEnrichedTile,
  serializeEnrichedTile,
  sortedBuckets,
  tileFileName,
  type EnrichedTileMeta,
  type PipelineWay,
  type WayEnrichment,
} from './lib/tiles'
import {
  DEM_SOURCE_ID,
  bakeWayGradients,
  createTerrariumDem,
  type TerrariumDemOptions,
} from './lib/dem'
import { computeAccessGradientPct, computeComponentPaintedLenM } from './lib/graph'

export interface EnrichRegionOptions {
  pbf: string
  out: string
  /** Optional clip box. Pass tile-aligned (multiples of 0.1°) bounds to avoid partial edge tiles. */
  bbox?: { south: number; west: number; north: number; east: number }
  /** Overrides meta.builtAt (needed for byte-reproducible output when the PBF has no replication timestamp). */
  builtAt?: string
  /** Overrides meta.builtFromSeq (default: PBF replication header, else null). */
  seq?: number
  /**
   * Terrarium DEM configuration for the gradient bake. Omit to skip the DEM
   * pass entirely (gradientPct null everywhere, meta.demSource null) — the
   * access + component passes still run, with null gradients fail-soft
   * passable. The CLI defaults this ON (cache under data/dem-cache);
   * programmatic callers (tests) opt in explicitly so the bake stays hermetic.
   */
  dem?: TerrariumDemOptions
}

export interface EnrichRegionResult {
  /** Tile filenames written, in emit order. */
  tilesWritten: string[]
  wayCount: number
  controlNodeCount: number
  meta: EnrichedTileMeta
}

interface ParsedRegion {
  ways: PipelineWay[]
  wayCount: number
  controlNodeCount: number
}

/**
 * Stream-parse an OPL file: collect node coordinates, admit ways via the
 * Overpass-mirror filter, resolve way geometry, and lift traffic-control
 * nodes into single-coordinate pseudo-ways (same convention as
 * parseOverpassResponse in src/services/overpass.ts).
 *
 * Relies on OPL object order (nodes before ways — guaranteed for sorted OSM
 * files, which Geofabrik extracts and osmium outputs are).
 */
async function parseOplFile(oplPath: string): Promise<ParsedRegion> {
  const nodeCoords = new Map<number, [number, number]>()
  const controlNodes: PipelineWay[] = []
  const ways: PipelineWay[] = []

  const rl = readline.createInterface({
    input: fs.createReadStream(oplPath, 'utf8'),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    const obj = parseOplLine(line)
    if (obj == null) continue
    if (obj.type === 'node') {
      nodeCoords.set(obj.id, [obj.lat, obj.lon])
      if (matchesOverpassControlNodeFilter(obj.tags)) {
        controlNodes.push({
          osmId: obj.id,
          tags: obj.tags,
          coordinates: [[obj.lat, obj.lon]],
          isControlNode: true,
        })
      }
      continue
    }
    // Way — apply the exact Overpass-mirror predicate.
    if (!matchesOverpassWayFilter(obj.tags)) continue
    const coordinates: [number, number][] = []
    for (const ref of obj.nodeRefs) {
      const coord = nodeCoords.get(ref)
      if (coord) coordinates.push(coord)
      // Missing refs can only come from a clipped extract; skip silently —
      // Overpass parity is per-node, not per-ref.
    }
    if (coordinates.length < 2) continue // no drawable/routable geometry left
    ways.push({ osmId: obj.id, tags: obj.tags, coordinates, isControlNode: false })
  }

  return {
    ways: [...ways, ...controlNodes],
    wayCount: ways.length,
    controlNodeCount: controlNodes.length,
  }
}

function resolveMeta(pbf: string, opts: EnrichRegionOptions, demSource: string | null): EnrichedTileMeta {
  let builtFromSeq: number | null = null
  if (opts.seq != null) {
    builtFromSeq = opts.seq
  } else {
    const headerSeq = readPbfHeaderValue(pbf, 'header.option.osmosis_replication_sequence_number')
    if (headerSeq != null && Number.isFinite(Number(headerSeq))) builtFromSeq = Number(headerSeq)
  }

  let builtAt = opts.builtAt ?? null
  if (builtAt == null) {
    builtAt = readPbfHeaderValue(pbf, 'header.option.osmosis_replication_timestamp')
  }
  if (builtAt == null) {
    builtAt = new Date().toISOString()
    console.warn(
      '[enrich-region] PBF has no replication timestamp and no --built-at given; ' +
      'using current time — output will NOT be byte-reproducible across runs.',
    )
  }

  return {
    builtFromSeq,
    builtAt,
    pipelineVersion: PIPELINE_VERSION,
    demSource,
  }
}

// Emit-time rounding: baked scalars are gate inputs (compared against mode
// ceilings / the display floor), not survey data — 2 decimals of gradient
// and 0.1 m of length keep tile JSONs compact without moving any way
// across a ceiling in practice.
function round2(v: number | null): number | null {
  return v == null ? null : Math.round(v * 100) / 100
}

function round1(v: number | null): number | null {
  return v == null ? null : Math.round(v * 10) / 10
}

export async function enrichRegion(opts: EnrichRegionOptions): Promise<EnrichRegionResult> {
  assertOsmiumAvailable()
  if (!fs.existsSync(opts.pbf)) throw new Error(`--pbf not found: ${opts.pbf}`)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-region-'))
  try {
    // 1. Optional bbox clip (full-geometry strategy — see lib/osmium.ts).
    let workingPbf = opts.pbf
    if (opts.bbox) {
      const clipped = path.join(tmpDir, 'clipped.osm.pbf')
      osmiumExtract(workingPbf, clipped, opts.bbox)
      workingPbf = clipped
    }

    // 2. Coarse C++ prefilter (superset), then 3. dump to OPL text.
    const filtered = path.join(tmpDir, 'filtered.osm.pbf')
    osmiumCoarseTagsFilter(workingPbf, filtered)
    const opl = path.join(tmpDir, 'filtered.opl')
    osmiumCatToOpl(filtered, opl)

    // 4. Exact filter + geometry resolution + tile bucketing.
    const region = await parseOplFile(opl)
    const buckets = bucketIntoTiles(region.ways)

    // 5. Bake the numbers (chunk B1) — all through production functions.
    // 5a. Per-way gross gradient over the terrarium DEM (skipped without
    //     opts.dem: gradients stay null, which every downstream pass treats
    //     as fail-soft unknown).
    let gradients = new Map<number, number | null>()
    let demSource: string | null = null
    if (opts.dem) {
      const dem = createTerrariumDem(opts.dem)
      gradients = await bakeWayGradients(region.ways, dem)
      demSource = DEM_SOURCE_ID
      console.log(
        `[enrich-region] DEM: ${dem.stats.httpFetches} fetched, ` +
        `${dem.stats.diskHits} from disk cache, ${dem.stats.failures} voids`,
      )
    }
    const gradientOf = (osmId: number): number | null => gradients.get(osmId) ?? null
    // 5b. Minimax access from the mainland seed; 5c. painted component length.
    const accessGradients = computeAccessGradientPct(region.ways, gradientOf)
    const paintedLenM = computeComponentPaintedLenM(region.ways)
    const enrichment: WayEnrichment = {
      gradientPct: (osmId) => round2(gradientOf(osmId)),
      accessGradientPct: (osmId) => round2(accessGradients.get(osmId) ?? null),
      componentPaintedLenM: (osmId) => round1(paintedLenM.get(osmId) ?? null),
    }

    // 6. Emit tiles. Provenance meta comes from the ORIGINAL pbf (the clip
    // inherits its header, but read the source of truth directly).
    const meta = resolveMeta(opts.pbf, opts, demSource)
    fs.mkdirSync(opts.out, { recursive: true })
    const tilesWritten: string[] = []
    for (const bucket of sortedBuckets(buckets)) {
      const tile = buildEnrichedTile(meta, bucket, enrichment)
      const name = tileFileName(bucket.row, bucket.col)
      fs.writeFileSync(path.join(opts.out, name), serializeEnrichedTile(tile))
      tilesWritten.push(name)
    }

    return {
      tilesWritten,
      wayCount: region.wayCount,
      controlNodeCount: region.controlNodeCount,
      meta,
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

function parseBbox(raw: string): { south: number; west: number; north: number; east: number } {
  const parts = raw.split(',').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new Error(`--bbox must be "south,west,north,east", got: ${raw}`)
  }
  const [south, west, north, east] = parts
  if (south >= north || west >= east) {
    throw new Error(`--bbox is empty or inverted (south<north, west<east required): ${raw}`)
  }
  return { south, west, north, east }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      pbf: { type: 'string' },
      out: { type: 'string' },
      bbox: { type: 'string' },
      'built-at': { type: 'string' },
      seq: { type: 'string' },
      'dem-cache': { type: 'string' },
      'no-dem': { type: 'boolean' },
    },
  })
  if (!values.pbf || !values.out) {
    console.error(
      'Usage: bun scripts/pipeline/enrich-region.ts --pbf <file.osm.pbf> --out <dir> ' +
      '[--bbox south,west,north,east] [--built-at ISO] [--seq N] ' +
      '[--dem-cache data/dem-cache] [--no-dem]',
    )
    process.exit(1)
  }

  const started = Date.now()
  const result = await enrichRegion({
    pbf: values.pbf,
    out: values.out,
    bbox: values.bbox ? parseBbox(values.bbox) : undefined,
    builtAt: values['built-at'],
    seq: values.seq != null ? Number(values.seq) : undefined,
    // DEM defaults ON for CLI runs; --no-dem skips the gradient bake
    // (e.g. offline smoke runs). The cache dir lives under data/
    // (gitignored) unless overridden.
    dem: values['no-dem'] ? undefined : { cacheDir: values['dem-cache'] ?? 'data/dem-cache' },
  })
  console.log(
    `[enrich-region] ${result.tilesWritten.length} tiles, ${result.wayCount} ways, ` +
    `${result.controlNodeCount} control nodes in ${((Date.now() - started) / 1000).toFixed(1)}s ` +
    `(seq=${result.meta.builtFromSeq ?? 'none'}, builtAt=${result.meta.builtAt})`,
  )
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[enrich-region] FAILED:', err)
    process.exit(1)
  })
}
