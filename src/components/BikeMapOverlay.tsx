import { useState, useEffect, useRef, useCallback } from 'react'
import { Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { fetchBikeInfraForTile, getVisibleTiles, isTileCached, getCachedTile, tileKey } from '../services/overpass'
import { SAFETY, SAFETY_LEVEL } from '../utils/classify'
import type { LegendLevel } from '../utils/classify'
import type { OsmWay } from '../utils/types'

// Max tiles allowed in viewport. Beyond this the map is too zoomed out to be
// useful — show the "zoom in" prompt instead of firing many parallel requests.
const MAX_VISIBLE_TILES = 12

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
        const s = SAFETY[way.safetyClass] ?? SAFETY.bad
        const pathType = getPathTypeName(way.tags)
        const debugTags = getDebugTags(way.tags)
        return (
          <Polyline
            key={way.osmId}
            positions={way.coordinates}
            color={s.color}
            weight={5}
            opacity={0.7}
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

  // Per-tile way data. Tiles accumulate as the user pans — previously loaded
  // tiles remain visible so there's no blank-then-reload on pan/zoom.
  const [tileData, setTileData] = useState<Map<string, OsmWay[]>>(new Map())

  // Track which tiles are currently being fetched (avoids duplicate requests).
  const loadingTilesRef = useRef<Set<string>>(new Set())
  // Track which tiles have been successfully loaded (avoids re-fetching).
  const loadedTilesRef  = useRef<Set<string>>(new Set())
  // Generation counter — incremented on reset so stale callbacks don't write.
  const generationRef   = useRef(0)

  const loadVisibleTiles = useCallback(async () => {
    if (!enabled) return

    const bounds = map.getBounds()
    const tiles = getVisibleTiles(bounds)

    // Too zoomed out — would require too many requests.
    if (tiles.length > MAX_VISIBLE_TILES) {
      onStatusChange('zoom')
      return
    }

    // Determine which tiles still need fetching.
    const toLoad = tiles.filter((t) => {
      const k = tileKey(t.row, t.col, profileKey)
      return !loadedTilesRef.current.has(k) && !loadingTilesRef.current.has(k)
    })

    if (toLoad.length === 0) {
      onStatusChange('ok')
      return
    }

    onStatusChange('loading')
    const generation = generationRef.current

    // Mark all as in-flight before launching requests (prevents double-fetch).
    for (const t of toLoad) {
      loadingTilesRef.current.add(tileKey(t.row, t.col, profileKey))
    }

    let anyError = false

    await Promise.all(toLoad.map(async (t) => {
      const k = tileKey(t.row, t.col, profileKey)
      try {
        const ways = await fetchBikeInfraForTile(t.row, t.col, profileKey)
        if (generationRef.current !== generation) return  // reset happened — discard
        loadedTilesRef.current.add(k)
        setTileData((prev) => {
          const next = new Map(prev)
          next.set(k, ways)
          return next
        })
      } catch {
        anyError = true
      } finally {
        loadingTilesRef.current.delete(k)
      }
    }))

    if (generationRef.current !== generation) return

    // Only report error if we have no data at all for the visible area.
    const hasAnyVisibleData = tiles.some((t) =>
      loadedTilesRef.current.has(tileKey(t.row, t.col, profileKey)) ||
      isTileCached(t.row, t.col, profileKey)
    )
    if (anyError && !hasAnyVisibleData) {
      onStatusChange('error')
    } else {
      onStatusChange('ok')
    }
  }, [enabled, profileKey, map, onStatusChange])

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useMapEvents({
    moveend() {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(loadVisibleTiles, 400)
    },
    zoomend() {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(loadVisibleTiles, 400)
    },
  })

  useEffect(() => {
    if (enabled) {
      // Reset tile tracking when profile changes or overlay is re-enabled.
      // Cached tile data in overpass.ts is still valid — only reset in-memory
      // tracking so we re-populate tileData for the current viewport.
      generationRef.current++
      loadingTilesRef.current = new Set()
      loadedTilesRef.current = new Set()

      // Pre-populate tileData from the in-memory Overpass cache for instant display.
      const bounds = map.getBounds()
      const tiles = getVisibleTiles(bounds)
      const preloaded = new Map<string, OsmWay[]>()
      for (const t of tiles) {
        const cached = getCachedTile(t.row, t.col, profileKey)
        if (cached) {
          const k = tileKey(t.row, t.col, profileKey)
          preloaded.set(k, cached)
          loadedTilesRef.current.add(k)
        }
      }
      setTileData(preloaded)

      loadVisibleTiles()
    } else {
      generationRef.current++
      loadingTilesRef.current = new Set()
      loadedTilesRef.current = new Set()
      setTileData(new Map())
      onStatusChange('idle')
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [enabled, profileKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const allWays: OsmWay[] = []
  for (const ways of tileData.values()) {
    for (const w of ways) allWays.push(w)
  }

  if (!enabled || allWays.length === 0) return null
  return <OverlayLines ways={allWays} hiddenLevels={hiddenLevels} />
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
