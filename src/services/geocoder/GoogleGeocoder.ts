// Google Places adapter for the GeocoderEngine interface.
//
// Three Google APIs are used:
//   - places.AutocompleteService.getPlacePredictions for the typing
//     experience. Cheap and intended to be called per keystroke;
//     billed cheaply when used with a session token.
//   - places.PlacesService.getDetails to resolve a place_id to a
//     full place (label + lat/lng). Billed once per session token at
//     the higher Place Details rate, so we only call it on tap.
//   - Geocoder.geocode (with location) for reverse geocoding.
//
// SDK bootstrap mirrors GoogleMapsEngine — we reuse setOptions +
// importLibrary from @googlemaps/js-api-loader. Loading is shared
// across mapEngine + geocoder via the cached promise (the SDK is a
// singleton on `window.google`); calling setOptions twice with the
// same key is a no-op.
//
// Session token: Google bills Autocomplete + Place Details together
// when both calls share an AutocompleteSessionToken. We mint a fresh
// token on every successful Place Details fetch (token is consumed
// once a Place Details call resolves, per Google's billing model).

import type { Place } from '../../utils/types'
import type { AutocompleteResult, GeocoderEngine } from './types'

let googleMapsPromise: Promise<typeof google.maps> | null = null

async function loadGoogleMaps(apiKey: string): Promise<typeof google.maps> {
  if (googleMapsPromise) return googleMapsPromise
  googleMapsPromise = (async () => {
    const { setOptions, importLibrary } = await import('@googlemaps/js-api-loader')
    setOptions({ key: apiKey, v: 'weekly' })
    // Both libraries share the singleton namespace; importing here
    // primes them for AutocompleteService / PlacesService / Geocoder.
    await importLibrary('places')
    await importLibrary('geocoding')
    return google.maps
  })()
  return googleMapsPromise
}

/**
 * Pull the Google Maps API key from the Vite build env. Returns
 * undefined when the key isn't bundled (the resolver should have
 * fallen back to Nominatim before constructing this engine, so this
 * is mostly a defensive check).
 */
function readGoogleKey(): string | undefined {
  const meta = import.meta as ImportMeta & { env?: Record<string, string | undefined> }
  return meta.env?.VITE_GOOGLE_MAPS_KEY || undefined
}

/**
 * Pretty short-label for a Google place: when the prediction's main
 * text is the road only, append the user-typed query's house number
 * if Google included one in `terms`. In practice, Google's
 * `structured_formatting.main_text` is already the best short label
 * (e.g. "Dresdener Straße 112"), so we use it directly.
 */
function shortLabelFor(p: google.maps.places.AutocompletePrediction): string {
  return p.structured_formatting?.main_text || p.description.split(',')[0]
}

export class GoogleGeocoder implements GeocoderEngine {
  readonly kind = 'google' as const

  private apiKey: string

  // Lazily constructed once the SDK loads. We reuse the same
  // PlacesService DOM attribution element so we don't pollute the
  // body with one per call.
  private autocompleteService: google.maps.places.AutocompleteService | null = null
  private placesService: google.maps.places.PlacesService | null = null
  private geocoder: google.maps.Geocoder | null = null
  private sessionToken: google.maps.places.AutocompleteSessionToken | null = null

  constructor(apiKey?: string) {
    const key = apiKey ?? readGoogleKey()
    if (!key) {
      throw new Error('GoogleGeocoder requires VITE_GOOGLE_MAPS_KEY to be set at build time')
    }
    this.apiKey = key
  }

  private async ensureLoaded(): Promise<void> {
    await loadGoogleMaps(this.apiKey)
    if (!this.autocompleteService) {
      this.autocompleteService = new google.maps.places.AutocompleteService()
    }
    if (!this.placesService) {
      // PlacesService needs a DOM node for attribution rendering.
      // A detached div is fine — Google renders nothing visible into
      // it for the calls we make.
      const attrEl = document.createElement('div')
      this.placesService = new google.maps.places.PlacesService(attrEl)
    }
    if (!this.geocoder) {
      this.geocoder = new google.maps.Geocoder()
    }
    if (!this.sessionToken) {
      this.sessionToken = new google.maps.places.AutocompleteSessionToken()
    }
  }

  async autocomplete(query: string, bias?: { lat: number; lng: number }): Promise<AutocompleteResult[]> {
    if (!query || query.length < 2) return []
    await this.ensureLoaded()
    const service = this.autocompleteService!
    const sessionToken = this.sessionToken!

    const request: google.maps.places.AutocompletionRequest = {
      input: query,
      sessionToken,
    }
    if (bias) {
      // Soft bias only — `location` + `radius` without `strictBounds`
      // means Google prefers nearby results but still returns global
      // hits. 50 km matches a "city neighbourhood" feel.
      request.location = new google.maps.LatLng(bias.lat, bias.lng)
      request.radius = 50_000
    }

    return new Promise((resolve) => {
      service.getPlacePredictions(request, (predictions, status) => {
        if (
          status !== google.maps.places.PlacesServiceStatus.OK ||
          !predictions
        ) {
          resolve([])
          return
        }
        resolve(
          predictions.map((p) => ({
            id: p.place_id,
            label: p.description,
            shortLabel: shortLabelFor(p),
            // lat/lng intentionally omitted — Google requires a
            // Place Details call to resolve coordinates.
          })),
        )
      })
    })
  }

  async placeDetails(result: AutocompleteResult): Promise<Place | null> {
    // If lat/lng are already on the result (e.g. the saved-places
    // path injected them), short-circuit. Real Google predictions
    // arrive without coords.
    if (typeof result.lat === 'number' && typeof result.lng === 'number') {
      return {
        label: result.label,
        shortLabel: result.shortLabel,
        lat: result.lat,
        lng: result.lng,
      }
    }

    await this.ensureLoaded()
    const service = this.placesService!
    const sessionToken = this.sessionToken!

    return new Promise((resolve) => {
      service.getDetails(
        {
          placeId: result.id,
          fields: ['geometry', 'formatted_address', 'name'],
          sessionToken,
        },
        (place, status) => {
          // Mint a fresh session token regardless of outcome — the
          // current token is "spent" once getDetails returns.
          this.sessionToken = new google.maps.places.AutocompleteSessionToken()

          if (
            status !== google.maps.places.PlacesServiceStatus.OK ||
            !place ||
            !place.geometry?.location
          ) {
            resolve(null)
            return
          }
          const lat = place.geometry.location.lat()
          const lng = place.geometry.location.lng()
          const label = place.formatted_address || result.label
          const shortLabel = result.shortLabel || place.name || label.split(',')[0]
          resolve({ label, shortLabel, lat, lng })
        },
      )
    })
  }

  async reverseGeocode(lat: number, lng: number): Promise<Pick<Place, 'label' | 'shortLabel'> | null> {
    await this.ensureLoaded()
    const geocoder = this.geocoder!
    return new Promise((resolve) => {
      geocoder.geocode({ location: { lat, lng } }, (results, status) => {
        if (status !== google.maps.GeocoderStatus.OK || !results || results.length === 0) {
          resolve(null)
          return
        }
        const top = results[0]
        const label = top.formatted_address
        // Google doesn't give us a "short name" the way Nominatim does
        // for reverse geocodes. The first address component (street
        // number + route) is the closest match.
        const shortLabel = label.split(',')[0]
        resolve({ label, shortLabel })
      })
    })
  }
}
