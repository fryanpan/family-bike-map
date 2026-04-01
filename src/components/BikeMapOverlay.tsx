import { useState, useEffect, useRef, useCallback } from 'react'
import { Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { fetchBikeInfra } from '../services/overpass'
import { SAFETY } from '../utils/classify'
import type { OsmWay } from '../utils/types'
import type { LatLngBounds } from 'leaflet'

function OverlayLines({ ways }: { ways: OsmWay[] }) {
  return (
    <>
      {ways.map((way) => {
        const s = SAFETY[way.safetyClass] ?? SAFETY.avoid
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

interface ControllerProps {
  enabled: boolean
  profileKey: string
  onStatusChange: (status: string) => void
}

function OverlayController({ enabled, profileKey, onStatusChange }: ControllerProps) {
  const map = useMap()
  const [ways, setWays] = useState<OsmWay[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async () => {
    if (!enabled) return
    onStatusChange('loading')
    try {
      const result = await fetchBikeInfra(map.getBounds() as LatLngBounds, profileKey)
      if (result === null) {
        // Area too large — keep existing ways visible, just show hint to zoom in
        onStatusChange('zoom')
      } else {
        setWays(result)
        onStatusChange('ok')
      }
    } catch {
      onStatusChange('error')
    }
  }, [enabled, profileKey, map, onStatusChange])

  useMapEvents({
    moveend() {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(load, 600)
    },
    zoomend() {
      if (debounceRef.current) clearTimeout(debounceRef.current)
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
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [enabled, profileKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!enabled || !ways.length) return null
  return <OverlayLines ways={ways} />
}

interface Props {
  enabled: boolean
  profileKey: string
  onStatusChange: (status: string) => void
}

export default function BikeMapOverlay({ enabled, profileKey, onStatusChange }: Props) {
  return <OverlayController enabled={enabled} profileKey={profileKey} onStatusChange={onStatusChange} />
}
