# Pluggable location-search (geocoder) plan

Date: 2026-04-29

## Why

Current Nominatim-only search misses common queries (e.g.
"Dresdener Str 112" surfaces Bryan's home as the third result, and
mobile typos rarely resolve at all). Users expect Google-Maps-quality
autocomplete; we now have a `VITE_GOOGLE_MAPS_KEY` available from
the map-engine PR that we can reuse for Places + Geocoding.

## Goal

Same shape as the map-engine abstraction: a `GeocoderEngine`
interface, two implementations (Nominatim, Google), a resolver that
picks based on `adminSettings.geocoderEngine` and falls back to
Nominatim when the Google key isn't set, and a settings dropdown
beside the map-engine one.

Plus: saved-places (`Home`, `School`) match-and-rank-first in the
search UI itself, so "Dresdener" shows Bryan's home above any
geocoder result regardless of engine.

## Pieces

1. `src/services/geocoder/types.ts` — interface + result shape
2. `src/services/geocoder/NominatimGeocoder.ts` — port existing
   `geocoding.ts` (lat/lng inline, `placeDetails` is no-op)
3. `src/services/geocoder/GoogleGeocoder.ts` — uses
   `@googlemaps/js-api-loader` + `places` library;
   AutocompleteService for typing, PlacesService.getDetails for
   resolution, Geocoder for reverse
4. `src/services/geocoder/resolve.ts` — picks active engine, falls
   back to Nominatim on missing key
5. `src/services/adminSettings.ts` — add `geocoderEngine: 'nominatim'
   | 'google'`, default `'nominatim'`
6. `src/components/AdminSettingsTab.tsx` — geocoder dropdown next to
   map-engine (keyed by env-key presence)
7. `src/components/SearchBar.tsx` — call active engine's
   autocomplete, prepend saved-places matches, on tap call
   `placeDetails()`
8. `src/services/geocoding.ts` — shrink to a thin facade that
   delegates to `getActiveGeocoder()`, so any non-search caller
   keeps working
9. Tests — `tests/geocoder/savedPlaces.test.ts` + `tests/geocoder/
   resolve.test.ts`

## Interface

```ts
export interface AutocompleteResult {
  id: string
  label: string
  shortLabel: string
  // Engines that have lat/lng from autocomplete (Nominatim) include
  // them; placeDetails becomes a passthrough. Google omits and the UI
  // calls placeDetails to resolve.
  lat?: number
  lng?: number
}

export interface GeocoderEngine {
  kind: 'nominatim' | 'google'
  autocomplete(query: string, bias?: { lat: number; lng: number }): Promise<AutocompleteResult[]>
  placeDetails(result: AutocompleteResult): Promise<Place | null>
  reverseGeocode(lat: number, lng: number): Promise<Pick<Place, 'label' | 'shortLabel'> | null>
}
```

## Saved-places priority

Lives in `SearchBar` (UI layer), not the engine. On every keystroke:
1. Read `bike-route-home` and `bike-route-school` from localStorage
2. Substring-match (case-insensitive) against the query — match if
   `label` OR `shortLabel` contains the query
3. Prepend matched saved places to the engine's autocomplete results,
   prefixed with a 🏠 / 🏫 icon
4. The engine call still fires; once it returns, the saved-places
   block stays on top, dedup any engine results pointing at the same
   coords (within a small epsilon)

This is independent of engine choice and instant — the user sees Home
without waiting for a network round-trip.

## Commits

1. types + interface
2. NominatimGeocoder
3. GoogleGeocoder + add `@googlemaps/js-api-loader` dep
4. resolver + admin setting + dropdown + env var
5. saved-places priority in SearchBar
6. wire callsites + facade in `geocoding.ts` + tests

## Verification

- `bun test` — all green incl. new tests
- `bunx tsc --noEmit` — clean
- `bunx wrangler dev --port 8789` — manual smoke:
    - Nominatim: search "Dresdener" with Home saved → Home first
    - Switch dropdown to Google (with key) → typo handling improves

## Notes

- Bryan's existing `VITE_GOOGLE_MAPS_KEY` is added by the map-engine
  PR; this PR reuses the same key. Bryan must enable **Places API**
  + **Geocoding API** in the same Google Cloud project so the key
  works for all three.
- The Worker `/api/nominatim/*` proxy stays — it's the Nominatim
  backend.
