// Terrarium DEM provider + per-way gradient bake for the enrichment
// pipeline (chunk B1).
//
// ONE-implementation rule: everything that decides a NUMBER is a
// production import, not a pipeline re-derivation —
//
//   - per-pixel elevation decode + nearest-pixel sampling:
//     `lookupElevation` in src/services/elevation.ts, fed by seeding
//     decoded terrarium tiles into that module's cache
//     (`setElevationSource('terrarium')` + `_seedTile`). The pipeline
//     never re-implements the terrarium formula or the pixel-picking
//     (floor + clamp) convention — a bake lookup IS a production lookup.
//   - the per-way gradient formula: `computeWayGradientPct` (the single
//     formula behind the overlay's `overlayGradientPct`), called with
//     floorScale=1 — the fine-data (z=12) semantics.
//
// What this module ADDS is only the offline fetch layer the browser code
// deliberately doesn't have:
//
//   - HTTP fetch of AWS Terrain Tiles (open data, no token/Referer) with
//     an on-disk PNG cache under data/dem-cache/ so repeat bakes are
//     network-free and byte-deterministic;
//   - bounded fetch concurrency (default 8, foreground);
//   - LRU eviction of decoded tiles so a region-scale bake holds a
//     bounded window of DEM pixels in memory (a decoded tile is 256 KB;
//     a NorCal bake touches thousands of tiles).
//
// Fails soft exactly like production: a tile that can't be fetched or
// decoded is seeded as fetched-and-failed (null), so `lookupElevation`
// returns null there and `computeWayGradientPct` yields a null gradient
// ("DEM void" — shown, ungated) rather than a wrong number.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { PNG } from 'pngjs'

import {
  computeWayGradientPct,
  lngLatToTile,
  lookupElevation,
  setElevationSource,
  _seedTile,
} from '../../../src/services/elevation'
import type { PipelineWay } from './tiles'

/**
 * Bake zoom. Keep in sync with elevation.ts's private TILE_ZOOM (12):
 * `lookupElevation` reads z=12 tiles ONLY, so seeding any other zoom
 * would silently produce null lookups everywhere.
 */
export const DEM_TILE_ZOOM = 12

/** 256×256 RGBA — keep in sync with elevation.ts's private TILE_SIZE. */
const TILE_SIZE = 256
const TILE_RGBA_LENGTH = TILE_SIZE * TILE_SIZE * 4

/** Value stamped into EnrichedTileMeta.demSource when the bake ran. */
export const DEM_SOURCE_ID = 'terrarium-v1'

const TERRARIUM_URL_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'

export interface TerrariumDemOptions {
  /** On-disk PNG cache root, e.g. data/dem-cache (gitignored via data/.gitignore). */
  cacheDir: string
  /** Injectable fetch for tests. Default: global fetch. */
  fetchImpl?: typeof fetch
  /** Max concurrent HTTP fetches. Default 8. */
  concurrency?: number
  /** Max decoded tiles held in memory (LRU). Default 512 (~128 MB). */
  maxCachedTiles?: number
}

export interface TerrariumDemStats {
  httpFetches: number
  diskHits: number
  failures: number
}

export interface TerrariumDem {
  /**
   * Make every z=12 tile covering `coords` available to `lookup`. MUST be
   * awaited over the exact coords about to be looked up — eviction only
   * spares the tiles of the CURRENT ensure call, so interleaving lookups
   * of older coords may read evicted (null) tiles.
   */
  ensureCoords(coords: Iterable<[number, number]>): Promise<void>
  /** Production `lookupElevation` (null = DEM void, fail-soft). */
  lookup(lat: number, lng: number): number | null
  stats: TerrariumDemStats
}

/** PNG bytes → RGBA pixels. Returns null on any decode problem (fail-soft). */
function decodePngRgba(bytes: Buffer): Uint8ClampedArray | null {
  try {
    const png = PNG.sync.read(bytes)
    if (png.width !== TILE_SIZE || png.height !== TILE_SIZE) return null
    const data = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length)
    if (data.length !== TILE_RGBA_LENGTH) return null
    return data
  } catch {
    return null
  }
}

/** Run `fn` over `items` with at most `limit` in flight (foreground). */
async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}

