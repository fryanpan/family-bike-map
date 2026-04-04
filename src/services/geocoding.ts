import type { Place } from '../utils/types'

// All API calls use relative paths — same origin in production (Cloudflare Worker
// serves both assets and API), and proxied via wrangler dev locally.
const API_BASE = '/api'

interface NominatimResult {
  display_name: string
  name?: string
  lat: string
  lon: string
  address?: {
    house_number?: string
    road?: string
  }
}

// Returns true if the query looks like a street address (contains digits)
function looksLikeAddress(query: string): boolean {
  return /\d/.test(query)
}

function mapResults(results: NominatimResult[]): Place[] {
  return results.map((r) => {
    let shortLabel: string
    // Prefer the result's own name (POI, landmark) when it's distinct from the road.
    // Only format as "Road HouseNumber" for pure address results that lack a named entity.
    if (r.name && r.name !== r.address?.road) {
      shortLabel = r.name
    } else if (r.address?.road) {
      shortLabel = r.address.house_number
        ? `${r.address.road} ${r.address.house_number}`
        : r.address.road
    } else {
      shortLabel = r.display_name.split(',')[0]
    }
    return {
      label: r.display_name,
      shortLabel,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
    }
  })
}

/**
 * Search for places using Nominatim (OpenStreetMap geocoding).
 * Proxied through /api/nominatim in dev (Vite); through Cloudflare Worker in production.
 *
 * For address-like queries (containing digits), tries structured search first
 * (street + city params) which Nominatim handles better than free-text for
 * house number lookups. Falls back to free-text search if no results.
 *
 * @param bias - Optional lat/lng point to softly bias results toward (e.g. the start location).
 *   Adds a viewbox of ~100km around the point; bounded=0 so worldwide results still appear
 *   if nothing is found nearby.
 */
export async function searchPlaces(query: string, bias?: { lat: number; lng: number }): Promise<Place[]> {
  if (!query || query.length < 2) return []

  const biasParams: Record<string, string> = bias
    ? {
        viewbox: `${bias.lng - 1.5},${bias.lat - 1.0},${bias.lng + 1.5},${bias.lat + 1.0}`,
        bounded: '0',
      }
    : {}

  const baseParams = {
    format: 'json',
    limit: '5',
    'accept-language': 'en',
    addressdetails: '1',
    ...biasParams,
  }

  // For address-like queries, try structured Nominatim search first.
  // This handles "Dresdener Str 112" style queries far better than free-text.
  if (looksLikeAddress(query)) {
    try {
      const structuredParams = new URLSearchParams({
        ...baseParams,
        street: query,
      })
      const resp = await fetch(`${API_BASE}/nominatim/search?${structuredParams}`)
      if (resp.ok) {
        const results = (await resp.json()) as NominatimResult[]
        if (results.length > 0) return mapResults(results)
      }
    } catch {
      // Fall through to free-text search
    }
  }

  // Free-text search fallback (also used for non-address queries).
  const params = new URLSearchParams({
    ...baseParams,
    q: query,
  })

  const response = await fetch(`${API_BASE}/nominatim/search?${params}`)
  if (!response.ok) throw new Error('Geocoding search failed')

  const results = (await response.json()) as NominatimResult[]
  return mapResults(results)
}

/**
 * Reverse geocode lat/lng to a place name.
 * Returns null if unavailable.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<Pick<Place, 'label' | 'shortLabel'> | null> {
  const params = new URLSearchParams({
    lat: lat.toString(),
    lon: lng.toString(),
    format: 'json',
    zoom: '17',
  })

  try {
    const response = await fetch(`${API_BASE}/nominatim/reverse?${params}`)
    if (!response.ok) return null
    const result = await response.json() as {
      display_name?: string
      name?: string
      address?: { road?: string }
      error?: string
    }
    if (result.error || !result.display_name) return null
    return {
      label: result.display_name,
      shortLabel: result.name ?? result.address?.road ?? result.display_name.split(',')[0],
    }
  } catch {
    return null
  }
}
