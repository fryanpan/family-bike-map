import type { OsmWay } from '../utils/types'
import { BAD_SURFACES } from '../utils/classify'
import type { LatLngBounds } from 'leaflet'
import * as Sentry from '@sentry/react'

// Proxy through our own Cloudflare Worker (same-origin request) to avoid:
//   - Content blockers on iOS that block third-party domains
//   - Direct dependency on overpass-api.de being accessible from the user's network
const OVERPASS_URL = '/api/overpass'

// Tile size in degrees. At Berlin latitude (52°N):
//   0.1° lat ≈ 11.1 km, 0.1° lng ≈ 6.7 km → ~74 km² per tile
// A typical viewport (zoom 13–14) covers 2–4 tiles, so most pans reuse
// already-loaded tiles rather than refetching the whole viewport.
const TILE_DEGREES = 0.1

// In-memory cache keyed by tile coords only — profile-independent.
// The Overpass query is identical for all profiles; itemName is computed
// from raw tags at render time so mode switching is instant without re-fetching.
// Tiles are never evicted — memory stays small for typical usage.
const _tileCache = new Map<string, OsmWay[]>()

/** Canonical key for a tile (profile-independent). */
export function tileKey(row: number, col: number): string {
  return `${row}:${col}`
}

/** Tile row/col for a given latitude/longitude. */
export function latLngToTile(lat: number, lng: number): { row: number; col: number } {
  return {
    row: Math.floor(lat / TILE_DEGREES),
    col: Math.floor(lng / TILE_DEGREES),
  }
}

/** All tile row/col pairs that intersect the given bounds. */
export function getVisibleTiles(bounds: LatLngBounds): Array<{ row: number; col: number }> {
  const minRow = Math.floor(bounds.getSouth() / TILE_DEGREES)
  const maxRow = Math.floor(bounds.getNorth() / TILE_DEGREES)
  const minCol = Math.floor(bounds.getWest() / TILE_DEGREES)
  const maxCol = Math.floor(bounds.getEast() / TILE_DEGREES)
  const tiles: Array<{ row: number; col: number }> = []
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      tiles.push({ row: r, col: c })
    }
  }
  return tiles
}

/** True if the tile data for this key is already cached. */
export function isTileCached(row: number, col: number): boolean {
  return _tileCache.has(tileKey(row, col))
}

/** Return cached tile data, or undefined if not cached. */
export function getCachedTile(row: number, col: number): OsmWay[] | undefined {
  return _tileCache.get(tileKey(row, col))
}

// Client-side fetch timeout (ms). Must exceed the server-side Overpass timeout so
// we get a proper HTTP error response rather than a silent network abort.
const FETCH_TIMEOUT_MS = 35_000

// Maximum number of concurrent Overpass tile fetches.
// Overpass-api.de rate-limits by IP; sending 4+ parallel requests from a single
// viewport triggers HTTP 429 across all tiles simultaneously. Capping at 2 prevents
// the 429 storm while still allowing two tiles to load in parallel.
const MAX_CONCURRENT_FETCHES = 2

export class Semaphore {
  private _available: number
  private _queue: Array<() => void> = []

  constructor(count: number) {
    this._available = count
  }

  async acquire(): Promise<void> {
    if (this._available > 0) {
      this._available--
      return
    }
    return new Promise((resolve) => this._queue.push(resolve))
  }

  release(): void {
    const next = this._queue.shift()
    if (next) {
      next()
    } else {
      this._available++
    }
  }
}

const _fetchSemaphore = new Semaphore(MAX_CONCURRENT_FETCHES)

export function buildQuery(bbox: { south: number; west: number; north: number; east: number }): string {
  const { south, west, north, east } = bbox
  const b = `${south},${west},${north},${east}`
  // 6 sub-queries instead of 18 — semantically equivalent but much less load on Overpass:
  //   - Combine residential/path/track (all need bicycle!=no) into one regex highway filter.
  //   - Combine all cycleway/cycleway:right/cycleway:left/cycleway:both value variants into
  //     one regex key+value filter. The key regex ^cycleway(:right|:left|:both)?$ matches
  //     the plain "cycleway" key and all three directional variants.
  return `
[out:json][timeout:25];
(
  way["highway"="cycleway"](${b});
  way["bicycle_road"="yes"](${b});
  way["highway"="living_street"](${b});
  way["highway"~"^(residential|path|track)$"]["bicycle"!="no"](${b});
  way["highway"="footway"]["bicycle"~"^(yes|designated)$"](${b});
  way[~"^cycleway(:right|:left|:both)?$"~"^(track|lane|opposite_track|opposite_lane|share_busway)$"](${b});
);
out geom;
`
}

