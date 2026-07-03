#!/usr/bin/env bun
/**
 * Route server — the SAME routing code the browser runs (clientRoute from
 * src/services/clientRouter.ts) exposed as a bun HTTP service over a
 * directory of pre-fetched/enriched tile JSONs.
 *
 * ONE implementation rule: this file contains NO routing, classification,
 * or costing logic of its own. It loads tile JSONs into the overpass.ts
 * in-memory tile cache via the existing `injectCachedTile` seam (the same
 * seam the browser's IndexedDB warm-load uses), then calls `clientRoute`
 * exactly like App.tsx does. `getCachedTile` hits for every corridor tile,
 * so the network-fetch path inside clientRoute is never taken.
 *
 * Contract:
 *   POST /route  {start:{lat,lng}, end:{lat,lng}, travelMode,
 *                 preferredItemNames?: string[], avoidedWayIds?: number[]}
 *     → 200 with the exact `clientRoute` result (Route JSON, or `null`
 *       when no path exists — same semantics as the in-browser call)
 *     → 400 malformed body / unknown travelMode
 *     → 422 start or end outside the loaded tile region
 *     → 500 {error} on unexpected failure (no stack traces leaked)
 *   GET /health  → {ok, region, tilesLoaded, builtFromSeq}
 *
 * Tile files: `<row>_<col>.json` (0.1° tile indices, negatives allowed —
 * e.g. `377_-1225.json` for SF), each either a bare OsmWay[] or the
 * enriched-tile shape `{meta: {builtFromSeq, row?, col?, …}, ways: […]}`
 * from docs/product/plans/enriched-tiles-plan.md. `meta.row`/`meta.col`
 * override the filename when present.
 *
 * Run: bun server/route-server.ts --tiles <dir> [--port 8787]
 *        [--region <label>] [--no-elevation]
 */

import { basename, join } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import { clientRoute } from '../src/services/clientRouter'
import { injectCachedTile, latLngToTile, tileKey } from '../src/services/overpass'
import { getDefaultPreferredItems } from '../src/utils/classify'
import { MODE_RULES } from '../src/data/modes'
import { setElevationDecoder, setElevationReferer } from '../src/services/elevation'
import type { OsmWay } from '../src/utils/types'

// ── Tile loading ───────────────────────────────────────────────────────────

interface TileMeta {
  builtFromSeq?: number
  row?: number
  col?: number
  [key: string]: unknown
}

interface EnrichedTileFile {
  meta?: TileMeta
  ways?: unknown[]
}

export interface LoadedTiles {
  /** Keys (`row:col`) of tiles that came from actual files — the served region. */
  loadedKeys: Set<string>
  tilesLoaded: number
  /** Max meta.builtFromSeq across loaded tiles; null when no tile carried one. */
  builtFromSeq: number | null
}

const TILE_FILE_RE = /^(-?\d+)_(-?\d+)\.json$/

function tileRowCol(file: string, meta: TileMeta | undefined): { row: number; col: number } | null {
  if (typeof meta?.row === 'number' && typeof meta?.col === 'number') {
    return { row: meta.row, col: meta.col }
  }
  const m = TILE_FILE_RE.exec(basename(file))
  if (m) return { row: Number(m[1]), col: Number(m[2]) }
  return null
}

function isWayLike(w: unknown): w is OsmWay {
  if (w == null || typeof w !== 'object') return false
  const way = w as Partial<OsmWay>
  return (
    typeof way.osmId === 'number' &&
    Array.isArray(way.coordinates) &&
    way.coordinates.every(
      (c) => Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number',
    )
  )
}

// Keep enriched extra fields (gradientPct, accessGradientPct, …) — the
// router ignores them, but they cost nothing in memory and future
// consumers of the same cache may read them.
function normalizeWay(w: OsmWay): OsmWay {
  return { ...w, itemName: w.itemName ?? null, tags: w.tags ?? {} }
}

// Padding-ring guard: the corridor a route request touches extends at most
// one tile beyond the region's bounding rectangle (clientRoute buffers the
// start/end bbox by 0.05°, half a tile). Anything past this cell count is a
// misconfigured tiles dir, not a real region.
const MAX_PAD_CELLS = 1_000_000

/**
 * Load every tile JSON in `tilesDir` into the overpass.ts in-memory tile
 * cache (the same cache `clientRoute` reads). Also injects EMPTY tiles for
 * every uncovered cell in the region's bounding rectangle plus a one-tile
 * ring: `clientRoute` fetches any corridor tile missing from the cache, and
 * in bun that fetch (relative `/api/overpass` URL) fails only after the full
 * retry ladder (~9 s per tile). Empty injected tiles make cache lookups hit
 * instantly, exactly as an empty-Overpass-response tile would in the browser.
 */
