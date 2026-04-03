import type { OsmWay } from '../utils/types'
import { BAD_SURFACES } from '../utils/classify'
import type { LatLngBounds } from 'leaflet'

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

// Tile size in degrees. At Berlin latitude (52°N):
//   0.1° lat ≈ 11.1 km, 0.1° lng ≈ 6.7 km → ~74 km² per tile
// A typical viewport (zoom 13–14) covers 2–4 tiles, so most pans reuse
// already-loaded tiles rather than refetching the whole viewport.
const TILE_DEGREES = 0.1

// In-memory cache keyed by tile coords + profile.
// Tiles are never evicted — memory stays small for typical usage.
const _tileCache = new Map<string, OsmWay[]>()

/** Canonical key for a tile. */
export function tileKey(row: number, col: number, profileKey: string): string {
  return `${row}:${col}:${profileKey}`
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
export function isTileCached(row: number, col: number, profileKey: string): boolean {
  return _tileCache.has(tileKey(row, col, profileKey))
}

/** Return cached tile data, or undefined if not cached. */
export function getCachedTile(row: number, col: number, profileKey: string): OsmWay[] | undefined {
  return _tileCache.get(tileKey(row, col, profileKey))
}

// Client-side fetch timeout (ms). Must exceed the server-side Overpass timeout so
// we get a proper HTTP error response rather than a silent network abort.
const FETCH_TIMEOUT_MS = 35_000

function buildQuery(bbox: { south: number; west: number; north: number; east: number }): string {
  const { south, west, north, east } = bbox
  const b = `${south},${west},${north},${east}`
  return `
[out:json][timeout:25];
(
  way["highway"="cycleway"](${b});
  way["bicycle_road"="yes"](${b});
  way["cycleway"="track"](${b});
  way["cycleway"="lane"](${b});
  way["cycleway"="opposite_track"](${b});
  way["cycleway"="opposite_lane"](${b});
  way["cycleway"="share_busway"](${b});
  way["highway"="living_street"](${b});
  way["highway"="residential"]["bicycle"!="no"](${b});
  way["highway"="path"]["bicycle"!="no"](${b});
  way["highway"="footway"]["bicycle"~"yes|designated"](${b});
  way["highway"="track"]["bicycle"!="no"](${b});
  way["cycleway:right"="track"](${b});
  way["cycleway:left"="track"](${b});
  way["cycleway:both"="track"](${b});
  way["cycleway:right"="lane"](${b});
  way["cycleway:left"="lane"](${b});
  way["cycleway:both"="lane"](${b});
);
out geom;
`
}

// BAD_SURFACES is imported from classify.ts — single source of truth.

/**
 * Map raw OSM tags to a PROFILE_LEGEND item name, or null if not representable.
 * Must stay in sync with classifyEdgeToItem() in classify.ts.
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

function classifyOsmTagsToItem(tags: Record<string, string>, profileKey: string): string | null {
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

async function fetchWithRetry(url: string, init: RequestInit, retries = 2): Promise<Response> {
  const attempt = 3 - retries  // 0-based attempt number for logging
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
    const isTimeout = err instanceof DOMException && err.name === 'TimeoutError'
    console.warn(`[Overpass] ${isTimeout ? 'Fetch timeout' : 'Network error'} on attempt ${attempt + 1}:`, err)
    if (retries > 0) {
      const delay = attempt === 0 ? 3000 : 6000
      await new Promise((r) => setTimeout(r, delay))
      return fetchWithRetry(url, init, retries - 1)
    }
    throw err
  }
}

function parseOverpassResponse(data: { elements: OverpassElement[] }, profileKey: string): OsmWay[] {
  return data.elements
    .filter((el): el is OverpassElement & { geometry: NonNullable<OverpassElement['geometry']> } =>
      el.type === 'way' && el.geometry != null,
    )
    .map((el) => ({
      itemName: classifyOsmTagsToItem(el.tags ?? {}, profileKey),
      coordinates: el.geometry.map((pt): [number, number] => [pt.lat, pt.lon]),
      osmId: el.id,
      tags: el.tags ?? {},
    }))
}

/**
 * Fetch bike infrastructure for a single tile, returning cached data immediately
 * if available. Retries up to 2 times on transient network/API errors.
 */
export async function fetchBikeInfraForTile(row: number, col: number, profileKey: string): Promise<OsmWay[]> {
  const key = tileKey(row, col, profileKey)
  if (_tileCache.has(key)) return _tileCache.get(key)!

  const bbox = {
    south: row * TILE_DEGREES,
    north: (row + 1) * TILE_DEGREES,
    west: col * TILE_DEGREES,
    east: (col + 1) * TILE_DEGREES,
  }

  console.debug(`[Overpass] Fetching tile ${row}:${col} (${bbox.south.toFixed(2)},${bbox.west.toFixed(2)} → ${bbox.north.toFixed(2)},${bbox.east.toFixed(2)})`)

  const query = buildQuery(bbox)
  let response: Response
  try {
    response = await fetchWithRetry(OVERPASS_URL, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
  } catch (err) {
    console.error(`[Overpass] Tile ${row}:${col} failed after all retries:`, err)
    throw err
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    console.error(`[Overpass] Tile ${row}:${col} HTTP ${response.status}:`, body.slice(0, 200))
    throw new Error(`Overpass HTTP ${response.status}`)
  }

  const data = await response.json() as { elements: OverpassElement[]; remark?: string }
  if (data.remark) {
    // Overpass sometimes returns 200 with partial results and a remark (e.g. query timeout)
    console.warn(`[Overpass] Tile ${row}:${col} remark:`, data.remark)
  }
  console.debug(`[Overpass] Tile ${row}:${col} → ${data.elements.length} elements`)
  const result = parseOverpassResponse(data, profileKey)
  _tileCache.set(key, result)
  return result
}

/**
 * @deprecated Use getVisibleTiles + fetchBikeInfraForTile instead.
 *
 * Legacy single-viewport fetch kept for reference. Tiles are more efficient
 * because they are cached individually across pans.
 */
export async function fetchBikeInfra(bounds: LatLngBounds, profileKey?: string): Promise<OsmWay[] | null> {
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
    tiles.map((t) => fetchBikeInfraForTile(t.row, t.col, profileKey ?? ''))
  )
  return results.flat()
}
