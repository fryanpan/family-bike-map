/**
 * Enriched-tile serving from R2 — Worker-side logic for the /api/overpass
 * tile route (docs/product/plans/enriched-tiles-plan.md, chunk C3).
 *
 * Layout in the bucket (bike-map-enriched-tiles):
 *
 *   manifest.json              → { "version": "<prefix>", ... } names the ACTIVE tileset
 *   <version>/<row>_<col>.json → enriched tile payloads (schema: scripts/pipeline/lib/tiles.ts)
 *
 * The manifest is the atomic cutover point: `scripts/pipeline/upload-tiles.ts`
 * uploads every tile under a NEW version prefix first and writes manifest.json
 * LAST, so readers only ever see a complete tileset. Rollback = re-put the
 * manifest pointing at the previous prefix (no deploy, no tile re-upload).
 *
 * Fail-open by design: any R2 error, missing manifest, malformed manifest, or
 * missing tile object returns null and the caller falls through to the
 * existing Overpass proxy path unchanged — non-enriched regions (Berlin until
 * its bake) must keep working exactly as before.
 *
 * The manifest is cached in isolate memory for MANIFEST_TTL_MS (both present
 * and absent results) so a map pan doesn't issue one manifest GET per tile.
 * Consequence: a cutover/rollback becomes visible per isolate within ~60s.
 * Enriched tile bodies are intentionally NOT edge-cached — R2 reads are
 * same-network and cheap, and caching them would stretch the rollback window
 * from the manifest TTL to the cache TTL.
 *
 * Object-key naming lives here (enrichedTileObjectKey) and is imported by the
 * upload tool — one implementation, writer and reader can't drift.
 */

// Minimal structural slice of the Workers R2 API (the repo doesn't use
// @cloudflare/workers-types; src/worker.ts declares its bindings the same way).
export interface R2ObjectBodyLike {
  body: ReadableStream | null
  text(): Promise<string>
}
export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>
}

export const MANIFEST_KEY = 'manifest.json'
export const MANIFEST_TTL_MS = 60_000

export interface EnrichedManifest {
  /** Active tileset prefix — objects live at `<version>/<row>_<col>.json`. */
  version: string
  /** Provenance / bookkeeping written by upload-tiles.ts; unused by the Worker. */
  builtFromSeq?: number | null
  pipelineVersion?: string
  demSource?: string | null
  tileCount?: number
  /** Number of 1.0° overview cells uploaded under `<version>/overview/`. 0 / absent = no overview level in this version (client falls back to 0.1° tiles). */
  overviewTileCount?: number
  uploadedAt?: string
}

/** R2 object key for one enriched tile. Mirrors tileFileName() in scripts/pipeline/lib/tiles.ts (`<row>_<col>.json`). */
export function enrichedTileObjectKey(version: string, row: number, col: number): string {
  return `${version}/${row}_${col}.json`
}

/**
 * Sub-prefix for the coarse 1.0° OVERVIEW level inside a version, so BOTH
 * levels live under one version prefix and one manifest — `--rollback-to`
 * reverts detail and overview tiles in a single manifest write.
 */
export const OVERVIEW_PREFIX = 'overview'

/** R2 object key for one 1.0° overview cell (row/col = integer degrees). */
export function overviewTileObjectKey(version: string, row: number, col: number): string {
  return `${version}/${OVERVIEW_PREFIX}/${row}_${col}.json`
}

/** Strict integer parse for ?row=/&col= query params ("377", "-1223"). Anything else → null. */
export function parseTileCoord(value: string | null): number | null {
  if (value == null || !/^-?\d+$/.test(value)) return null
  return Number(value)
}

/**
 * Validate a parsed manifest body. The version becomes an object-key prefix,
 * so reject anything that could escape the expected layout (empty, slashes at
 * the edges, path traversal) — a malformed manifest fails open to Overpass
 * rather than serving garbage keys.
 */
export function parseManifest(text: string): EnrichedManifest | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const version = (data as { version?: unknown }).version
  if (typeof version !== 'string' || version.length === 0) return null
  if (version.startsWith('/') || version.endsWith('/') || version.includes('..')) return null
  return data as unknown as EnrichedManifest
}

interface ManifestCacheEntry {
  manifest: EnrichedManifest | null
  fetchedAt: number
}

let _manifestCache: ManifestCacheEntry | null = null

/** Test hook — clears the isolate-level manifest cache. */
export function _resetManifestCache(): void {
  _manifestCache = null
}

async function getActiveManifest(
  bucket: R2BucketLike,
  now: number,
): Promise<EnrichedManifest | null> {
  if (_manifestCache && now - _manifestCache.fetchedAt < MANIFEST_TTL_MS) {
    return _manifestCache.manifest
  }
  const obj = await bucket.get(MANIFEST_KEY)
  const manifest = obj ? parseManifest(await obj.text()) : null
  _manifestCache = { manifest, fetchedAt: now }
  return manifest
}

export interface GetEnrichedTileOptions {
  /** Injectable clock for manifest-TTL tests. */
  now?: number
  /** Called with any R2/parse error before failing open (worker wires Sentry here). */
  onError?: (err: unknown) => void
}

/**
 * Serve one enriched tile from R2, or null when the request should fall
 * through to the Overpass proxy (no manifest, no object, or any error).
 */
export async function getEnrichedTileResponse(
  bucket: R2BucketLike,
  row: number,
  col: number,
  opts: GetEnrichedTileOptions = {},
): Promise<Response | null> {
  const now = opts.now ?? Date.now()
  try {
    const manifest = await getActiveManifest(bucket, now)
    if (!manifest) return null

    const obj = await bucket.get(enrichedTileObjectKey(manifest.version, row, col))
    if (!obj) return null

    return new Response(obj.body, {
      headers: {
        'Content-Type': 'application/json',
        // Distinguishable from the Overpass proxy's HIT/MISS in devtools/curl.
        'X-Cache': 'R2',
        'X-Tile-Source': 'enriched',
        'X-Enriched-Version': manifest.version,
      },
    })
  } catch (err) {
    opts.onError?.(err)
    return null
  }
}

/**
 * Serve one 1.0° OVERVIEW cell from R2, or null when it isn't baked (no
 * manifest, no object, any error).
 *
 * Unlike the detail level there is NO fail-open here: the caller returns 404
 * and the CLIENT falls back to the 0.1° path (src/services/overviewTiles.ts).
 * Overpass cannot serve a 1° bbox of bike infrastructure — a fail-open at this
 * layer would just be a 30 s timeout followed by an error.
 */
export async function getOverviewTileResponse(
  bucket: R2BucketLike,
  row: number,
  col: number,
  opts: GetEnrichedTileOptions = {},
): Promise<Response | null> {
  const now = opts.now ?? Date.now()
  try {
    const manifest = await getActiveManifest(bucket, now)
    if (!manifest) return null

    const obj = await bucket.get(overviewTileObjectKey(manifest.version, row, col))
    if (!obj) return null

    return new Response(obj.body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Cache': 'R2',
        'X-Tile-Source': 'overview',
        'X-Enriched-Version': manifest.version,
      },
    })
  } catch (err) {
    opts.onError?.(err)
    return null
  }
}
