/**
 * Fetch cycling infrastructure from OpenStreetMap via Overpass API
 * for a given map bounding box, classified into our safety categories.
 */
import { classifyEdge } from '../utils/classify.js'

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter'

/**
 * Build an Overpass QL query for bike infrastructure in a bounding box.
 * bbox = { south, west, north, east }
 */
function buildQuery(bbox) {
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
);
out geom;
`
}

/**
 * Map OSM tags to a safety class (mirrors classify.js logic but for raw OSM tags).
 */
function classifyOsmTags(tags) {
  const highway = tags.highway ?? ''
  const cycleway = tags.cycleway ?? ''
  const bicycleRoad = tags.bicycle_road === 'yes'
  const surface = tags.surface ?? ''

  const BAD_SURFACES = new Set([
    'cobblestone', 'paving_stones', 'sett', 'unhewn_cobblestone',
    'cobblestone:flattened',
  ])
  const badSurface = BAD_SURFACES.has(surface)

  if (highway === 'cycleway' || bicycleRoad) return badSurface ? 'ok' : 'great'
  if (cycleway === 'track') return badSurface ? 'ok' : 'good'
  if (cycleway === 'opposite_track') return 'good'
  if (cycleway === 'lane' || cycleway === 'opposite_lane') return badSurface ? 'acceptable' : 'ok'
  if (cycleway === 'share_busway') return 'acceptable'
  if (highway === 'living_street') return 'acceptable'
  if (highway === 'residential') return badSurface ? 'caution' : 'acceptable'

  return 'acceptable'
}

/**
 * Query bike infrastructure for the visible map bounds.
 * Returns array of { safetyClass, coordinates: [[lat,lng],...] }
 */
export async function fetchBikeInfra(bounds) {
  const bbox = {
    south: bounds.getSouth(),
    west: bounds.getWest(),
    north: bounds.getNorth(),
    east: bounds.getEast(),
  }

  // Refuse to query if the area is too large (> ~15km²) to avoid hammering Overpass
  const latSpan = bbox.north - bbox.south
  const lngSpan = bbox.east - bbox.west
  if (latSpan > 0.15 || lngSpan > 0.2) {
    return null // zoom in more
  }

  const query = buildQuery(bbox)
  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: `data=${encodeURIComponent(query)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })

  if (!response.ok) throw new Error('Overpass query failed')

  const data = await response.json()

  return data.elements
    .filter((el) => el.type === 'way' && el.geometry)
    .map((el) => ({
      safetyClass: classifyOsmTags(el.tags ?? {}),
      coordinates: el.geometry.map((pt) => [pt.lat, pt.lon]),
      osmId: el.id,
      tags: el.tags ?? {},
    }))
}
