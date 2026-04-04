import { useState, useEffect, useRef, useCallback } from 'react'
import { Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { fetchBikeInfraForTile, getVisibleTiles, isTileCached, getCachedTile, tileKey, classifyOsmTagsToItem } from '../services/overpass'
import { PREFERRED_COLOR, OTHER_COLOR } from '../utils/classify'
import type { OsmWay } from '../utils/types'

// Max tiles allowed in viewport. Beyond this the map is too zoomed out to be
// useful — show the "zoom in" prompt instead of firing many parallel requests.
const MAX_VISIBLE_TILES = 12

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

// itemName is computed from raw OSM tags at render time using the current profileKey.
// This keeps the Overpass tile cache profile-independent: mode switching rerenders
// instantly without any re-fetch.
function OverlayLines({ ways, profileKey, preferredItemNames, showOtherPaths }: {
  ways: OsmWay[]
  profileKey: string
  preferredItemNames: Set<string>
  showOtherPaths: boolean
}) {
  return (
    <>
      {ways.map((way) => {
        const itemName = classifyOsmTagsToItem(way.tags, profileKey)
        if (!showOtherPaths && (itemName === null || !preferredItemNames.has(itemName))) return null
        const isPreferred = itemName !== null && preferredItemNames.has(itemName)
        const color = isPreferred ? PREFERRED_COLOR : OTHER_COLOR
        const debugTags = getDebugTags(way.tags)
        return (
          <Polyline
            key={way.osmId}
            positions={way.coordinates}
            color={color}
            weight={5}
            opacity={0.7}
          >
            <Tooltip sticky direction="top" offset={[0, -4]}>
              <div style={{ fontSize: 12, lineHeight: '1.5', maxWidth: 240 }}>
                <div style={{ fontWeight: 700 }}>
                  {itemName ?? 'Unknown'}{way.tags.name ? ` — ${way.tags.name}` : ''}
                </div>
                {debugTags && (
                  <div style={{ color: '#6b7280', fontSize: 11, marginTop: 1 }}>
                    {debugTags}
                  </div>
                )}
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
  preferredItemNames: Set<string>
  showOtherPaths: boolean
  onStatusChange: (status: string) => void
}

function OverlayController({ enabled, profileKey, preferredItemNames, showOtherPaths, onStatusChange }: ControllerProps) {
  const map = useMap()

  // Per-tile way data. Tiles accumulate as the user pans — previously loaded
  // tiles remain visible so there's no blank-then-reload on pan/zoom.
  // Keys are profile-independent tile keys (row:col).
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
      const k = tileKey(t.row, t.col)
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
      loadingTilesRef.current.add(tileKey(t.row, t.col))
    }

    let anyError = false

    await Promise.all(toLoad.map(async (t) => {
      const k = tileKey(t.row, t.col)
      try {
        const ways = await fetchBikeInfraForTile(t.row, t.col)
        if (generationRef.current !== generation) return  // reset happened — discard
        loadedTilesRef.current.add(k)
        setTileData((prev) => {
          const next = new Map(prev)
          next.set(k, ways)
          return next
        })
      } catch (err) {
        console.warn(`[BikeMapOverlay] Tile ${t.row}:${t.col} failed:`, err)
        anyError = true
      } finally {
        loadingTilesRef.current.delete(k)
      }
    }))

    if (generationRef.current !== generation) return

    // Only report error if we have no data at all for the visible area.
    const hasAnyVisibleData = tiles.some((t) =>
      loadedTilesRef.current.has(tileKey(t.row, t.col)) ||
      isTileCached(t.row, t.col)
    )
    if (anyError && !hasAnyVisibleData) {
      onStatusChange('error')
    } else {
      onStatusChange('ok')
    }
  }, [enabled, map, onStatusChange])

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
      // Reset tile tracking only when the overlay is enabled (not on profile change).
      // Tile data is profile-independent — mode switching just rerenders with new itemNames.
      generationRef.current++
      loadingTilesRef.current = new Set()
      loadedTilesRef.current = new Set()

      // Pre-populate tileData from the in-memory Overpass cache for instant display.
      const bounds = map.getBounds()
      const tiles = getVisibleTiles(bounds)
      const preloaded = new Map<string, OsmWay[]>()
      for (const t of tiles) {
        const cached = getCachedTile(t.row, t.col)
        if (cached) {
          const k = tileKey(t.row, t.col)
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
  }, [enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  const allWays: OsmWay[] = []
  for (const ways of tileData.values()) {
    for (const w of ways) allWays.push(w)
  }

  if (!enabled || allWays.length === 0) return null
  return <OverlayLines ways={allWays} profileKey={profileKey} preferredItemNames={preferredItemNames} showOtherPaths={showOtherPaths} />
}

interface Props {
  enabled: boolean
  profileKey: string
  preferredItemNames: Set<string>
  showOtherPaths: boolean
  onStatusChange: (status: string) => void
}

export default function BikeMapOverlay({ enabled, profileKey, preferredItemNames, showOtherPaths, onStatusChange }: Props) {
  return <OverlayController enabled={enabled} profileKey={profileKey} preferredItemNames={preferredItemNames} showOtherPaths={showOtherPaths} onStatusChange={onStatusChange} />
}
