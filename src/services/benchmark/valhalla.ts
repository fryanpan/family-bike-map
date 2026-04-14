// Valhalla routing — BENCHMARK ONLY.
// Not used by the main web app. Kept so we can compare client-side routing
// quality and timing against the public Valhalla instance from
// src/services/routerBenchmark.ts and src/components/AuditEvalTab.tsx.
import { decode } from '../../utils/polyline'
import { classifyEdgeToItem, buildSegments } from '../../utils/classify'
import { DEFAULT_PROFILES } from '../../data/profiles'
import { formatDistance, formatDuration } from '../../utils/format'
import type {
  Place,
  LatLng,
  RiderProfile,
  Route,
  RouteSegment,
  ValhallaEdge,
} from '../../utils/types'

// Re-export for benchmark consumers that previously imported from this file.
export { DEFAULT_PROFILES, formatDistance, formatDuration }

// All API calls use relative paths — same origin in production (Cloudflare Worker
// serves both assets and API), and proxied via wrangler dev locally.
const API_BASE = '/api'

// DEFAULT_PROFILES has moved to src/data/profiles.ts (single source of truth
// for the 5 ride modes). It is re-exported above so existing benchmark
// imports continue to work.

interface ValhallaManeuverRaw {
  type: number
  instruction: string
  length: number
  time: number
  begin_shape_index?: number
}

interface ValhallaTrip {
  legs: Array<{ shape: string; maneuvers?: ValhallaManeuverRaw[] }>
  summary: { length: number; time: number }
}

/** Parse a single Valhalla trip object into our Route type. */
function parseTrip(trip: ValhallaTrip): Route {
  const coordinates = trip.legs.flatMap((leg) => decode(leg.shape, 6))
  const maneuvers = trip.legs.flatMap((leg) => leg.maneuvers ?? [])
  return {
    coordinates,
    maneuvers,
    summary: {
      distance: trip.summary.length, // km
      duration: trip.summary.time,   // seconds
    },
  }
}

/**
 * Request route(s) from the Valhalla public instance.
 *
 * When alternates > 0, Valhalla returns the primary route in `trip` and
 * additional routes in an `alternates` array (each with its own `trip`).
 * We return all routes as an array, primary first.
 *
 * Alternates are only requested when there are no intermediate waypoints
 * (Valhalla does not support alternates with via points).
 */
export async function getRoute(
  start: Place,
  end: Place,
  profile: RiderProfile,
  waypoints: LatLng[] = [],
  alternates: number = 0,
): Promise<Route[]> {
  const locations = [
    { lat: start.lat, lon: start.lng },
    ...waypoints.map((wp) => ({ lat: wp.lat, lon: wp.lng })),
    { lat: end.lat, lon: end.lng },
  ]

  // If the profile has cobblestones in avoidances, enforce avoid_bad_surfaces >= 0.5
  // (treats cobblestones as a separate, explicitly-controlled avoidance category)
  const costingOptions = profile.avoidances?.includes('cobblestones')
    ? { ...profile.costingOptions, avoid_bad_surfaces: Math.max(0.5, profile.costingOptions.avoid_bad_surfaces) }
    : profile.costingOptions

  // Only request alternates when there are no intermediate waypoints
  const requestAlternates = alternates > 0 && waypoints.length === 0

  const body = {
    locations,
    costing: 'bicycle',
    costing_options: { bicycle: costingOptions },
    directions_options: { units: 'km', language: 'en-US' },
    ...(requestAlternates ? { alternates } : {}),
  }

  let response: Response | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await fetch(`${API_BASE}/valhalla/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.status !== 429) break
    // Rate limited — wait and retry
    await new Promise((r) => setTimeout(r, (attempt + 1) * 2000))
  }

  if (!response || !response.ok) {
    const err = response ? await response.json().catch(() => ({})) as { error_message?: string; error?: string } : { error: 'Network error' }
    throw new Error(err.error_message ?? err.error ?? `Routing failed (${response?.status})`)
  }

  const data = await response.json() as {
    trip?: ValhallaTrip
    alternates?: Array<{ trip: ValhallaTrip }>
  }
  if (!data.trip) throw new Error('No route found between these points')

  const routes: Route[] = [parseTrip(data.trip)]

  // Append any alternate routes Valhalla returned
  if (data.alternates) {
    for (const alt of data.alternates) {
      if (alt.trip) routes.push(parseTrip(alt.trip))
    }
  }

  return routes
}

/**
 * Fetch per-edge attributes for a route from Valhalla trace_attributes.
 * Returns profile-aware colored segments, or null on failure.
 *
 * profileKey is passed to classifyEdgeToItem() so segment item names reflect what THIS
 * profile maps the infrastructure to — e.g. separated tracks get different item names
 * per profile (toddler vs trailer vs training).
 *
 * Key fix: requests edge.bicycle_road to correctly identify Fahrradstrasse
 * (bicycle_road=yes). The old code used edge.bicycle_network which tracks cycling
 * route memberships (NCN/RCN/LCN) — most Berlin Fahrradstrassen are not in a named
 * network so they were misclassified as 'acceptable'.
 */
export async function getRouteSegments(
  coordinates: [number, number][],
  profileKey: string,
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
        return { itemName: classifyEdgeToItem(edge, profileKey), coord: coord as [number, number] }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)

    return buildSegments(classified)
  } catch {
    return null
  }
}

// formatDistance and formatDuration moved to src/utils/format.ts.
// Re-exported at the top of this file for benchmark consumers.