// BAD_SURFACES is imported from classify.ts — single source of truth.

/**
 * Map raw OSM tags to a PROFILE_LEGEND item name, or null if not representable.
 * Must stay in sync with classifyEdgeToItem() in classify.ts.
 *
 * Exported so BikeMapOverlay can call this at render time with the current
 * profileKey — that way the cache is profile-independent and mode switching
 * is instant (no re-fetch needed).
 *
 * Valhalla↔OSM mapping: see classify.ts comment block for the full correlation.
 *
 * Physical separation (bollards/buffer on a painted lane) upgrades the classification
 * to the separated-track tier for toddler — only detectable via raw OSM tags,
 * not via Valhalla edge attributes (known Valhalla limitation).
 */
const SEPARATION_TAGS = new Set([
  'flex_post', 'separation_kerb', 'guard_rail',
])

function hasSeparation(tags: Record<string, string>): boolean {
  const keys = [
    'cycleway:separation', 'cycleway:right:separation',
    'cycleway:left:separation', 'cycleway:both:separation',
  ]
  for (const key of keys) {
    if (SEPARATION_TAGS.has(tags[key])) return true
  }
  if (tags['cycleway:buffer']) return true
  return false
}

export function classifyOsmTagsToItem(tags: Record<string, string>, profileKey: string): string | null {
  if (BAD_SURFACES.has(tags.surface ?? '')) return null

  const highway     = tags.highway ?? ''
  const cycleway    = tags.cycleway ?? ''
  const bicycleRoad = tags.bicycle_road === 'yes'

  if (bicycleRoad) return 'Fahrradstrasse'
  if (highway === 'cycleway' || highway === 'path' || highway === 'track') return 'Car-free path / Radweg'
  if (highway === 'footway') return 'Shared footway (park path)'

  // Physically separated track (cycleway=track or physical separation on a lane)
  const cRight = tags['cycleway:right'] ?? ''
  const cLeft  = tags['cycleway:left']  ?? ''
  const cBoth  = tags['cycleway:both']  ?? ''

  const isSeparatedTrack =
    cycleway === 'track' || cycleway === 'opposite_track' ||
    cRight === 'track' || cLeft === 'track' || cBoth === 'track'

  const isPhysicallySeparatedLane =
    (cycleway === 'lane' || cycleway === 'opposite_lane' ||
     cRight === 'lane' || cLeft === 'lane' || cBoth === 'lane') && hasSeparation(tags)

  if (isSeparatedTrack || isPhysicallySeparatedLane) {
    if (profileKey === 'toddler') return 'Separated bike track'
    if (profileKey === 'trailer') return 'Separated bike track (narrow)'
    if (profileKey === 'training') return 'Separated bike track (slow)'
    return null
  }

  if (cycleway === 'lane' || cycleway === 'opposite_lane' ||
      cRight === 'lane' || cLeft === 'lane' || cBoth === 'lane') {
    return 'Painted bike lane'
  }

  if (cycleway === 'share_busway') return 'Shared bus lane'
  if (highway === 'living_street') return 'Living street'
  if (highway === 'residential')   return 'Residential road'

  return null
}

interface OverpassElement {
  type: string
  id: number
  tags?: Record<string, string>
  geometry?: Array<{ lat: number; lon: number }>
}

const MAX_RETRIES = 2

async function fetchWithRetry(url: string, init: RequestInit, retries = MAX_RETRIES): Promise<Response> {
  const attempt = MAX_RETRIES - retries  // 0-based: 0 on first call, 1 on first retry, 2 on last retry
  try {
    const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!resp.ok) {
      console.warn(`[Overpass] HTTP ${resp.status} on attempt ${attempt + 1}`, url)
      if (retries > 0) {
        const delay = attempt === 0 ? 3000 : 6000  // 3s, then 6s
        await new Promise((r) => setTimeout(r, delay))
        return fetchWithRetry(url, init, retries - 1)
      }
    }
    return resp
  } catch (err) {
    // iOS Safari throws AbortError (not TimeoutError) when AbortSignal.timeout() fires.
    // Both names indicate our client-side timeout was reached.
    const isTimeout =
      err instanceof DOMException && (err.name === 'TimeoutError' || err.name === 'AbortError')
    console.warn(`[Overpass] ${isTimeout ? 'Fetch timeout' : 'Network error'} on attempt ${attempt + 1}:`, err)
    if (retries > 0) {
      const delay = attempt === 0 ? 3000 : 6000
      await new Promise((r) => setTimeout(r, delay))
      return fetchWithRetry(url, init, retries - 1)
    }
    throw err
  }
}