export function createTerrariumDem(opts: TerrariumDemOptions): TerrariumDem {
  const fetchImpl = opts.fetchImpl ?? fetch
  const concurrency = opts.concurrency ?? 8
  const maxCachedTiles = opts.maxCachedTiles ?? 512
  const stats: TerrariumDemStats = { httpFetches: 0, diskHits: 0, failures: 0 }

  // The bake decodes with the terrarium formula via the production module
  // switch. Cache keys there embed the source, so this can never
  // cross-decode a mapbox tile that happens to be cached.
  setElevationSource('terrarium')

  // Insertion order = LRU order (touch = delete + re-set).
  const seeded = new Map<string, { x: number; y: number }>()
  // Fetched-and-failed this run — don't retry, matching production's
  // per-session null cache entries.
  const failed = new Set<string>()

  const tileFile = (x: number, y: number): string =>
    path.join(opts.cacheDir, 'terrarium', String(DEM_TILE_ZOOM), String(x), `${y}.png`)

  async function loadTile(x: number, y: number): Promise<void> {
    const key = `${x}/${y}`
    const file = tileFile(x, y)
    let bytes: Buffer | null = null
    if (fs.existsSync(file)) {
      bytes = fs.readFileSync(file)
      stats.diskHits++
    } else {
      try {
        const res = await fetchImpl(`${TERRARIUM_URL_BASE}/${DEM_TILE_ZOOM}/${x}/${y}.png`)
        if (res.ok) {
          bytes = Buffer.from(await res.arrayBuffer())
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, bytes)
          stats.httpFetches++
        }
      } catch {
        // fall through to the failure path
      }
    }
    const data = bytes ? decodePngRgba(bytes) : null
    if (data == null) {
      stats.failures++
      failed.add(key)
      // Fetched-and-failed: lookups over this tile return null (fail-soft
      // DEM void), same as the production fetch path on a 404.
      _seedTile(DEM_TILE_ZOOM, x, y, null)
      return
    }
    _seedTile(DEM_TILE_ZOOM, x, y, data)
    seeded.set(key, { x, y })
  }

  return {
    stats,
    lookup: (lat: number, lng: number): number | null => lookupElevation(lat, lng),
    async ensureCoords(coords: Iterable<[number, number]>): Promise<void> {
      const needed = new Map<string, { x: number; y: number }>()
      for (const [lat, lng] of coords) {
        const { x, y } = lngLatToTile(lng, lat, DEM_TILE_ZOOM)
        needed.set(`${x}/${y}`, { x, y })
      }
      const missing: Array<{ x: number; y: number }> = []
      for (const [key, tile] of needed) {
        const hit = seeded.get(key)
        if (hit) {
          // LRU touch.
          seeded.delete(key)
          seeded.set(key, hit)
          continue
        }
        if (failed.has(key)) continue
        missing.push(tile)
      }
      await mapLimit(missing, concurrency, (t) => loadTile(t.x, t.y))
      // Evict beyond the cap — never a tile this call needs, so lookups
      // that follow an awaited ensure always see their tiles. Eviction
      // re-seeds null; a later ensure reloads from disk (free).
      if (seeded.size > maxCachedTiles) {
        for (const [key, t] of seeded) {
          if (seeded.size <= maxCachedTiles) break
          if (needed.has(key)) continue
          _seedTile(DEM_TILE_ZOOM, t.x, t.y, null)
          seeded.delete(key)
        }
      }
    },
  }
}

/**
 * Per-way gross gradient (%) over the whole region: the production
 * formula (`computeWayGradientPct`, floorScale=1 — z=12 fine-data
 * semantics) fed by the terrarium DEM.
 *
 * Memory discipline: ways are processed grouped by the z=12 DEM tile of
 * their midpoint (sorted — deterministic order, spatial fetch locality
 * for the LRU), and per-vertex elevations exist only inside the formula
 * call — nothing per-vertex is retained. Output is one scalar per way.
 *
 * Returns null for a way when the DEM is void over it or it is shorter
 * than the noise floor — identical semantics to the runtime overlay.
 * Control-node pseudo-ways (single coordinate) are skipped entirely.
 */
export async function bakeWayGradients(
  ways: readonly PipelineWay[],
  dem: TerrariumDem,
): Promise<Map<number, number | null>> {
  const groups = new Map<string, PipelineWay[]>()
  for (const way of ways) {
    if (way.isControlNode || way.coordinates.length < 2) continue
    const [lat, lng] = way.coordinates[Math.floor(way.coordinates.length / 2)]
    const { x, y } = lngLatToTile(lng, lat, DEM_TILE_ZOOM)
    const key = `${x}/${y}`
    const group = groups.get(key)
    if (group) group.push(way)
    else groups.set(key, [way])
  }

  const result = new Map<number, number | null>()
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!
    // Ensure covers EVERY vertex of the group's ways (a long way can leave
    // its midpoint tile), so the synchronous formula below never reads an
    // unseeded tile.
    await dem.ensureCoords(group.flatMap((w) => w.coordinates))
    for (const way of group) {
      result.set(way.osmId, computeWayGradientPct(way.coordinates, dem.lookup, 1))
    }
  }
  return result
}
