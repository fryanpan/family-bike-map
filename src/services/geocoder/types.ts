// Geocoder engine abstraction shared across Nominatim and Google Places.
//
// The interface decomposes location search into three steps:
//
//   autocomplete  — given a query (and optional bias point), return a
//                   short list of candidate Places. Some engines
//                   (Nominatim) already have lat/lng inline; others
//                   (Google) only have an opaque place_id and require a
//                   second call to resolve full coords. The result type
//                   carries optional lat/lng so consumers can short-
//                   circuit when present.
//
//   placeDetails  — resolve an AutocompleteResult to a full Place
//                   (label, shortLabel, lat, lng). For engines that
//                   already have lat/lng inline, this is a passthrough.
//
//   reverseGeocode— given lat/lng, return a label + shortLabel. Used
//                   by "use my current location" flows.
//
// Pattern mirrors the map-engine abstraction (src/services/mapEngine):
// resolve.ts picks the active engine based on adminSettings.geocoderEngine
// and falls back when an API key is missing.

import type { Place } from '../../utils/types'

export type GeocoderEngineKind = 'nominatim' | 'google'

export interface AutocompleteResult {
  /** Engine-specific identifier — place_id for Google, "lat,lng" key
   *  for Nominatim. Used as React key + dedup signal. */
  id: string
  /** Full label (e.g. "Dresdener Straße 112, Kreuzberg, Berlin, ..."). */
  label: string
  /** Short label for the suggestion line (e.g. "Dresdener Straße 112"). */
  shortLabel: string
  /** When present, placeDetails() is a no-op and the UI can use these
   *  coords directly. Engines that resolve coords lazily (Google) omit
   *  this and require a placeDetails round-trip. */
  lat?: number
  lng?: number
  /** Optional UI prefix — e.g. '🏠' for a saved-place pin. The
   *  search-bar uses this to mark Home/School results that were
   *  prepended ahead of the engine output. */
  iconPrefix?: string
}

export interface GeocoderEngine {
  readonly kind: GeocoderEngineKind

  /**
   * Return a small list of candidate places matching the query.
   * @param query  free-text query (typically the search input value).
   *               Engines may treat very short queries (< 2 chars) as
   *               "no results" rather than firing a request.
   * @param bias   optional lat/lng to softly prefer nearby results
   *               (e.g. the user's current location). Engines without
   *               native bias support may approximate or ignore.
   */
  autocomplete(query: string, bias?: { lat: number; lng: number }): Promise<AutocompleteResult[]>

  /**
   * Resolve an autocomplete suggestion to a full Place. Engines that
   * already returned lat/lng from autocomplete return immediately; the
   * Google engine fetches Place Details here.
   * Returns null if the engine cannot resolve the place (e.g. expired
   * place_id, network error).
   */
  placeDetails(result: AutocompleteResult): Promise<Place | null>

  /**
   * Reverse geocode lat/lng to a place name.
   * Returns null if unavailable.
   */
  reverseGeocode(lat: number, lng: number): Promise<Pick<Place, 'label' | 'shortLabel'> | null>
}
