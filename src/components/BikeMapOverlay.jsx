/**
 * BikeMapOverlay — shows bike infrastructure for the visible map area,
 * colored by safety category, fetched live from Overpass API.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { fetchBikeInfra } from '../services/overpass.js'
import { SAFETY } from '../utils/classify.js'

function OverlayLines({ ways }) {
  return (
    <>
      {ways.map((way) => {
        const s = SAFETY[way.safetyClass] ?? SAFETY.acceptable
        return (
          <Polyline
            key={way.osmId}
            positions={way.coordinates}
            color={s.color}
            weight={4}
            opacity={0.75}
          >
            <Tooltip sticky direction="top" offset={[0, -4]}>
              <span style={{ fontSize: 13 }}>
                {s.icon} {s.label}
                {way.tags.name ? ` — ${way.tags.name}` : ''}
              </span>
            </Tooltip>
          </Polyline>
        )
      })}
    </>
  )
}

function OverlayController({ enabled, onStatusChange }) {
  const map = useMap()
  const [ways, setWays] = useState([])
  const debounceRef = useRef(null)

  const load = useCallback(async () => {
    if (!enabled) return
    onStatusChange('loading')
    try {
      const result = await fetchBikeInfra(map.getBounds())
      if (result === null) {
        onStatusChange('zoom') // area too large
        setWays([])
      } else {
        setWays(result)
        onStatusChange('ok')
      }
    } catch {
      onStatusChange('error')
    }
  }, [enabled, map, onStatusChange])

  // Load on mount and whenever the map view changes
  useMapEvents({
    moveend() {
      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(load, 600)
    },
    zoomend() {
      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(load, 600)
    },
  })

  useEffect(() => {
    if (enabled) {
      load()
    } else {
      setWays([])
      onStatusChange('idle')
    }
    return () => clearTimeout(debounceRef.current)
  }, [enabled])  // eslint-disable-line react-hooks/exhaustive-deps

  if (!enabled || !ways.length) return null
  return <OverlayLines ways={ways} />
}

export default function BikeMapOverlay({ enabled, onStatusChange }) {
  return <OverlayController enabled={enabled} onStatusChange={onStatusChange} />
}
