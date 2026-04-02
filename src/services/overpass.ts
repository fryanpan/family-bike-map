import type { SafetyClass, OsmWay } from '../utils/types'
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

function buildQuery(bbox: { south: number; west: number; north: number; east: number }): string {
  const { south, west, north, east } = bbox
  const b = `${south},${west},${north},${east}`
  return `
[out:json][timeout:15];
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
// See classify.ts for the canonical list and rationale.

/**
 * Map raw OSM tags to a safety class using the same classification model as classify.ts.
 *
 * Classification uses a 4-level system (great/good/ok/avoid) per profile:
 *
 * toddler:
 *   Good:  highway=cycleway/path/footway/track, bicycle_road=yes
 *   OK:    cycleway=track (separated), living_street
 *   Avoid: cycleway=lane, share_busway, residential, bad surface
 *
 * trailer:
 *   Good:  highway=cycleway/path/footway/track, bicycle_road=yes, share_busway
 *   OK:    cycleway=lane, living_street, residential
 *   Avoid: cycleway=track (too narrow for trailer), bad surface
 *
 * training:
 *   Good:  highway=cycleway/path/footway/track, bicycle_road=yes, cycleway=lane, share_busway
 *   OK:    living_street, residential
 *   Avoid: cycleway=track (too slow for training), bad surface
 *
 * Physical separation (bollards/buffer on a painted lane) is treated the same as
 * cycleway=track for classification — the separation tag upgrades the base lane
 * classification to the "separated track" tier.
 *
 * Valhalla↔OSM mapping: see classify.ts comment block for the full correlation.
 */
const SEPARATION_TAGS = new Set([
  'flex_post', 'separation_kerb', 'guard_rail',
])

function hasSeparation(tags: Record<string, string>): boolean {
  const keys = [
    'cycleway:separation',
    'cycleway:right:separation',
    'cycleway:left:separation',
    'cycleway:both:separation',
  ]
  for (const key of keys) {
    if (SEPARATION_TAGS.has(tags[key])) return true
  }
  // Buffer lane also counts as physical separation
  if (tags['cycleway:buffer']) return true
  return false
}

function classifyOsmTags(tags: Record<string, string>, profileKey?: string): SafetyClass {
  const surface = tags.surface ?? ''

  // Bad surfaces → avoid for all profiles
  if (BAD_SURFACES.has(surface)) return 'bad'

  const highway = tags.highway ?? ''
  const cycleway = tags.cycleway ?? ''
  const bicycleRoad = tags.bicycle_road === 'yes'
  return classifyOsmBase(highway, cycleway, bicycleRoad, tags, profileKey)
}

function classifyOsmBase(
  highway: string,
  cycleway: string,
  bicycleRoad: boolean,
  tags: Record<string, string>,
  profileKey?: string,
): SafetyClass {
  // Car-free dedicated cycleway or Fahrradstrasse — great for all
  if (highway === 'cycleway' || bicycleRoad) return 'great'

  // Car-free shared paths (park/canal paths, footway+bicycle=designated, tracks)
  // These are physically separated from car traffic.
  if (highway === 'path' || highway === 'footway' || highway === 'track') return 'great'

  // Physically separated tracks alongside road (cycleway=track, cycleway:*=track)
  // Toddler: ok (safe but slow/interrupted at crossings)
  // Trailer/training: avoid (too narrow for trailers, too slow for training)
  if (cycleway === 'track' || cycleway === 'opposite_track') {
    return profileKey === 'toddler' ? 'ok' : 'bad'
  }

  const cRight = tags['cycleway:right'] ?? ''
  const cLeft  = tags['cycleway:left']  ?? ''
  const cBoth  = tags['cycleway:both']  ?? ''
  if (cRight === 'track' || cLeft === 'track' || cBoth === 'track') {
    return profileKey === 'toddler' ? 'ok' : 'bad'
  }

  // Painted road bike lane (cycleway=lane, cycleway:*=lane)
  // Physical separation (bollards/buffer) treats it the same as a separated track.
  if (cycleway === 'lane' || cycleway === 'opposite_lane') {
    if (hasSeparation(tags)) return profileKey === 'toddler' ? 'ok' : 'bad'
    if (profileKey === 'toddler') return 'bad'
    if (profileKey === 'training') return 'good'
    return 'ok'  // trailer
  }

  if (cRight === 'lane' || cLeft === 'lane' || cBoth === 'lane') {
    if (hasSeparation(tags)) return profileKey === 'toddler' ? 'ok' : 'bad'
    if (profileKey === 'toddler') return 'bad'
    if (profileKey === 'training') return 'good'
    return 'ok'  // trailer
  }

  // Shared bus lane
  // Toddler: avoid (buses are hazardous with small children)
  // Trailer: ok (acceptable, buses give wide berth)
  // Training: good (wide, well-maintained)
  if (cycleway === 'share_busway') {
    if (profileKey === 'toddler') return 'bad'
    if (profileKey === 'training') return 'good'
    return 'ok'  // trailer
  }

  if (highway === 'living_street') return 'ok'

  // Residential roads
  // Toddler: avoid; trailer/training: ok
  if (highway === 'residential') {
    return profileKey === 'toddler' ? 'bad' : 'ok'
  }

  return 'ok'  // fallback for other queried ways (service roads, etc.)
}

interface OverpassElement {
  type: string
  id: number
  tags?: Record<string, string>
  geometry?: Array<{ lat: number; lon: number }>
}

async function fetchWithRetry(url: string, init: RequestInit, retries = 1): Promise<Response> {
  try {
    const resp = await fetch(url, init)
    if (!resp.ok && retries > 0) {
      await new Promise((r) => setTimeout(r, 1500))
      return fetchWithRetry(url, init, retries - 1)
    }
    return resp
  } catch (err) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 1500))
      return fetchWithRetry(url, init, retries - 1)
    }
    throw err
  }
}

function parseOverpassResponse(data: { elements: OverpassElement[] }, profileKey?: string): OsmWay[] {
  return data.elements
    .filter((el): el is OverpassElement & { geometry: NonNullable<OverpassElement['geometry']> } =>
      el.type === 'way' && el.geometry != null,
    )
    .map((el) => ({
      safetyClass: classifyOsmTags(el.tags ?? {}, profileKey),
      coordinates: el.geometry.map((pt): [number, number] => [pt.lat, pt.lon]),
      osmId: el.id,
      tags: el.tags ?? {},
    }))
}

/**
 * Fetch bike infrastructure for a single tile, returning cached data immediately
 * if available. Retries once on transient network/API errors.
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

  const query = buildQuery(bbox)
  const response = await fetchWithRetry(OVERPASS_URL, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })

  if (!response.ok) throw new Error('Overpass query failed')

  const data = await response.json() as { elements: OverpassElement[] }
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
