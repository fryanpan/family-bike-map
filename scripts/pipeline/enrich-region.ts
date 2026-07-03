// Enrichment pipeline — region bake (chunk A2: skeleton, geometry + schema).
//
//   bun scripts/pipeline/enrich-region.ts --pbf data/norcal.osm.pbf --out data/tiles \
//       [--bbox south,west,north,east] [--built-at ISO] [--seq N]
//
// Reads a Geofabrik-style .osm.pbf, filters to EXACTLY the bike-relevant way
// set the client fetches from Overpass (lib/filter.ts mirrors
// buildQuery() in src/services/overpass.ts), buckets ways into the client's
// 0.1-degree tiles (grid imported from src/services/overpass.ts), and emits
// one enriched tile JSON per tile (schema: lib/tiles.ts).
//
// In this chunk gradientPct / accessGradientPct / componentPaintedLenM are
// emitted as null — chunk B1 fills them (DEM + minimax access + component
// pass). The schema is complete so downstream chunks (Worker serving, client
// consumption) can build against it now.
//
// Determinism: given the same PBF and the same --built-at / --seq, two runs
// are byte-identical (stable way order, sorted tag keys, sorted tile emit
// order). Pass --built-at for reproducible builds when the PBF has no
// replication timestamp header.
//
// Large source PBFs live under data/ (gitignored).

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
} from './lib/tiles'

export interface EnrichRegionOptions {
  pbf: string
  out: string
  /** Optional clip box. Pass tile-aligned (multiples of 0.1°) bounds to avoid partial edge tiles. */
  bbox?: { south: number; west: number; north: number; east: number }
  /** Overrides meta.builtAt (needed for byte-reproducible output when the PBF has no replication timestamp). */
  builtAt?: string
  /** Overrides meta.builtFromSeq (default: PBF replication header, else null). */
  seq?: number
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

function resolveMeta(pbf: string, opts: EnrichRegionOptions): EnrichedTileMeta {
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
    // Chunk B1 sets this to the actual DEM id (e.g. "terrarium-v1").
    demSource: null,
  }
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

    // 5. Emit tiles. Provenance meta comes from the ORIGINAL pbf (the clip
    // inherits its header, but read the source of truth directly).
    const meta = resolveMeta(opts.pbf, opts)
    fs.mkdirSync(opts.out, { recursive: true })
    const tilesWritten: string[] = []
    for (const bucket of sortedBuckets(buckets)) {
      const tile = buildEnrichedTile(meta, bucket)
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
    },
  })
  if (!values.pbf || !values.out) {
    console.error(
      'Usage: bun scripts/pipeline/enrich-region.ts --pbf <file.osm.pbf> --out <dir> ' +
      '[--bbox south,west,north,east] [--built-at ISO] [--seq N]',
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
