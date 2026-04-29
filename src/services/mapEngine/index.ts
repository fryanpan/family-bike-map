// Public surface of the map-engine package. Consumers import:
//   - createEngine(kind) — returns the right adapter instance
//   - useMapEngine(...)  — React hook that mounts/unmounts an engine
//   - resolveEngine, readEnvKeys — for the admin UI
//   - All types (LatLng, MapEngine, etc.)

import { LeafletEngine } from './LeafletEngine'
import { GoogleMapsEngine } from './GoogleMapsEngine'
import type { MapEngine, MapEngineKind } from './types'

export * from './types'
export { resolveEngine, readEnvKeys } from './resolve'
export type { ResolvedEngine, EngineEnv } from './resolve'

/** Build a fresh engine instance for the given kind. The returned
 *  engine is unmounted — call mount() yourself. */
export function createEngine(kind: MapEngineKind): MapEngine {
  switch (kind) {
    case 'google-maps':
      return new GoogleMapsEngine()
    case 'leaflet-osm':
    case 'leaflet-maptiler':
      return new LeafletEngine()
  }
}
