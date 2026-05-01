// Engine resolution — given a user-selected engine kind and the env
// keys available at build time, pick the engine to actually use. Falls
// back to leaflet-osm (always available) when a key is missing for the
// chosen engine.
//
// Build-time env reading: all VITE_* vars are baked into the bundle by
// Vite. We read them once at module import. Tests pass them via the
// `env` argument so behavior is deterministic.

import type { MapEngineKind, BaseStyle } from './types'

export interface EngineEnv {
  maptilerKey?: string
  googleMapsKey?: string
}

export interface ResolvedEngine {
  kind: MapEngineKind
  baseStyle: BaseStyle
  /** True when the user picked a different engine but a missing key
   *  forced a fallback. Consumers can surface this in admin UI. */
  fellBack: boolean
  fallbackReason?: string
}

export function readEnvKeys(): EngineEnv {
  // Vite only injects `import.meta.env` into modules that reference it
  // *directly* — assigning `const meta = import.meta` first defeats the
  // static-analysis pass and leaves env undefined at runtime, so we have
  // to read each var on its own line.
  return {
    maptilerKey: import.meta.env?.VITE_MAPTILER_KEY || undefined,
    googleMapsKey: import.meta.env?.VITE_GOOGLE_MAPS_KEY || undefined,
  }
}

export function resolveEngine(requested: MapEngineKind, env: EngineEnv): ResolvedEngine {
  if (requested === 'leaflet-maptiler') {
    if (!env.maptilerKey) {
      console.warn(
        '[mapEngine] VITE_MAPTILER_KEY is missing — falling back to leaflet-osm. ' +
        'Add the key to .env.local (and to GitHub Actions Deploy secrets for prod).',
      )
      return {
        kind: 'leaflet-osm',
        baseStyle: 'osm-carto',
        fellBack: true,
        fallbackReason: 'VITE_MAPTILER_KEY missing',
      }
    }
    return { kind: 'leaflet-maptiler', baseStyle: 'maptiler-streets-light', fellBack: false }
  }

  if (requested === 'google-maps') {
    if (!env.googleMapsKey) {
      console.warn(
        '[mapEngine] VITE_GOOGLE_MAPS_KEY is missing — falling back to leaflet-osm. ' +
        'Add the key to .env.local (and to GitHub Actions Deploy secrets for prod).',
      )
      return {
        kind: 'leaflet-osm',
        baseStyle: 'osm-carto',
        fellBack: true,
        fallbackReason: 'VITE_GOOGLE_MAPS_KEY missing',
      }
    }
    return { kind: 'google-maps', baseStyle: 'google-default', fellBack: false }
  }

  return { kind: 'leaflet-osm', baseStyle: 'osm-carto', fellBack: false }
}
