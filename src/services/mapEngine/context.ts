// React context for the active MapEngine instance. Children of the
// <MapRoot> mount tree (e.g. BikeMapOverlay) read the engine via this
// context instead of re-creating one or passing it through props.
//
// The context value is null until the engine has finished mounting
// (Google Maps' SDK bootstrap is async). Consumers must guard for
// null.

import { createContext, useContext } from 'react'
import type { MapEngine } from './types'

export const MapEngineContext = createContext<MapEngine | null>(null)

export function useMapEngine(): MapEngine | null {
  return useContext(MapEngineContext)
}
