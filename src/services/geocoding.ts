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
 */
export async function searchPlaces(query: string): Promise<Place[]> {
  if (!query || query.length < 2) return []

  const baseParams = {
    format: 'json',
    limit: '5',
    countrycodes: 'de',
    // Berlin bounding box — used as preference hint (bounded=0) or hard constraint (bounded=1)
    viewbox: '13.088,52.338,13.761,52.675',
    'accept-language': 'en',
    addressdetails: '1',
  }

  // For address-like queries, try structured Nominatim search first.
  // This handles "Dresdener Str 112" style queries far better than free-text.
  if (looksLikeAddress(query)) {
    try {
      const structuredParams = new URLSearchParams({
        ...baseParams,
        street: query,
        city: 'Berlin',
        bounded: '0',
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

  // Free-text search. For address queries with no structured result, relax the
  // bounding box to a soft preference so addresses near the Berlin boundary aren't dropped.
  const params = new URLSearchParams({
    ...baseParams,
    q: query,
    bounded: looksLikeAddress(query) ? '0' : '1',
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
