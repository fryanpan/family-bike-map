import { decode } from '../utils/polyline.js'
import { classifyEdge, buildSegments } from '../utils/classify.js'

// In production (surge.sh), route through the Cloudflare Worker.
// In dev, Vite proxy handles /api/* directly.
const API_BASE = import.meta.env.VITE_WORKER_URL ?? '/api'

/**
 * Rider profiles mapped to Valhalla bicycle costing options.
 *
 * Key Valhalla params:
 *   use_roads:          0=avoid roads, 1=prefer roads (over trails/paths)
 *   avoid_bad_surfaces: 0=tolerant of bad surfaces, 1=strongly avoid (cobblestones, etc.)
 *   use_hills:          0=avoid hills, 1=embrace hills
 *   use_living_streets: preference for living streets / woonerven
 *   bicycle_type:       Road | Hybrid | Cross | Mountain
 *   cycling_speed:      km/h
 */
export const DEFAULT_PROFILES = {
  toddler: {
    label: 'With Toddler',
    emoji: '👶',
    description:
      'Heavily prefers Fahrradstrasse and fully separated car-free paths. Avoids cobblestones and any road with moving cars.',
    costingOptions: {
      bicycle_type: 'Hybrid',
      cycling_speed: 12,
      use_roads: 0.0,
      avoid_bad_surfaces: 1.0,
      use_hills: 0.2,
      use_ferry: 0.0,
      use_living_streets: 1.0,
    },
    editable: true,
  },
  trailer: {
    label: 'Bike Trailer',
    emoji: '🚲',
    description:
      'Safe routes for a bike trailer. Mostly separated paths; roadside bike lanes OK in a pinch. Avoids bad surfaces.',
    costingOptions: {
      bicycle_type: 'Hybrid',
      cycling_speed: 11,
      use_roads: 0.15,
      avoid_bad_surfaces: 0.9,
      use_hills: 0.15,
      use_ferry: 0.0,
      use_living_streets: 0.9,
    },
    editable: true,
  },
  training: {
    label: 'Fast Training',
    emoji: '⚡',
    description:
      'Prioritises speed. Fahrradstrasse and recreational paths are great; bus lanes and 30 km/h roads acceptable.',
    costingOptions: {
      bicycle_type: 'Road',
      cycling_speed: 22,
      use_roads: 0.6,
      avoid_bad_surfaces: 0.4,
      use_hills: 0.8,
      use_ferry: 0.0,
    },
    editable: true,
  },
}

/**
 * Request a route from the Valhalla public instance.
 */
export async function getRoute(start, end, profile, waypoints = []) {
  const locations = [
    { lat: start.lat, lon: start.lng },
    ...waypoints.map((wp) => ({ lat: wp.lat, lon: wp.lng })),
    { lat: end.lat, lon: end.lng },
  ]

  const body = {
    locations,
    costing: 'bicycle',
    costing_options: { bicycle: profile.costingOptions },
    directions_options: { units: 'km', language: 'en-US' },
  }

  const response = await fetch(`${API_BASE}/valhalla/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error_message || err.error || `Routing failed (${response.status})`)
  }

  const data = await response.json()
  if (!data.trip) throw new Error('No route found between these points')

  const coordinates = data.trip.legs.flatMap((leg) => decode(leg.shape, 6))
  const maneuvers = data.trip.legs.flatMap((leg) => leg.maneuvers ?? [])

  return {
    coordinates,
    maneuvers,
    summary: {
      distance: data.trip.summary.length, // km
      duration: data.trip.summary.time,   // seconds
    },
  }
}

/**
 * Fetch per-edge attributes for a route from Valhalla trace_attributes.
 * Returns an array of segments with safetyClass and coordinates, or null on failure.
 */
export async function getRouteSegments(coordinates) {
  if (coordinates.length < 2) return null

  // Sample to ≤200 points to keep the API call fast
  const maxPoints = 200
  const stride = Math.max(1, Math.ceil(coordinates.length / maxPoints))
  const sampled = coordinates.filter((_, i) => i % stride === 0)
  // Always include the last point
  if (sampled[sampled.length - 1] !== coordinates[coordinates.length - 1]) {
    sampled.push(coordinates[coordinates.length - 1])
  }

  const body = {
    shape: sampled.map(([lat, lng]) => ({ lat, lon: lng })),
    costing: 'bicycle',
    shape_match: 'map_snap',
    filters: {
      attributes: [
        'edge.use',
        'edge.cycle_lane',
        'edge.surface',
        'edge.road_class',
        'edge.bicycle_network',
        'matched.edge_index',
        'matched.type',
      ],
      action: 'include',
    },
  }

  try {
    const response = await fetch(`${API_BASE}/valhalla/trace_attributes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) return null

    const data = await response.json()
    const { edges, matched_points } = data
    if (!edges || !matched_points) return null

    // Map each sampled coord to its safety class via matched_points → edges
    const classified = []
    for (let i = 0; i < matched_points.length; i++) {
      const mp = matched_points[i]
      const coord = sampled[i]
      if (!coord) continue
      const edgeIdx = mp.edge_index ?? 0
      const edge = edges[edgeIdx] ?? null
      classified.push({ safetyClass: classifyEdge(edge), coord })
    }

    return buildSegments(classified)
  } catch {
    return null
  }
}

export function formatDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`
  return `${km.toFixed(1)} km`
}

export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m} min`
}
