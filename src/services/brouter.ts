/**
 * BRouter routing service.
 *
 * Calls the /api/brouter proxy (which forwards to brouter.de/brouter) and
 * parses the GeoJSON response into our Route type, including per-segment
 * OSM tags extracted from the BRouter `messages` array.
 */

import type { Place, Route, RouteSegment, RouteLtsBreakdown, LtsSegmentInfo } from '../utils/types'
import { computeLts, computeLtsBreakdown } from '../utils/lts'

const API_BASE = '/api'

/** A single row from BRouter's messages array (after the header row). */
interface BRouterMessageRow {
  lng: number      // degrees (from integer * 1e-5)
  lat: number      // degrees
  distance: number // meters from previous point
  wayTags: Record<string, string>
  time: number     // seconds from previous point
}

/** Raw BRouter GeoJSON response structure. */
interface BRouterGeoJSON {
  type: 'FeatureCollection'
  features: Array<{
    properties: {
      'track-length': number  // meters
      'total-time': number    // seconds
      messages: Array<(string | number)[]>
    }
    geometry: {
      type: 'LineString'
      coordinates: [number, number, number][] // [lng, lat, elevation]
    }
  }>
}

/**
 * Parse BRouter's `messages` array into structured rows.
 *
 * The first row is a header: ["Longitude","Latitude","Elevation","Distance",...,"WayTags",...]
 * Subsequent rows contain the actual data with integer lon/lat in 1e-5 degrees.
 */
export function parseMessages(messages: Array<(string | number)[]>): BRouterMessageRow[] {
  if (messages.length < 2) return []

  const header = messages[0] as string[]
  const wayTagsIdx = header.indexOf('WayTags')
  const distIdx = header.indexOf('Distance')
  const timeIdx = header.indexOf('Time')

  const rows: BRouterMessageRow[] = []
  for (let i = 1; i < messages.length; i++) {
    const row = messages[i]
    const lngRaw = Number(row[0])
    const latRaw = Number(row[1])
    const distance = distIdx >= 0 ? Number(row[distIdx]) : 0
    const time = timeIdx >= 0 ? Number(row[timeIdx]) : 0
    const wayTagsStr = wayTagsIdx >= 0 ? String(row[wayTagsIdx]) : ''

    const wayTags: Record<string, string> = {}
    if (wayTagsStr) {
      for (const pair of wayTagsStr.split(' ')) {
        const eqIdx = pair.indexOf('=')
        if (eqIdx > 0) {
          wayTags[pair.slice(0, eqIdx)] = pair.slice(eqIdx + 1)
        }
      }
    }

    rows.push({
      lng: lngRaw * 1e-6,
      lat: latRaw * 1e-6,
      distance,
      wayTags,
      time,
    })
  }

  return rows
}

/**
 * Build RouteSegments from BRouter message rows.
 *
 * Groups consecutive points that share the same highway tag into segments.
 * The itemName is derived from the OSM `highway` tag for basic classification.
 */
export function buildBRouterSegments(
  messageRows: BRouterMessageRow[],
  coordinates: [number, number][],
): RouteSegment[] {
  if (messageRows.length === 0 || coordinates.length === 0) return []

  // For each message row, determine an item name based on OSM tags
  const segments: RouteSegment[] = []
  let currentItem: string | null = null
  let currentCoords: [number, number][] = []

  // We use the route coordinates directly since message rows are sparse
  // (one per OSM way change). Map message rows to a simple tag-per-segment approach.
  let currentWalking = false

  for (const row of messageRows) {
    const item = classifyBRouterTags(row.wayTags)
    const walking = isWalkingSegment(row.wayTags)
    const coord: [number, number] = [row.lat, row.lng]

    if ((item !== currentItem || walking !== currentWalking) && currentCoords.length > 0) {
      // Bridge: last coord of prev segment = first coord of new segment
      segments.push({
        itemName: currentItem,
        coordinates: [...currentCoords],
        ...(currentWalking ? { isWalking: true } : {}),
      })
      currentCoords = [currentCoords[currentCoords.length - 1]]
    }

    currentItem = item
    currentWalking = walking
    currentCoords.push(coord)
  }

  if (currentCoords.length > 0) {
    segments.push({
      itemName: currentItem,
      coordinates: currentCoords,
      ...(currentWalking ? { isWalking: true } : {}),
    })
  }

  return segments
}

/**
 * Classify BRouter OSM tags into a legend item name.
 * Uses the same naming as our Valhalla classify logic where possible.
 */
function classifyBRouterTags(tags: Record<string, string>): string | null {
  if (tags['bicycle_road'] === 'yes') return 'Fahrradstrasse'
  if (tags['highway'] === 'cycleway') return 'Separated bike path'
  if (tags['highway'] === 'path' || tags['highway'] === 'track') return 'Car-free trail'
  if (tags['highway'] === 'living_street') return 'Quiet side street'
  if (tags['highway'] === 'residential') return 'Quiet side street'
  if (tags['cycleway'] === 'lane' || tags['cycleway'] === 'track') return 'On-road bike lane'
  return null
}

