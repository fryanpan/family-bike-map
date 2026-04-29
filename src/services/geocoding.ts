// Thin facade over the pluggable geocoder engines (see ./geocoder/).
//
// Existing callers (App.tsx's `resolveCurrentLocation`, the geocoding
// tests) call these top-level functions; they delegate to whichever
// engine the admin settings point at. Search-time autocomplete now
// flows through `useActiveGeocoder()` directly inside SearchBar — this
// module is for non-React callers who just want the active engine's
// autocomplete or reverse-geocode without thinking about it.

import type { Place } from '../utils/types'
import { getActiveGeocoder } from './geocoder/resolve'

/**
 * Search for places using the currently-selected geocoder engine.
 * Returns full `Place` objects with coordinates resolved — calls
 * `engine.autocomplete()` and immediately `engine.placeDetails()` on
 * each hit. This matches the legacy contract of the old Nominatim-only
 * `searchPlaces`. Most callers should prefer the
 * `engine.autocomplete()` + tap-time `engine.placeDetails()` path
 * (used in SearchBar) for cheaper Google billing.
 *
 * @param bias - Optional lat/lng point to softly bias results toward.
 */
export async function searchPlaces(
  query: string,
  bias?: { lat: number; lng: number },
): Promise<Place[]> {
  const engine = getActiveGeocoder()
  const hits = await engine.autocomplete(query, bias)
  const places = await Promise.all(hits.map((h) => engine.placeDetails(h)))
  return places.filter((p): p is Place => p !== null)
}

/**
 * Reverse geocode lat/lng to a place name via the active engine.
 * Returns null if unavailable.
 */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<Pick<Place, 'label' | 'shortLabel'> | null> {
  return getActiveGeocoder().reverseGeocode(lat, lng)
}
