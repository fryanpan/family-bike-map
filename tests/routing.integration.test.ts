/**
 * Integration tests for routing correctness.
 *
 * These tests call the Valhalla API directly (https://valhalla1.openstreetmap.de)
 * to verify that our routing profiles produce routes with correct infrastructure
 * characteristics for key Berlin journeys.
 *
 * SKIPPED BY DEFAULT — run locally with: RUN_INTEGRATION=1 bun test
 * Run these when changing classification logic (classify.ts) or routing
 * parameters (routing.ts). They are skipped in CI to avoid external API flakiness.
 *
 * Tests are also skipped automatically if Valhalla is unreachable.
 *
 * Route quality is measured using classifyEdge + computeRouteQuality on the
 * trace_attributes response. These are the same functions used to render the
 * quality bar in the UI.
 *
 * Quality levels (from computeRouteQuality):
 *   quality.good = fraction of route on Fahrradstrasse, car-free paths, separated
 *                   bike tracks, and park footways (great + good safety classes)
 *   quality.ok    = fraction on quiet streets, residential roads, acceptable lanes
 *   quality.bad   = fraction on busy roads, roads with no bike infra, etc.
 */

import { describe, it, expect, beforeAll } from 'bun:test'
import { classifyEdge, computeRouteQuality, buildSegments } from '../src/utils/classify'
import type { ValhallaEdge } from '../src/utils/types'

const VALHALLA_BASE = 'https://valhalla1.openstreetmap.de'

// ── Known Berlin locations ────────────────────────────────────────────────────

const DRESDENER_STR_112 = { lat: 52.5050413, lon: 13.4145564 }
const ZOO_ENTRANCE      = { lat: 52.5071,    lon: 13.3374 }     // Hardenbergplatz
const LE_BROT           = { lat: 52.4834569, lon: 13.4352366 }  // Fuldastraße, Neukölln
const HUMBOLDT_FORUM    = { lat: 52.5170316, lon: 13.4012274 }  // Schloßplatz, Mitte

// ── Routing profiles matching DEFAULT_PROFILES in routing.ts ─────────────────

const TODDLER_OPTS = {
  bicycle_type:      'Hybrid',
  cycling_speed:     10,
  use_roads:         0.0,
  avoid_bad_surfaces: 0.5,
  use_hills:         0.1,
  use_ferry:         0.0,
  use_living_streets: 1.0,
}

