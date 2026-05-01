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

/**
 * Concrete styles each engine accepts. The admin settings store a
 * single `mapStyle` string that's free to be any BaseStyle; resolveEngine
 * clamps it to a style the chosen engine actually supports (and to the
 * fallback engine's default when a key is missing).
 */
export const ENGINE_STYLES: Record<MapEngineKind, BaseStyle[]> = {
  'leaflet-osm':      ['osm-carto', 'cartocdn-voyager', 'cartocdn-positron'],
  'leaflet-maptiler': [
    'maptiler-streets-light', 'maptiler-streets', 'maptiler-streets-dark',
    'maptiler-outdoor', 'maptiler-satellite',
  ],
  'google-maps':      ['google-roadmap', 'google-satellite', 'google-hybrid', 'google-terrain'],
}

const DEFAULT_STYLE: Record<MapEngineKind, BaseStyle> = {
  'leaflet-osm':      'osm-carto',
  'leaflet-maptiler': 'maptiler-streets-light',
  'google-maps':      'google-roadmap',
}

/** Human-friendly labels for the admin dropdown. */
export const STYLE_LABELS: Record<BaseStyle, string> = {
  'osm-carto':                'OSM Carto (default)',
  'cartocdn-voyager':         'CARTO Voyager',
  'cartocdn-positron':        'CARTO Positron',
  'maptiler-streets-light':   'MapTiler Streets light',
  'maptiler-streets':         'MapTiler Streets',
  'maptiler-streets-dark':    'MapTiler Streets dark',
  'maptiler-outdoor':         'MapTiler Outdoor',
  'maptiler-satellite':       'MapTiler Satellite',
  'google-roadmap':           'Google Roadmap',
  'google-satellite':         'Google Satellite',
  'google-hybrid':            'Google Hybrid',
  'google-terrain':           'Google Terrain',
}

function clampStyle(engine: MapEngineKind, requested: BaseStyle | undefined): BaseStyle {
  if (requested && ENGINE_STYLES[engine].includes(requested)) return requested
  return DEFAULT_STYLE[engine]
}

export function resolveEngine(
  requested: MapEngineKind,
  env: EngineEnv,
  requestedStyle?: BaseStyle,
): ResolvedEngine {
  if (requested === 'leaflet-maptiler') {
    if (!env.maptilerKey) {
      console.warn(
        '[mapEngine] VITE_MAPTILER_KEY is missing — falling back to leaflet-osm. ' +
        'Add the key to .env.local (and to GitHub Actions Deploy secrets for prod).',
      )
      return {
        kind: 'leaflet-osm',
        baseStyle: clampStyle('leaflet-osm', requestedStyle),
        fellBack: true,
        fallbackReason: 'VITE_MAPTILER_KEY missing',
      }
    }
    return {
      kind: 'leaflet-maptiler',
      baseStyle: clampStyle('leaflet-maptiler', requestedStyle),
      fellBack: false,
    }
  }

  if (requested === 'google-maps') {
    if (!env.googleMapsKey) {
      console.warn(
        '[mapEngine] VITE_GOOGLE_MAPS_KEY is missing — falling back to leaflet-osm. ' +
        'Add the key to .env.local (and to GitHub Actions Deploy secrets for prod).',
      )
      return {
        kind: 'leaflet-osm',
        baseStyle: clampStyle('leaflet-osm', requestedStyle),
        fellBack: true,
        fallbackReason: 'VITE_GOOGLE_MAPS_KEY missing',
      }
    }
    return {
      kind: 'google-maps',
      baseStyle: clampStyle('google-maps', requestedStyle),
      fellBack: false,
    }
  }

  return {
    kind: 'leaflet-osm',
    baseStyle: clampStyle('leaflet-osm', requestedStyle),
    fellBack: false,
  }
}
