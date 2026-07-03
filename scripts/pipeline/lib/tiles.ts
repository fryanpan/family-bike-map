// Enriched tile format + tile bucketing for the enrichment pipeline.
//
// Tile grid: EXACTLY the client's 0.1-degree convention — latLngToTile /
// tileKey are IMPORTED from src/services/overpass.ts, not re-derived, so the
// pipeline can never drift onto a different grid than the client requests.
//
// Payload shape: a superset of the Overpass tile payload (OsmWay[] as built
// by parseOverpassResponse) — same osmId/tags/coordinates/itemName fields,
// plus per-way baked enrichment fields and a meta block. The client treats
// the enrichment fields as optional, so enriched and raw tiles stay
// interchangeable.

import { latLngToTile, tileKey } from '../../../src/services/overpass'

export const PIPELINE_VERSION = '1'

export interface EnrichedTileMeta {
  /** Osmosis replication sequence the tile was built from (provenance). Null when the source PBF carries no replication header and no --seq was given. */
  builtFromSeq: number | null
  /** ISO 8601 build timestamp. Deterministic inputs (--built-at or the PBF replication timestamp) keep output byte-reproducible. */
  builtAt: string
  pipelineVersion: string
  /** DEM identifier for the baked gradients, e.g. "terrarium-v1". Null until chunk B1 wires the DEM pass. */
  demSource: string | null
}

export interface EnrichedWay {
  osmId: number
  /** Always null in stored payloads — classification happens at render time (classifyOsmTagsToItem), same as Overpass tiles. */
  itemName: null
  tags: Record<string, string>
  /** [lat, lng] pairs — same order as parseOverpassResponse. Control-node pseudo-ways have exactly one coordinate. */
  coordinates: [number, number][]
  /** Gross gradient %, same semantics as overlayGradientPct. Null: not yet computed (chunk B1) or DEM void. */
  gradientPct: number | null
  /** Minimax access gradient % from the mainland seed. Null until chunk B1. */
  accessGradientPct: number | null
  /** Total painted-candidate length (m) of the way's connected component. Null until chunk B1. */
  componentPaintedLenM: number | null
}

export interface EnrichedTile {
  meta: EnrichedTileMeta
  ways: EnrichedWay[]
}

/** Parsed, geometry-resolved way ready for bucketing. */
export interface PipelineWay {
  osmId: number
  tags: Record<string, string>
  coordinates: [number, number][]
  /** True for traffic_signals/stop pseudo-ways (single coordinate). */
  isControlNode: boolean
}

export interface TileBucket {
  row: number
  col: number
  /** Real ways, in osmId order. */
  ways: PipelineWay[]
  /** Control-node pseudo-ways, in osmId order — appended AFTER ways, mirroring parseOverpassResponse. */
  controlNodes: PipelineWay[]
}

/**
 * Bucket ways into 0.1-degree tiles. A way lands in every tile containing at
 * least one of its vertices, carrying its FULL geometry — this mirrors
 * Overpass semantics (a bbox query matches ways with ≥1 node inside, and
 * `out geom` returns the whole way). Control nodes land in exactly the tile
 * containing their single coordinate.
 */
export function bucketIntoTiles(ways: PipelineWay[]): Map<string, TileBucket> {
  const buckets = new Map<string, TileBucket>()

  const bucketFor = (row: number, col: number): TileBucket => {
    const key = tileKey(row, col)
    let b = buckets.get(key)
    if (!b) {
      b = { row, col, ways: [], controlNodes: [] }
      buckets.set(key, b)
    }
    return b
  }

  for (const way of ways) {
    const seen = new Set<string>()
    for (const [lat, lng] of way.coordinates) {
      const { row, col } = latLngToTile(lat, lng)
      const key = tileKey(row, col)
      if (seen.has(key)) continue
      seen.add(key)
      const bucket = bucketFor(row, col)
      if (way.isControlNode) bucket.controlNodes.push(way)
      else bucket.ways.push(way)
    }
  }

  // Deterministic ordering inside each bucket.
  for (const b of buckets.values()) {
    b.ways.sort((a, z) => a.osmId - z.osmId)
    b.controlNodes.sort((a, z) => a.osmId - z.osmId)
  }
  return buckets
}

/** Sort a bucket map into a stable emit order: row asc, then col asc. */
export function sortedBuckets(buckets: Map<string, TileBucket>): TileBucket[] {
  return [...buckets.values()].sort((a, z) => a.row - z.row || a.col - z.col)
}

/** Filename for a tile inside the output directory (tileKey uses ':', which is hostile to some filesystems). */
export function tileFileName(row: number, col: number): string {
  return `${row}_${col}.json`
}

function sortTags(tags: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {}
  for (const k of Object.keys(tags).sort()) sorted[k] = tags[k]
  return sorted
}

/** Assemble the tile payload with canonical field order (determinism). */
export function buildEnrichedTile(meta: EnrichedTileMeta, bucket: TileBucket): EnrichedTile {
  const toEnriched = (w: PipelineWay): EnrichedWay => ({
    osmId: w.osmId,
    itemName: null,
    tags: sortTags(w.tags),
    coordinates: w.coordinates,
    // Staged for chunk B1 (gradient + minimax access + component length).
    gradientPct: null,
    accessGradientPct: null,
    componentPaintedLenM: null,
  })
  return {
    meta: {
      builtFromSeq: meta.builtFromSeq,
      builtAt: meta.builtAt,
      pipelineVersion: meta.pipelineVersion,
      demSource: meta.demSource,
    },
    ways: [...bucket.ways.map(toEnriched), ...bucket.controlNodes.map(toEnriched)],
  }
}

/**
 * Canonical byte serialization. Key order is fixed by construction in
 * buildEnrichedTile; this re-normalizes (so round-tripping a parsed tile
 * yields identical bytes) and appends a trailing newline.
 */
export function serializeEnrichedTile(tile: EnrichedTile): string {
  const normalized: EnrichedTile = {
    meta: {
      builtFromSeq: tile.meta.builtFromSeq,
      builtAt: tile.meta.builtAt,
      pipelineVersion: tile.meta.pipelineVersion,
      demSource: tile.meta.demSource,
    },
    ways: tile.ways.map((w) => ({
      osmId: w.osmId,
      itemName: null,
      tags: sortTags(w.tags),
      coordinates: w.coordinates,
      gradientPct: w.gradientPct,
      accessGradientPct: w.accessGradientPct,
      componentPaintedLenM: w.componentPaintedLenM,
    })),
  }
  return JSON.stringify(normalized) + '\n'
}