export function loadTilesIntoCache(tilesDir: string): LoadedTiles {
  const files = readdirSync(tilesDir).filter((f) => f.endsWith('.json')).sort()
  const loadedKeys = new Set<string>()
  let builtFromSeq: number | null = null
  let minRow = Infinity
  let maxRow = -Infinity
  let minCol = Infinity
  let maxCol = -Infinity

  for (const file of files) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(join(tilesDir, file), 'utf8'))
    } catch {
      console.warn(`[route-server] ${file}: invalid JSON — skipping`)
      continue
    }
    let meta: TileMeta | undefined
    let rawWays: unknown[]
    if (Array.isArray(parsed)) {
      rawWays = parsed
    } else if (
      parsed != null && typeof parsed === 'object' &&
      Array.isArray((parsed as EnrichedTileFile).ways)
    ) {
      meta = (parsed as EnrichedTileFile).meta
      rawWays = (parsed as EnrichedTileFile).ways!
    } else {
      console.warn(`[route-server] ${file}: not an OsmWay[] or {meta, ways} tile — skipping`)
      continue
    }
    const rc = tileRowCol(file, meta)
    if (!rc) {
      console.warn(
        `[route-server] ${file}: cannot determine tile row/col ` +
        '(expected <row>_<col>.json filename or meta.row/meta.col) — skipping',
      )
      continue
    }
    const ways = rawWays.filter(isWayLike).map(normalizeWay)
    if (ways.length !== rawWays.length) {
      console.warn(`[route-server] ${file}: dropped ${rawWays.length - ways.length} malformed way entries`)
    }
    injectCachedTile(rc.row, rc.col, ways)
    loadedKeys.add(tileKey(rc.row, rc.col))
    minRow = Math.min(minRow, rc.row)
    maxRow = Math.max(maxRow, rc.row)
    minCol = Math.min(minCol, rc.col)
    maxCol = Math.max(maxCol, rc.col)
    if (typeof meta?.builtFromSeq === 'number') {
      builtFromSeq = builtFromSeq == null ? meta.builtFromSeq : Math.max(builtFromSeq, meta.builtFromSeq)
    }
  }

  if (loadedKeys.size === 0) {
    throw new Error(`no usable tile JSONs found in ${tilesDir}`)
  }

  const padCells = (maxRow - minRow + 3) * (maxCol - minCol + 3)
  if (padCells <= MAX_PAD_CELLS) {
    for (let r = minRow - 1; r <= maxRow + 1; r++) {
      for (let c = minCol - 1; c <= maxCol + 1; c++) {
        const key = tileKey(r, c)
        if (!loadedKeys.has(key)) injectCachedTile(r, c, [])
      }
    }
  } else {
    console.warn(
      `[route-server] tile bounding rect spans ${padCells} cells (> ${MAX_PAD_CELLS}) — ` +
      'skipping empty-tile padding; requests near coverage gaps will be slow',
    )
  }

  return { loadedKeys, tilesLoaded: loadedKeys.size, builtFromSeq }
}

// ── Elevation (bun decoder) ────────────────────────────────────────────────

/**
 * Register the bun-friendly PNG decoder + Referer so the production
 * elevation module (src/services/elevation.ts) can fetch and decode
 * terrain-RGB tiles outside a browser — same pattern as
 * scripts/diag-moat-filter.ts and the routing benchmark. Fails soft: with
 * no VITE_MAPBOX_TOKEN in the environment the elevation module returns
 * null everywhere and routing degrades to "no ascent cost", identical to
 * the browser's behavior without terrain data.
 */
export async function enableBunElevation(): Promise<void> {
  const { PNG } = await import('pngjs')
  setElevationDecoder((bytes) => new Promise((resolve) => {
    new PNG().parse(Buffer.from(bytes), (err, data) => {
      if (err || !data) { resolve(null); return }
      resolve(new Uint8ClampedArray(data.data.buffer, data.data.byteOffset, data.data.byteLength))
    })
  }))
  // The Mapbox token is URL-restricted to the prod origin; bun sends no
  // Referer by default, so set one matching the allowed origin.
  setElevationReferer('https://bike-map.fryanpan.com/')
}

// ── HTTP server ────────────────────────────────────────────────────────────

export interface RouteServerOptions {
  tilesDir: string
  /** Default 8787. Pass 0 for an ephemeral port (tests). */
  port?: number
  /** Label reported by /health. Defaults to the tiles dir basename. */
  region?: string
}

export interface RouteServerHandle {
  server: ReturnType<typeof Bun.serve>
  port: number
  tiles: LoadedTiles
}

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function isLatLngLike(p: unknown): p is { lat: number; lng: number } {
  if (p == null || typeof p !== 'object') return false
  const { lat, lng } = p as { lat?: unknown; lng?: unknown }
  return (
    typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180
  )
}

