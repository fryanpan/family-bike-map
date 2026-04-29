// Saved-place priority — pure-ish helper used by SearchBar to prepend
// Home / School matches above engine autocomplete results.
//
// Lives outside the React tree so it's trivially testable: a Bun test
// can stub a `localStorage` shim and assert behaviour without importing
// SearchBar's tsx tree.
//
// The set of "saved places" is currently hardcoded (Home, School) to
// match what App.tsx persists. If we later add user-defined named
// pins (e.g. "Daycare"), extend SAVED_PLACES below — the search-bar
// integration is the same.

import type { Place } from '../../utils/types'
import type { AutocompleteResult } from './types'

export interface SavedPlaceDef {
  storageKey: string
  emoji: string
  /** Pretty name shown in the suggestion list. */
  name: string
}

export const SAVED_PLACES: readonly SavedPlaceDef[] = [
  { storageKey: 'bike-route-home',   emoji: '🏠', name: 'Home' },
  { storageKey: 'bike-route-school', emoji: '🏫', name: 'School' },
] as const

/**
 * Read a saved place from localStorage. Returns null if missing or
 * malformed (e.g. partial write, schema drift).
 */
export function loadSavedPlace(key: string): Place | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Place
    if (
      typeof parsed?.lat === 'number' &&
      typeof parsed?.lng === 'number' &&
      typeof parsed?.label === 'string'
    ) {
      return parsed
    }
  } catch { /* ignore */ }
  return null
}

/**
 * Substring-match the user's saved places against a query.
 *
 * A saved place matches when the lowercased query appears anywhere in
 * `${name} ${shortLabel} ${label}` — so typing "home" finds Home even
 * when the persisted address has nothing called "home" in it, and
 * typing "Dresdener" still finds Home if Home is on Dresdener Str.
 *
 * Returns AutocompleteResult-shaped entries with lat/lng inlined so
 * the SearchBar tap-handler can short-circuit `placeDetails()`.
 */
export function matchSavedPlaces(query: string): AutocompleteResult[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return []
  const out: AutocompleteResult[] = []
  for (const saved of SAVED_PLACES) {
    const place = loadSavedPlace(saved.storageKey)
    if (!place) continue
    const haystack = `${saved.name} ${place.shortLabel} ${place.label}`.toLowerCase()
    if (!haystack.includes(q)) continue
    out.push({
      id: `saved:${saved.storageKey}`,
      label: place.label,
      shortLabel: `${saved.emoji} ${saved.name} — ${place.shortLabel}`,
      lat: place.lat,
      lng: place.lng,
      iconPrefix: saved.emoji,
    })
  }
  return out
}

/**
 * Drop entries whose lat/lng are within ~50 m of an entry in `primary`.
 * Used to dedup engine-side hits against saved-place hits so we don't
 * show "Home" twice when the engine also nominates the same address.
 *
 * 50 m is small enough to never collapse legitimately-different
 * places, large enough to absorb minor rounding between Nominatim and
 * Google geocoders.
 */
export function dedupAgainst(
  primary: AutocompleteResult[],
  rest: AutocompleteResult[],
): AutocompleteResult[] {
  const EPS = 0.0005 // ~55 m at the equator, decent everywhere
  return rest.filter((r) => {
    const rLat = r.lat
    const rLng = r.lng
    if (typeof rLat !== 'number' || typeof rLng !== 'number') return true
    return !primary.some((p) => {
      const pLat = p.lat
      const pLng = p.lng
      if (typeof pLat !== 'number' || typeof pLng !== 'number') return false
      return Math.abs(pLat - rLat) < EPS && Math.abs(pLng - rLng) < EPS
    })
  })
}
