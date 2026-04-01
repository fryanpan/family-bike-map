import type { Place } from '../utils/types'

// All API calls use relative paths — same origin in production (Cloudflare Worker
// serves both assets and API), and proxied via wrangler dev locally.
const API_BASE = '/api'

/**
 * Search for places using Nominatim (OpenStreetMap geocoding).
 * Proxied through /api/nominatim in dev (Vite); through Cloudflare Worker in production.
 */
export async function searchPlaces(query: string): Promise<Place[]> {
  if (!query || query.length < 2) return []

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    limit: '5',
    countrycodes: 'de',
    // Berlin bounding box
    viewbox: '13.088,52.338,13.761,52.675',
    bounded: '1',
    'accept-language': 'en',
  })

  const response = await fetch(`${API_BASE}/nominatim/search?${params}`)
  if (!response.ok) throw new Error('Geocoding search failed')

  const results = await response.json() as Array<{
    display_name: string
    name?: string
    lat: string
    lon: string
  }>

  return results.map((r) => ({
    label: r.display_name,
    shortLabel: r.name ?? r.display_name.split(',')[0],
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
  }))
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
