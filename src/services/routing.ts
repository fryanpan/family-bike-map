import { decode } from '../utils/polyline'
import { classifyEdge, buildSegments } from '../utils/classify'
import type {
  Place,
  LatLng,
  RiderProfile,
  ProfileMap,
  Route,
  RouteSegment,
  ValhallaEdge,
} from '../utils/types'

// All API calls use relative paths — same origin in production (Cloudflare Worker
// serves both assets and API), and proxied via wrangler dev locally.
const API_BASE = '/api'

/**
 * Rider profiles mapped to Valhalla bicycle costing options.
 *
 * Our custom safety model (from original product spec) maps to Valhalla params:
 *
 *  use_roads:          0 = strongly prefer bike infrastructure over any road
 *                      → For toddler/trailer: keep at 0 so Valhalla avoids roads even
 *                        if they have painted bike lanes (lane=cycleway still a road)
 *
 *  avoid_bad_surfaces: 0 = tolerant, 1 = avoid cobblestones/gravel
 *                      → ALL profiles avoid cobblestones per spec
 *
 *  use_hills:          0 = flat routes only; 1 = embrace hills
 *
 *  use_living_streets: Valhalla gives Fahrradstrasse (bicycle_road=yes) a large bonus
 *                      similar to living streets — setting high ensures they're preferred
 *
 * Safety priority per profile (from product spec):
 *
 *  toddler:
 *    GREAT: Fahrradstrasse, fully separate recreational trails
 *    GOOD:  Separated bike paths elevated on sidewalk
 *    GOOD:  Quiet side streets
 *    BAD:   Bike paths on the road (cycleway=lane) — "no better than road without one"
 *    AVOID: Cobblestones
 *
 *  trailer (similar to toddler, more lenient):
 *    GREAT: Fahrradstrasse, separate recreational trails
 *    GOOD:  Separated elevated paths
 *    OK:    Roadside (non-elevated) bike lanes, bus lane with bike
 *    AVOID: Cobblestones
 *
 *  training:
 *    GREAT: Fahrradstrasse, recreational paths
 *    GOOD:  Bus lane bike routes
 *    OK:    Multi-lane roads ≤30 km/h
 *    AVOID: Cobblestones
 */
export const DEFAULT_PROFILES: ProfileMap = {
  toddler: {
    label: 'With Toddler',
    emoji: '👶',
    description:
      'Toddler on their own bike/scooter (~10 km/h) — not yet comfortable biking beside cars or following traffic rules. Only Fahrradstrasse, car-free trails and elevated separated paths. Busy roads and painted road bike lanes avoided.',
    costingOptions: {
      bicycle_type: 'Hybrid',
      cycling_speed: 10,
      use_roads: 0.0,          // avoid roads entirely — paths and Fahrradstrasse only
      avoid_bad_surfaces: 0.5, // avoids cobblestones (surface quality ~0.3) but allows
                               // compacted/dirt park paths (quality ~0.7–0.9) like Engeldam.
                               // 1.0 was too aggressive — penalised all non-smooth surfaces
                               // including perfectly rideable park trails.
      use_hills: 0.1,          // nearly flat
      use_ferry: 0.0,
      use_living_streets: 1.0, // strongly prefers living streets / Fahrradstrasse-adjacent ways
    },
    editable: true,
  },
  trailer: {
    label: 'Bike Trailer',
    emoji: '🚲',
    description:
      'Riding 15–25 km/h with a child trailer. Prefers wide, smooth paths that are easy to navigate with a trailer. Narrow separated tracks and cobblestones avoided.',
    costingOptions: {
      bicycle_type: 'Hybrid',
      cycling_speed: 11,
      use_roads: 0.15,         // roadside bike lanes occasionally acceptable
      avoid_bad_surfaces: 0.5, // same as toddler: avoids cobblestones, allows park paths.
                               // 0.9 was blocking compacted/dirt trails that are safe for trailers.
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
      '~30 km/h rides focused on sustaining speed. Fast enough to ride with traffic on 30 km/h roads. Fahrradstrasse and recreational paths preferred; bus lanes and painted lanes good; slow/interrupted separated tracks avoided.',
    costingOptions: {
      bicycle_type: 'Road',
      cycling_speed: 22,
      use_roads: 0.6,          // some roads fine
      avoid_bad_surfaces: 0.4, // tolerates rougher surfaces
      use_hills: 0.9,
      use_ferry: 0.0,
      use_living_streets: 0.5,
    },
    editable: true,
  },
}

interface ValhallaManeuverRaw {
  type: number
  instruction: string
  length: number
  time: number
}

/**
 * Request a route from the Valhalla public instance.
 */
export async function getRoute(
  start: Place,
  end: Place,
  profile: RiderProfile,
  waypoints: LatLng[] = [],
): Promise<Route> {
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
    const err = await response.json().catch(() => ({})) as { error_message?: string; error?: string }
    throw new Error(err.error_message ?? err.error ?? `Routing failed (${response.status})`)
  }

  const data = await response.json() as {
    trip?: {
      legs: Array<{ shape: string; maneuvers?: ValhallaManeuverRaw[] }>
      summary: { length: number; time: number }
    }
  }
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
 * Returns profile-aware colored segments, or null on failure.
 *
 * profileKey is passed to classifyEdge() so segment colors reflect what THIS profile
 * considers safe — e.g. painted road lanes show as 'avoid' for the toddler profile
 * but 'ok' for the training profile.
 *
 * Key fix: requests edge.bicycle_road to correctly identify Fahrradstrasse
 * (bicycle_road=yes). The old code used edge.bicycle_network which tracks cycling
 * route memberships (NCN/RCN/LCN) — most Berlin Fahrradstrassen are not in a named
 * network so they were misclassified as 'acceptable'.
 */
export async function getRouteSegments(
  coordinates: [number, number][],
  profileKey?: string,
): Promise<RouteSegment[] | null> {
  if (coordinates.length < 2) return null

  // Sample to ≤200 points to keep the API call fast
  const maxPoints = 200
  const stride = Math.max(1, Math.ceil(coordinates.length / maxPoints))
  const sampled = coordinates.filter((_, i) => i % stride === 0)
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
        'edge.bicycle_road',    // Fahrradstrasse flag (bicycle_road=yes in OSM)
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

    const data = await response.json() as {
      edges?: ValhallaEdge[]
      matched_points?: Array<{ edge_index?: number }>
    }
    const { edges, matched_points } = data
    if (!edges || !matched_points) return null

    const classified = matched_points
      .map((mp, i) => {
        const coord = sampled[i]
        if (!coord) return null
        const edge = edges[mp.edge_index ?? 0] ?? null
        return { safetyClass: classifyEdge(edge, profileKey), coord: coord as [number, number] }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)

    return buildSegments(classified)
  } catch {
    return null
  }
}

export function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`
  return `${km.toFixed(1)} km`
}

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m} min`
}