async function handleRouteRequest(req: Request, tiles: LoadedTiles): Promise<Response> {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ error: 'request body must be valid JSON' }, 400)
  }
  if (body == null || typeof body !== 'object') {
    return json({ error: 'request body must be a JSON object' }, 400)
  }
  const { start, end, travelMode, preferredItemNames, avoidedWayIds } = body as {
    start?: unknown
    end?: unknown
    travelMode?: unknown
    preferredItemNames?: unknown
    avoidedWayIds?: unknown
  }
  if (!isLatLngLike(start)) return json({ error: 'start must be {lat, lng} with finite coordinates' }, 400)
  if (!isLatLngLike(end)) return json({ error: 'end must be {lat, lng} with finite coordinates' }, 400)
  if (typeof travelMode !== 'string' || !(travelMode in MODE_RULES)) {
    return json({ error: `unknown travelMode; expected one of: ${Object.keys(MODE_RULES).join(', ')}` }, 400)
  }
  if (
    preferredItemNames !== undefined &&
    (!Array.isArray(preferredItemNames) || preferredItemNames.some((n) => typeof n !== 'string'))
  ) {
    return json({ error: 'preferredItemNames must be an array of strings when present' }, 400)
  }
  if (
    avoidedWayIds !== undefined &&
    (!Array.isArray(avoidedWayIds) ||
      avoidedWayIds.some((id) => typeof id !== 'number' || !Number.isFinite(id)))
  ) {
    return json({ error: 'avoidedWayIds must be an array of numbers when present' }, 400)
  }

  // Region check against tiles that came from actual files (padding tiles
  // don't count — they exist only to keep corridor lookups off the network
  // path). A point in an unloaded tile can't be routed meaningfully.
  const startTile = latLngToTile(start.lat, start.lng)
  if (!tiles.loadedKeys.has(tileKey(startTile.row, startTile.col))) {
    return json({ error: 'start is outside the loaded tile region' }, 422)
  }
  const endTile = latLngToTile(end.lat, end.lng)
  if (!tiles.loadedKeys.has(tileKey(endTile.row, endTile.col))) {
    return json({ error: 'end is outside the loaded tile region' }, 422)
  }

  // Mode/preferences stay client-side concepts sent per request; when the
  // client sends none, use the same per-mode defaults the browser uses.
  const preferred = preferredItemNames !== undefined
    ? new Set(preferredItemNames as string[])
    : getDefaultPreferredItems(travelMode)

  // "Reroute around this" avoid list — same per-request concept as mode/
  // preferences; must reach clientRoute exactly as the browser passes it or
  // the server backend silently ignores the user's reroute taps.
  const avoided = avoidedWayIds !== undefined && (avoidedWayIds as number[]).length > 0
    ? new Set(avoidedWayIds as number[])
    : null

  // THE production router — identical code path to the browser. Returns
  // null when no path exists; we pass that through as JSON `null` so the
  // response is byte-for-byte the clientRoute result. regionRules /
  // regionProfile are undefined on both backends (App.tsx passes [] / null).
  const route = await clientRoute(
    start.lat, start.lng, end.lat, end.lng, travelMode, preferred,
    undefined, undefined, avoided,
  )
  return json(route ?? null, 200)
}

export function startRouteServer(opts: RouteServerOptions): RouteServerHandle {
  const tiles = loadTilesIntoCache(opts.tilesDir)
  const region = opts.region ?? basename(opts.tilesDir)

  const server = Bun.serve({
    port: opts.port ?? 8787,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url)
      try {
        if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: JSON_HEADERS })
        if (req.method === 'GET' && url.pathname === '/health') {
          return json({
            ok: true,
            region,
            tilesLoaded: tiles.tilesLoaded,
            builtFromSeq: tiles.builtFromSeq,
          })
        }
        if (req.method === 'POST' && url.pathname === '/route') {
          return await handleRouteRequest(req, tiles)
        }
        return json({ error: 'not found' }, 404)
      } catch (err) {
        // Log server-side; never leak stack traces or error internals.
        console.error(`[route-server] ${req.method} ${url.pathname} failed:`, err)
        return json({ error: 'internal server error' }, 500)
      }
    },
  })

  return { server, port: server.port ?? 0, tiles }
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { tilesDir?: string; port: number; region?: string; elevation: boolean } {
  const out: { tilesDir?: string; port: number; region?: string; elevation: boolean } = {
    port: 8787,
    elevation: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--tiles') out.tilesDir = argv[++i]
    else if (arg === '--port') out.port = Number(argv[++i])
    else if (arg === '--region') out.region = argv[++i]
    else if (arg === '--no-elevation') out.elevation = false
    else {
      console.error(`unknown argument: ${arg}`)
      process.exit(1)
    }
  }
  return out
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.tilesDir || !Number.isFinite(args.port)) {
    console.error('usage: bun server/route-server.ts --tiles <dir> [--port 8787] [--region <label>] [--no-elevation]')
    process.exit(1)
  }
  if (args.elevation) await enableBunElevation()
  const { port, tiles } = startRouteServer({ tilesDir: args.tilesDir, port: args.port, region: args.region })
  console.log(
    `[route-server] listening on :${port} — ${tiles.tilesLoaded} tiles loaded` +
    `${tiles.builtFromSeq != null ? `, builtFromSeq ${tiles.builtFromSeq}` : ''}` +
    `${args.elevation ? '' : ' (elevation disabled)'}`,
  )
}