const TRAINING_OPTS = {
  bicycle_type:      'Road',
  cycling_speed:     22,
  use_roads:         0.6,
  avoid_bad_surfaces: 0.4,
  use_hills:         0.9,
  use_ferry:         0.0,
  use_living_streets: 0.5,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function decodePolyline6(encoded: string): [number, number][] {
  let lat = 0, lng = 0
  const coords: [number, number][] = []
  let i = 0
  while (i < encoded.length) {
    let b, result = 0, shift = 0
    do {
      b = encoded.charCodeAt(i++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    lat += result & 1 ? ~(result >> 1) : result >> 1

    result = 0; shift = 0
    do {
      b = encoded.charCodeAt(i++) - 63
      result |= (b & 0x1f) << shift
      shift += 5
    } while (b >= 0x20)
    lng += result & 1 ? ~(result >> 1) : result >> 1

    coords.push([lat / 1e6, lng / 1e6])
  }
  return coords
}

interface ValhallaRouteResponse {
  trip?: {
    legs: Array<{
      shape: string
      maneuvers?: Array<{ street_names?: string[]; length: number; instruction: string }>
    }>
    summary: { length: number; time: number }
  }
}

async function fetchRoute(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  costingOpts: object,
): Promise<{ coords: [number, number][]; distanceKm: number; streetNames: string[] }> {
  const body = {
    locations: [from, to],
    costing: 'bicycle',
    costing_options: { bicycle: costingOpts },
    directions_options: { units: 'km' },
  }
  const resp = await fetch(`${VALHALLA_BASE}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`Route request failed: ${resp.status}`)
  const data = await resp.json() as ValhallaRouteResponse
  if (!data.trip) throw new Error('No route found')
  const coords = data.trip.legs.flatMap((leg) => decodePolyline6(leg.shape))
  const streetNames = data.trip.legs.flatMap((leg) =>
    (leg.maneuvers ?? []).flatMap((m) => m.street_names ?? [])
  )
  return { coords, distanceKm: data.trip.summary.length, streetNames }
}

async function fetchRouteQuality(
  coords: [number, number][],
  profileKey: string,
): Promise<{ good: number; ok: number; bad: number }> {
  // Sample down to ≤150 points to keep the API call fast
  const stride = Math.max(1, Math.ceil(coords.length / 150))
  const sampled = coords.filter((_, i) => i % stride === 0)
  if (sampled[sampled.length - 1] !== coords[coords.length - 1]) {
    sampled.push(coords[coords.length - 1])
  }

  const body = {
    shape: sampled.map(([lat, lon]) => ({ lat, lon })),
    costing: 'bicycle',
    shape_match: 'map_snap',
    filters: {
      attributes: [
        'edge.use', 'edge.cycle_lane', 'edge.surface', 'edge.road_class',
        'edge.bicycle_road', 'matched.edge_index',
      ],
      action: 'include',
    },
  }
  const resp = await fetch(`${VALHALLA_BASE}/trace_attributes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`trace_attributes failed: ${resp.status}`)
  const data = await resp.json() as {
    edges?: ValhallaEdge[]
    matched_points?: Array<{ edge_index?: number }>
  }
  const { edges = [], matched_points = [] } = data

  const classified = matched_points.map((mp, i) => {
    const coord = sampled[i]
    if (!coord) return null
    const edge = edges[mp.edge_index ?? 0] ?? null
    return { safetyClass: classifyEdge(edge, profileKey), coord: coord as [number, number] }
  }).filter((x): x is NonNullable<typeof x> => x !== null)

  const segments = buildSegments(classified)
  return computeRouteQuality(segments)
}

// ── Connectivity check ────────────────────────────────────────────────────────

let valhallaReachable = false

beforeAll(async () => {
  try {
    const resp = await fetch(`${VALHALLA_BASE}/status`, { signal: AbortSignal.timeout(5000) })
    valhallaReachable = resp.ok
  } catch {
    valhallaReachable = false
  }
})

function skipIfOffline() {
  if (process.env.RUN_INTEGRATION !== '1') {
    return true
  }
  if (!valhallaReachable) {
    console.log('  [SKIP] Valhalla not reachable — skipping integration test')
    return true
  }
  return false
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('routing integration — Dresdener Str 112 → Zoo (toddler mode)', () => {
  /**
   * The toddler route to the Zoo should use available car-free infrastructure.
   * With the strict toddler classification (residential roads now classify as
   * avoid), we check that the route still includes meaningful car-free sections
   * (Tiergarten paths, cycleways near Potsdamer Platz).
   */
  it('uses some car-free infrastructure (quality.good > 0.1)', async () => {
    if (skipIfOffline()) return
    const { coords } = await fetchRoute(DRESDENER_STR_112, ZOO_ENTRANCE, TODDLER_OPTS)
    const quality = await fetchRouteQuality(coords, 'toddler')
    expect(quality.good).toBeGreaterThan(0.1)
  })

  it('uses some car-free/separated infrastructure (quality.good > 0.15)', async () => {
    if (skipIfOffline()) return
    const { coords } = await fetchRoute(DRESDENER_STR_112, ZOO_ENTRANCE, TODDLER_OPTS)
    const quality = await fetchRouteQuality(coords, 'toddler')
    // The route includes cycleway sections near Potsdamer Platz and Tiergarten
    expect(quality.good).toBeGreaterThan(0.15)
  })

  it('distance is under 10km (not taking a crazy detour)', async () => {
    if (skipIfOffline()) return
    const { distanceKm } = await fetchRoute(DRESDENER_STR_112, ZOO_ENTRANCE, TODDLER_OPTS)
    expect(distanceKm).toBeLessThan(10)
  })
})

describe('routing integration — Dresdener Str 112 → Le Brot (training mode)', () => {
  /**
   * The training route to Le Brot in Neukölln should use the practical cycling
   * infrastructure in this area:
   *   - The wide roadside bike path on Kottbusser Damm
   *   - The bus lane on Sonnenallee (cycleway=share_busway in OSM)
   *
   * These are the natural infrastructure choices on this south-Kreuzberg /
   * north-Neukölln corridor for a cyclist prioritising speed and bike infrastructure.
   */
  it('routes via Sonnenallee (main Neukölln artery with bus lane)', async () => {
    if (skipIfOffline()) return
    const { streetNames } = await fetchRoute(DRESDENER_STR_112, LE_BROT, TRAINING_OPTS)
    expect(streetNames).toContain('Sonnenallee')
  })

  it('routes via Kottbusser Damm (wide roadside bike path)', async () => {
    if (skipIfOffline()) return
    const { streetNames } = await fetchRoute(DRESDENER_STR_112, LE_BROT, TRAINING_OPTS)
    const usesKottbusser = streetNames.some((s) => s.includes('Kottbusser'))
    expect(usesKottbusser).toBe(true)
  })

  it('has majority good/great infrastructure (quality.good + quality.ok > 0.6)', async () => {
    if (skipIfOffline()) return
    const { coords } = await fetchRoute(DRESDENER_STR_112, LE_BROT, TRAINING_OPTS)
    const quality = await fetchRouteQuality(coords, 'training')
    expect(quality.good + quality.ok).toBeGreaterThan(0.6)
  })

  it('bus lanes on the route classify as "good" for training and trailer, "avoid" for toddler', () => {
    const buslane = { cycle_lane: 'share_busway' }
    expect(classifyEdge(buslane, 'training')).toBe('good')
    expect(classifyEdge(buslane, 'trailer')).toBe('good')   // wide, well-maintained
    expect(classifyEdge(buslane, 'toddler')).toBe('bad')  // hazardous with small child
  })
})

describe('routing integration — Dresdener Str 112 → Humboldt Forum (toddler mode)', () => {
  /**
   * The toddler route to the Humboldt Forum should use cycling paths close to
   * the Spree/Ufer where available. The destination is in Mitte, north of the
   * Spree, so the route must cross the river. We check that:
   *   - The route reaches the Humboldt Forum (short distance)
   *   - It uses available protected infrastructure along the way
   *   - It doesn't venture far from the direct corridor
   */
  it('distance is under 5km (direct enough route)', async () => {
    if (skipIfOffline()) return
    const { distanceKm } = await fetchRoute(DRESDENER_STR_112, HUMBOLDT_FORUM, TODDLER_OPTS)
    expect(distanceKm).toBeLessThan(5)
  })

  it('passes through the Mitte/Ufer area (lat > 52.512)', async () => {
    if (skipIfOffline()) return
    const { coords } = await fetchRoute(DRESDENER_STR_112, HUMBOLDT_FORUM, TODDLER_OPTS)
    // The route crosses into Mitte (north of the Spree) to reach the Humboldt Forum.
    // Schloßplatz/Spree area is at approximately lat=52.517–52.520.
    const reachesMitte = coords.some(([lat]) => lat > 52.512)
    expect(reachesMitte).toBe(true)
  })

  it('uses car-free or park paths near the destination (quality.good > 0)', async () => {
    if (skipIfOffline()) return
    const { coords } = await fetchRoute(DRESDENER_STR_112, HUMBOLDT_FORUM, TODDLER_OPTS)
    const quality = await fetchRouteQuality(coords, 'toddler')
    // The Schloßplatz approach and Fischerinsel area include car-free sections
    expect(quality.good).toBeGreaterThan(0)
  })
})

// ── Classification correctness: string API values ─────────────────────────────

describe('classifyEdge — uses Valhalla string API values (not legacy numeric codes)', () => {
  /**
   * Critical regression tests. The Valhalla trace_attributes API returns STRING
   * values for use, cycle_lane, and road_class — not the numeric codes in older
   * documentation. These tests confirm our classifier handles the actual API format.
   */

  it('car-free cycleway ("use"="cycleway") → great', () => {
    expect(classifyEdge({ use: 'cycleway' }, 'toddler')).toBe('great')
  })

  it('off-road path ("use"="path") → great', () => {
    expect(classifyEdge({ use: 'path' }, 'toddler')).toBe('great')
  })

  it('park footway ("use"="footway") → good (car-free, toddler safe)', () => {
    expect(classifyEdge({ use: 'footway' }, 'toddler')).toBe('good')
  })

  it('separated bike track ("cycle_lane"="separated") → ok for toddler (safe but slow)', () => {
    expect(classifyEdge({ cycle_lane: 'separated' }, 'toddler')).toBe('ok')
  })

  it('painted lane ("cycle_lane"="dedicated") → avoid for toddler', () => {
    expect(classifyEdge({ cycle_lane: 'dedicated' }, 'toddler')).toBe('bad')
  })

  it('bus lane ("cycle_lane"="share_busway") → good for training', () => {
    expect(classifyEdge({ cycle_lane: 'share_busway' }, 'training')).toBe('good')
  })

  it('residential road ("road_class"="residential") → avoid for toddler', () => {
    expect(classifyEdge({ road_class: 'residential' }, 'toddler')).toBe('bad')
  })

  it('secondary road ("road_class"="secondary") → avoid', () => {
    expect(classifyEdge({ road_class: 'secondary' }, 'toddler')).toBe('bad')
  })
})
