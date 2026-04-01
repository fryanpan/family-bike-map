import type { SafetyClass, OsmWay } from '../utils/types'
import { BAD_SURFACES } from '../utils/classify'
import type { LatLngBounds } from 'leaflet'

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

// Simple in-memory cache keyed by bbox + profile. Avoids redundant Overpass
// requests when the user pans back to an area or toggles the overlay off/on.
const _cache = new Map<string, OsmWay[]>()

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
  if (BAD_SURFACES.has(surface)) return 'avoid'

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
    return profileKey === 'toddler' ? 'ok' : 'avoid'
  }

  const cRight = tags['cycleway:right'] ?? ''
  const cLeft  = tags['cycleway:left']  ?? ''
  const cBoth  = tags['cycleway:both']  ?? ''
  if (cRight === 'track' || cLeft === 'track' || cBoth === 'track') {
    return profileKey === 'toddler' ? 'ok' : 'avoid'
  }

  // Painted road bike lane (cycleway=lane, cycleway:*=lane)
  // Physical separation (bollards/buffer) treats it the same as a separated track.
  if (cycleway === 'lane' || cycleway === 'opposite_lane') {
    if (hasSeparation(tags)) return profileKey === 'toddler' ? 'ok' : 'avoid'
    if (profileKey === 'toddler') return 'avoid'
    if (profileKey === 'training') return 'good'
    return 'ok'  // trailer
  }

  if (cRight === 'lane' || cLeft === 'lane' || cBoth === 'lane') {
    if (hasSeparation(tags)) return profileKey === 'toddler' ? 'ok' : 'avoid'
    if (profileKey === 'toddler') return 'avoid'
    if (profileKey === 'training') return 'good'
    return 'ok'  // trailer
  }

  // Shared bus lane
  // Toddler: avoid (buses are hazardous with small children)
  // Trailer: ok (acceptable, buses give wide berth)
  // Training: good (wide, well-maintained)
  if (cycleway === 'share_busway') {
    if (profileKey === 'toddler') return 'avoid'
    if (profileKey === 'training') return 'good'
    return 'ok'  // trailer
  }

  if (highway === 'living_street') return 'ok'

  // Residential roads
  // Toddler: avoid; trailer/training: ok
  if (highway === 'residential') {
    return profileKey === 'toddler' ? 'avoid' : 'ok'
  }

  return 'ok'  // fallback for other queried ways (service roads, etc.)
}

interface OverpassElement {
  type: string
  id: number
  tags?: Record<string, string>
  geometry?: Array<{ lat: number; lon: number }>
}

/**
 * Query bike infrastructure for the visible map bounds.
 * Returns null if the area is too large (zoom in more); throws on network error.
 * profileKey controls which safety classification rules are applied.
 */
export async function fetchBikeInfra(bounds: LatLngBounds, profileKey?: string): Promise<OsmWay[] | null> {
  const bbox = {
    south: bounds.getSouth(),
    west: bounds.getWest(),
    north: bounds.getNorth(),
    east: bounds.getEast(),
  }

  // Refuse to query if the area is too large (> ~15 km²) to avoid hammering Overpass
  const latSpan = bbox.north - bbox.south
  const lngSpan = bbox.east - bbox.west
  if (latSpan > 0.15 || lngSpan > 0.2) {
    return null // zoom in more
  }

  const cacheKey = [
    bbox.south.toFixed(4),
    bbox.north.toFixed(4),
    bbox.west.toFixed(4),
    bbox.east.toFixed(4),
    profileKey ?? '',
  ].join(':')
  if (_cache.has(cacheKey)) return _cache.get(cacheKey)!

  const query = buildQuery(bbox)
  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })

  if (!response.ok) throw new Error('Overpass query failed')

  const data = await response.json() as { elements: OverpassElement[] }

  const result = data.elements
    .filter((el): el is OverpassElement & { geometry: NonNullable<OverpassElement['geometry']> } =>
      el.type === 'way' && el.geometry != null,
    )
    .map((el) => ({
      safetyClass: classifyOsmTags(el.tags ?? {}, profileKey),
      coordinates: el.geometry.map((pt): [number, number] => [pt.lat, pt.lon]),
      osmId: el.id,
      tags: el.tags ?? {},
    }))

  _cache.set(cacheKey, result)
  return result
}
