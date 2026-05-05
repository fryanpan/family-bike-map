/// <reference types="vite/client" />
/// <reference types="google.maps" />

interface ImportMetaEnv {
  readonly VITE_SENTRY_DSN?: string
  readonly VITE_USERBACK_TOKEN?: string
  /** Google Maps JS API key — used by the Google geocoder adapter
   *  (and, in a stacked branch, by the Google map-engine adapter).
   *  Restrict in Google Cloud Console to: Maps JS API + Places API +
   *  Geocoding API. Bundled at build time. */
  readonly VITE_GOOGLE_MAPS_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
