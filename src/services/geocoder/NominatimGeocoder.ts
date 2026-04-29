// Nominatim adapter for the GeocoderEngine interface.
//
// Hits the existing /api/nominatim/* Worker proxy (Cloudflare in prod,
// Vite proxy in dev). All Nominatim hits include lat/lng inline, so
// placeDetails() is a passthrough — there is no second round trip.
//
// Logic mirrors the pre-refactor src/services/geocoding.ts:
//   - For address-like queries (containing digits) we try a structured
//     search first (street=…) which Nominatim handles much better than
//     free-text for house-number lookups.
//   - Falls back to free-text when structured returns empty.
//   - Optional bias point widens a viewbox around the user's current
//     location; bounded=0 keeps worldwide hits available.

import type { Place } from '../../utils/types'
import type { AutocompleteResult, GeocoderEngine } from './types'

const API_BASE = '/api'

interface NominatimResult {
  display_name: string
  name?: string
  lat: string
  lon: string
  address?: {
    house_number?: string
    road?: string
    suburb?: string
    city?: string
    town?: string
    village?: string
    city_district?: string
  }
}

function looksLikeAddress(query: string): boolean {
  return /\d/.test(query)
}

function shortLabelFor(r: NominatimResult): string {
  // Prefer the result's own name (POI, landmark) when distinct from
  // the road. Only format as "Road HouseNumber" for pure address
  // results without a named entity.
  if (r.name && r.name !== r.address?.road) return r.name
  if (r.address?.road) {
    return r.address.house_number
      ? `${r.address.road} ${r.address.house_number}`
      : r.address.road
  }
  return r.display_name.split(',')[0]
}

function toAutocompleteResult(r: NominatimResult): AutocompleteResult {
  const lat = parseFloat(r.lat)
  const lng = parseFloat(r.lon)
  return {
    id: `${lat},${lng}`,
    label: r.display_name,
    shortLabel: shortLabelFor(r),
    lat,
    lng,
  }
}

export class NominatimGeocoder implements GeocoderEngine {
  readonly kind = 'nominatim' as const

  async autocomplete(query: string, bias?: { lat: number; lng: number }): Promise<AutocompleteResult[]> {
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

    if (looksLikeAddress(query)) {
      try {
        const structuredParams = new URLSearchParams({
          ...baseParams,
          street: query,
        })
        const resp = await fetch(`${API_BASE}/nominatim/search?${structuredParams}`)
        if (resp.ok) {
          const results = (await resp.json()) as NominatimResult[]
          if (results.length > 0) return results.map(toAutocompleteResult)
        }
      } catch {
        // fall through to free-text
      }
    }

    const params = new URLSearchParams({ ...baseParams, q: query })
    const response = await fetch(`${API_BASE}/nominatim/search?${params}`)
    if (!response.ok) throw new Error('Geocoding search failed')
    const results = (await response.json()) as NominatimResult[]
    return results.map(toAutocompleteResult)
  }

  async placeDetails(result: AutocompleteResult): Promise<Place | null> {
    // Nominatim already returned lat/lng in autocomplete — no second
    // round trip. If something stripped them, treat as unresolvable.
    if (typeof result.lat !== 'number' || typeof result.lng !== 'number') return null
    return {
      label: result.label,
      shortLabel: result.shortLabel,
      lat: result.lat,
      lng: result.lng,
    }
  }

  async reverseGeocode(lat: number, lng: number): Promise<Pick<Place, 'label' | 'shortLabel'> | null> {
    const params = new URLSearchParams({
      lat: lat.toString(),
      lon: lng.toString(),
      format: 'json',
      zoom: '17',
    })

    try {
      const response = await fetch(`${API_BASE}/nominatim/reverse?${params}`)
      if (!response.ok) return null
      const result = (await response.json()) as {
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
}