/**
 * Detect whether a BRouter segment requires walking/dismounting.
 *
 * Walking segments are:
 * - highway=footway without bicycle=yes or bicycle=designated
 * - highway=steps (stairs)
 * - bicycle=dismount
 */
export function isWalkingSegment(tags: Record<string, string>): boolean {
  if (tags['bicycle'] === 'dismount') return true
  if (tags['highway'] === 'steps') return true
  if (tags['highway'] === 'footway' &&
      tags['bicycle'] !== 'yes' &&
      tags['bicycle'] !== 'designated') {
    return true
  }
  return false
}

/**
 * Build a RouteLtsBreakdown from BRouter message rows.
 * Each row represents a segment with OSM tags and a distance.
 */
function buildLtsBreakdown(rows: BRouterMessageRow[]): RouteLtsBreakdown | undefined {
  if (rows.length === 0) return undefined

  const ltsSegments = rows
    .filter((r) => r.distance > 0)
    .map((r) => ({ tags: r.wayTags, lengthM: r.distance }))

  if (ltsSegments.length === 0) return undefined

  const breakdown = computeLtsBreakdown(ltsSegments)

  // Find the worst segment (highest LTS, longest distance as tiebreaker)
  let worstSegment: LtsSegmentInfo | null = null
  let worstLts = 0
  let worstLen = 0

  for (const row of rows) {
    if (row.distance <= 0) continue
    const lts = computeLts(row.wayTags)
    const name = row.wayTags.name ?? row.wayTags.highway ?? 'unnamed'
    if (lts > worstLts || (lts === worstLts && row.distance > worstLen)) {
      worstLts = lts
      worstLen = row.distance
      worstSegment = { name, lts: lts, lengthM: row.distance }
    }
  }

  return {
    ...breakdown,
    worstSegment,
  }
}

/**
 * Parse a BRouter GeoJSON response into a Route.
 */
function parseFeature(feature: BRouterGeoJSON['features'][0]): Route {
  // Convert [lng, lat, elev] → [lat, lng]
  const coordinates: [number, number][] = feature.geometry.coordinates.map(
    ([lng, lat]) => [lat, lng],
  )

  const messageRows = parseMessages(feature.properties.messages)
  const segments = buildBRouterSegments(messageRows, coordinates)
  const ltsBreakdown = buildLtsBreakdown(messageRows)

  return {
    coordinates,
    maneuvers: [], // BRouter turn instructions not used yet
    summary: {
      distance: feature.properties['track-length'] / 1000, // meters → km
      duration: feature.properties['total-time'],           // seconds
    },
    segments: segments.length > 0 ? segments : undefined,
    engine: 'brouter',
    ltsBreakdown,
  }
}

/**
 * Fetch BRouter route(s) for a start/end pair.
 *
 * Returns up to 2 routes (primary + one alternate) by requesting alternativeidx 0 and 1.
 * If the alternate request fails (not all routes have alternates), only the primary is returned.
 */
// Map our travel modes to the closest BRouter profiles
const BROUTER_PROFILES: Record<string, string> = {
  toddler: 'safety',               // most road-avoiding, supports dismount fallback
  trailer: 'safety',               // same — avoids busy roads, penalizes bad surfaces
  training: 'fastbike-lowtraffic', // faster but still avoids high-traffic roads
}

export async function getBRouterRoutes(start: Place, end: Place, travelMode?: string): Promise<Route[]> {
  const lonlats = `${start.lng},${start.lat}|${end.lng},${end.lat}`
  const profile = BROUTER_PROFILES[travelMode ?? 'toddler'] ?? 'safety'
  const baseParams = `lonlats=${lonlats}&profile=${profile}&format=geojson`

  // Fetch primary and alternate in parallel
  const [primaryResp, altResp] = await Promise.all([
    fetch(`${API_BASE}/brouter?${baseParams}&alternativeidx=0`),
    fetch(`${API_BASE}/brouter?${baseParams}&alternativeidx=1`).catch(() => null),
  ])

  if (!primaryResp.ok) {
    throw new Error(`BRouter routing failed (${primaryResp.status})`)
  }

  const primaryData = await primaryResp.json() as BRouterGeoJSON
  if (!primaryData.features?.length) {
    throw new Error('BRouter returned no route')
  }

  const routes: Route[] = [parseFeature(primaryData.features[0])]

  // Try to parse alternate if available
  if (altResp?.ok) {
    try {
      const altData = await altResp.json() as BRouterGeoJSON
      if (altData.features?.length) {
        routes.push(parseFeature(altData.features[0]))
      }
    } catch {
      // Alternate not available — that's fine
    }
  }

  return routes
}
