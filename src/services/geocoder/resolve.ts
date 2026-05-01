// Geocoder resolution — given a user-selected engine kind and the
// build-time API keys available, pick the engine to actually use.
// Falls back to Nominatim (always available, no key required) when
// the user picked Google but VITE_GOOGLE_MAPS_KEY is missing.
//
// Mirrors the map-engine resolve.ts pattern. We construct the engine
// lazily (and once per choice) so the Google SDK isn't loaded until a
// caller actually issues a search.

import { GoogleGeocoder } from './GoogleGeocoder'
import { NominatimGeocoder } from './NominatimGeocoder'
import type { GeocoderEngine, GeocoderEngineKind } from './types'
import { loadSettings, useAdminSettings } from '../adminSettings'

export interface GeocoderEnv {
  googleMapsKey?: string
}

export interface ResolvedGeocoder {
  kind: GeocoderEngineKind
  engine: GeocoderEngine
  fellBack: boolean
  fallbackReason?: string
}

export function readEnvKeys(): GeocoderEnv {
  // Vite only injects `import.meta.env` into modules that reference it
  // *directly* — going through a `meta` variable defeats detection and
  // leaves the keys empty at runtime. Read each VITE_* var on its own
  // line so Vite's static analysis catches it.
  return {
    googleMapsKey: import.meta.env?.VITE_GOOGLE_MAPS_KEY || undefined,
  }
}

// ── Cached instances ──────────────────────────────────────────────────────
//
// Engines are stateful (Google's SDK bootstrap, the Nominatim
// adapter holds nothing). We keep one instance per kind and hand it
// out from useActiveGeocoder so callers don't reload the SDK on every
// render.

let nominatimInstance: NominatimGeocoder | null = null
let googleInstance: GoogleGeocoder | null = null

function getNominatim(): NominatimGeocoder {
  if (!nominatimInstance) nominatimInstance = new NominatimGeocoder()
  return nominatimInstance
}

function getGoogle(apiKey: string): GoogleGeocoder {
  if (!googleInstance) googleInstance = new GoogleGeocoder(apiKey)
  return googleInstance
}

/**
 * Pure resolver — given a requested kind and an env, decide which
 * engine to use and whether we fell back. Used directly by tests and
 * by the React hook below.
 */
export function resolveGeocoder(
  requested: GeocoderEngineKind,
  env: GeocoderEnv,
): ResolvedGeocoder {
  if (requested === 'google') {
    if (!env.googleMapsKey) {
      console.warn(
        '[geocoder] VITE_GOOGLE_MAPS_KEY is missing — falling back to Nominatim. ' +
          'Add the key to .env.local (and to Deploy secrets for prod) to enable Google search.',
      )
      return {
        kind: 'nominatim',
        engine: getNominatim(),
        fellBack: true,
        fallbackReason: 'VITE_GOOGLE_MAPS_KEY missing',
      }
    }
    return { kind: 'google', engine: getGoogle(env.googleMapsKey), fellBack: false }
  }

  return { kind: 'nominatim', engine: getNominatim(), fellBack: false }
}

/**
 * Resolve the active geocoder based on the current admin settings.
 * Non-React callers can use this; the hook below wraps it for
 * components that need to re-resolve when the user flips the
 * dropdown.
 */
export function getActiveGeocoder(): GeocoderEngine {
  // Non-React callers (e.g. App.tsx's resolveCurrentLocation) use
  // this. We read straight from localStorage via loadSettings so we
  // don't couple them to React's render cycle.
  const settings = loadSettings()
  return resolveGeocoder(settings.geocoderEngine, readEnvKeys()).engine
}

/**
 * React hook — returns the active geocoder + whether it fell back.
 * Re-runs when the user changes `adminSettings.geocoderEngine`.
 */
export function useActiveGeocoder(): ResolvedGeocoder {
  const settings = useAdminSettings()
  return resolveGeocoder(settings.geocoderEngine, readEnvKeys())
}

// ── Test seam ─────────────────────────────────────────────────────────────
/** Reset cached engine instances. Tests use this to start clean. */
export function __resetGeocoderCacheForTests(): void {
  nominatimInstance = null
  googleInstance = null
}
