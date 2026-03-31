// In production (surge.sh), route through the Cloudflare Worker.
// In dev, Vite proxy handles /api/* directly.
const API_BASE = import.meta.env.VITE_WORKER_URL ?? '/api'

/**
 * Search for places using Nominatim (OpenStreetMap geocoding).
 * Proxied through /api/nominatim in dev (Vite); through Cloudflare Worker in production.
 */
export async function searchPlaces(query) {
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

  const results = await response.json()
  return results.map((r) => ({
    label: r.display_name,
    shortLabel: r.name || r.display_name.split(',')[0],
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
  }))
}

/**
 * Reverse geocode lat/lng to a place name.
 * Falls back to coordinate string if unavailable.
 */
export async function reverseGeocode(lat, lng) {
  const params = new URLSearchParams({
    lat: lat.toString(),
    lon: lng.toString(),
    format: 'json',
    zoom: '17',
  })

  try {
    const response = await fetch(`${API_BASE}/nominatim/reverse?${params}`)
    if (!response.ok) return null
    const result = await response.json()
    if (result.error) return null
    return {
      label: result.display_name,
      shortLabel: (result.name || result.address?.road || result.display_name.split(',')[0]),
    }
  } catch {
    return null
  }
}
