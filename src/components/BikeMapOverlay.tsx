import { useState, useEffect, useRef, useCallback } from 'react'
import { Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { fetchBikeInfra } from '../services/overpass'
import { SAFETY, SAFETY_LEVEL } from '../utils/classify'
import type { LegendLevel } from '../utils/classify'
import type { OsmWay } from '../utils/types'
import type { LatLngBounds } from 'leaflet'

/** Derive a human-readable path type name from raw OSM tags. */
function getPathTypeName(tags: Record<string, string>): string {
  const highway = tags.highway ?? ''
  const cycleway = tags.cycleway ?? ''
  const bicycleRoad = tags.bicycle_road === 'yes'

  if (bicycleRoad) return 'Fahrradstrasse'
  if (highway === 'cycleway') return 'Cycleway'
  if (highway === 'path') return 'Path'
  if (highway === 'footway') return 'Shared footway'
  if (highway === 'track') return 'Track'
  if (highway === 'living_street') return 'Living street'
  if (highway === 'residential') return 'Residential road'
  if (cycleway === 'track' || cycleway === 'opposite_track') return 'Separated bike track'
  if (cycleway === 'lane' || cycleway === 'opposite_lane') return 'Painted bike lane'
  if (cycleway === 'share_busway') return 'Shared bus lane'

  const cRight = tags['cycleway:right'] ?? ''
  const cLeft  = tags['cycleway:left']  ?? ''
  const cBoth  = tags['cycleway:both']  ?? ''
  if (cRight === 'track' || cLeft === 'track' || cBoth === 'track') return 'Separated bike track (side)'
  if (cRight === 'lane'  || cLeft === 'lane'  || cBoth === 'lane')  return 'Painted bike lane (side)'

  return highway ? `Road (${highway})` : 'Unknown'
}

/** Build a compact debug string of the OSM tags relevant to classification. */
function getDebugTags(tags: Record<string, string>): string {
  const parts: string[] = []
  if (tags.highway)                   parts.push(`highway=${tags.highway}`)
  if (tags.bicycle_road === 'yes')    parts.push('bicycle_road=yes')
  if (tags.cycleway)                  parts.push(`cycleway=${tags.cycleway}`)
  if (tags['cycleway:right'])         parts.push(`cycleway:right=${tags['cycleway:right']}`)
  if (tags['cycleway:left'])          parts.push(`cycleway:left=${tags['cycleway:left']}`)
  if (tags['cycleway:both'])          parts.push(`cycleway:both=${tags['cycleway:both']}`)
  if (tags['cycleway:separation'])    parts.push(`separation=${tags['cycleway:separation']}`)
  if (tags['cycleway:right:separation']) parts.push(`separation=${tags['cycleway:right:separation']}`)
  if (tags['cycleway:buffer'])        parts.push('buffer=yes')
  if (tags.surface)                   parts.push(`surface=${tags.surface}`)
  return parts.join(' · ')
}

function OverlayLines({ ways, hiddenLevels }: { ways: OsmWay[]; hiddenLevels: Set<LegendLevel> }) {
  const visible = ways.filter((w) => !hiddenLevels.has(SAFETY_LEVEL[w.safetyClass]))
  return (
    <>
      {visible.map((way) => {
        const s = SAFETY[way.safetyClass] ?? SAFETY.avoid
        const pathType = getPathTypeName(way.tags)
        const debugTags = getDebugTags(way.tags)
        return (
          <Polyline
            key={way.osmId}
            positions={way.coordinates}
            color={s.color}
            weight={3}
            opacity={0.6}
          >
            <Tooltip sticky direction="top" offset={[0, -4]}>
              <div style={{ fontSize: 12, lineHeight: '1.5', maxWidth: 240 }}>
                <div style={{ fontWeight: 700 }}>
                  {pathType}{way.tags.name ? ` — ${way.tags.name}` : ''}
                </div>
                {debugTags && (
                  <div style={{ color: '#6b7280', fontSize: 11, marginTop: 1 }}>
                    {debugTags}
                  </div>
                )}
                <div style={{ marginTop: 2 }}>{s.icon} {s.label}</div>
              </div>
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
  hiddenLevels: Set<LegendLevel>
  onStatusChange: (status: string) => void
}

function OverlayController({ enabled, profileKey, hiddenLevels, onStatusChange }: ControllerProps) {
  const map = useMap()
  const [ways, setWays] = useState<OsmWay[]>([])
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Generation counter prevents stale loads from updating state after newer loads start
  const loadIdRef = useRef(0)

  const load = useCallback(async () => {
    if (!enabled) return
    const id = ++loadIdRef.current
    onStatusChange('loading')
    try {
      const result = await fetchBikeInfra(map.getBounds() as LatLngBounds, profileKey)
      if (id !== loadIdRef.current) return  // stale — a newer load already started
      if (result === null) {
        onStatusChange('zoom')
      } else {
        setWays(result)
        onStatusChange('ok')
      }
    } catch {
      if (id !== loadIdRef.current) return
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
      loadIdRef.current++  // invalidate any in-flight load
      setWays([])
      onStatusChange('idle')
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [enabled, profileKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!enabled || !ways.length) return null
  return <OverlayLines ways={ways} hiddenLevels={hiddenLevels} />
}

interface Props {
  enabled: boolean
  profileKey: string
  hiddenLevels: Set<LegendLevel>
  onStatusChange: (status: string) => void
}

export default function BikeMapOverlay({ enabled, profileKey, hiddenLevels, onStatusChange }: Props) {
  return <OverlayController enabled={enabled} profileKey={profileKey} hiddenLevels={hiddenLevels} onStatusChange={onStatusChange} />
}