// Stored OsmWay objects have itemName: null — classification is deferred to render
// time via classifyOsmTagsToItem() so the cache is profile-independent.
function parseOverpassResponse(data: { elements: OverpassElement[] }): OsmWay[] {
  return data.elements
    .filter((el): el is OverpassElement & { geometry: NonNullable<OverpassElement['geometry']> } =>
      el.type === 'way' && el.geometry != null,
    )
    .map((el) => ({
      itemName: null,
      coordinates: el.geometry.map((pt): [number, number] => [pt.lat, pt.lon]),
      osmId: el.id,
      tags: el.tags ?? {},
    }))
}

/**
 * Fetch bike infrastructure for a single tile, returning cached data immediately
 * if available. Retries up to 2 times on transient network/API errors.
 *
 * The returned OsmWay objects have itemName: null — call classifyOsmTagsToItem()
 * with the current profileKey at render time to get the profile-specific name.
 * This keeps the cache profile-independent so mode switching is instant.
 */
export async function fetchBikeInfraForTile(row: number, col: number): Promise<OsmWay[]> {
  const key = tileKey(row, col)
  if (_tileCache.has(key)) return _tileCache.get(key)!

  const bbox = {
    south: row * TILE_DEGREES,
    north: (row + 1) * TILE_DEGREES,
    west: col * TILE_DEGREES,
    east: (col + 1) * TILE_DEGREES,
  }

  console.debug(`[Overpass] Fetching tile ${row}:${col} (${bbox.south.toFixed(2)},${bbox.west.toFixed(2)} → ${bbox.north.toFixed(2)},${bbox.east.toFixed(2)})`)

  const query = buildQuery(bbox)
  const tileCtx = { tile: `${row}:${col}`, bbox: `${bbox.south.toFixed(3)},${bbox.west.toFixed(3)}→${bbox.north.toFixed(3)},${bbox.east.toFixed(3)}` }

  // Include tile coords as query params so the Worker builds a deterministic
  // cache key without parsing the Overpass query body.
  const fetchUrl = `${OVERPASS_URL}?row=${row}&col=${col}`

  let response: Response
  await _fetchSemaphore.acquire()
  try {
    response = await fetchWithRetry(fetchUrl, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
  } catch (err) {
    console.error(`[Overpass] Tile ${row}:${col} failed after all retries:`, err)
    Sentry.captureException(err, { extra: { ...tileCtx, stage: 'fetch' } })
    throw err
  } finally {
    _fetchSemaphore.release()
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.error(`[Overpass] Tile ${row}:${col} HTTP ${response.status}:`, body.slice(0, 200))
    const err = new Error(`Overpass HTTP ${response.status}`)
    Sentry.captureException(err, { extra: { ...tileCtx, status: response.status, body: body.slice(0, 500) } })
    throw err
  }

  const data = await response.json() as { elements: OverpassElement[]; remark?: string }
  if (data.remark) {
    // Overpass sometimes returns 200 with partial results and a remark (e.g. query timeout)
    console.warn(`[Overpass] Tile ${row}:${col} remark:`, data.remark)
    Sentry.captureMessage(`Overpass remark: ${data.remark}`, { level: 'warning', extra: tileCtx })
  }
  const cacheStatus = response.headers.get('X-Cache') ?? 'N/A'
  console.debug(`[Overpass] Tile ${row}:${col} → ${data.elements.length} elements (server cache: ${cacheStatus})`)
  const result = parseOverpassResponse(data)
  _tileCache.set(key, result)
  return result
}

/**
 * @deprecated Use getVisibleTiles + fetchBikeInfraForTile instead.
 *
 * Legacy single-viewport fetch kept for reference. Tiles are more efficient
 * because they are cached individually across pans.
 */
export async function fetchBikeInfra(bounds: LatLngBounds): Promise<OsmWay[] | null> {
  const bbox = {
    south: bounds.getSouth(),
    west: bounds.getWest(),
    north: bounds.getNorth(),
    east: bounds.getEast(),
  }

  const latSpan = bbox.north - bbox.south
  const lngSpan = bbox.east - bbox.west
  if (latSpan > 0.15 || lngSpan > 0.2) return null

  const tiles = getVisibleTiles(bounds)
  const results = await Promise.all(
    tiles.map((t) => fetchBikeInfraForTile(t.row, t.col))
  )
  return results.flat()
}
