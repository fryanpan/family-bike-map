import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { fetchBikeInfraForTile, getVisibleTiles, isTileCached, getCachedTile, tileKey, classifyOsmTagsToItem } from '../services/overpass'
import { PREFERRED_COLOR, OTHER_COLOR } from '../utils/classify'
import { getStreetImage } from '../services/mapillary'
import type { ClassificationRule } from '../services/rules'
import type { OsmWay } from '../utils/types'

// Max tiles allowed in viewport. Beyond this the map is too zoomed out to be
// useful — show the "zoom in" prompt instead of firing many parallel requests.
const MAX_VISIBLE_TILES = 12

// Canvas renderer created once at module level — shared across all polylines.
// Canvas is 5-10x faster than SVG for many lines on mobile.
const canvasRenderer = L.canvas({ padding: 0.5 })

/** Build an array of the OSM tags relevant to classification (one per line). */
function getDebugTags(tags: Record<string, string>): string[] {
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
  return parts
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function buildTooltipHtml(
  itemName: string | null,
  tags: Record<string, string>,
  isPreferred: boolean,
  imageUrl?: string | null,
): string {
  const debugTags = getDebugTags(tags)
  const name = tags.name ? ` — ${escapeHtml(tags.name)}` : ''
  const preferredLabel = isPreferred
    ? `<span style="color:#10b981;font-weight:600">Preferred</span>`
    : `<span style="color:#f97316;font-weight:600">Not preferred</span>`
  const tagsHtml = debugTags
    .map((t) => `<div>${escapeHtml(t)}</div>`)
    .join('')
  const imageHtml = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="Street view" style="width:100%;border-radius:4px;margin-top:6px;display:block" loading="lazy" />`
    : ''
  return `<div style="font-size:12px;line-height:1.5;width:220px">
    <div style="font-weight:700;white-space:normal;word-break:break-word">${itemName ?? 'Unknown'}${name}</div>
    <div style="margin-top:2px">${preferredLabel}</div>
    ${tagsHtml ? `<div style="color:#6b7280;font-size:11px;margin-top:4px">${tagsHtml}</div>` : ''}
    ${imageHtml}
  </div>`
}

// itemName is computed from raw OSM tags at render time using the current profileKey.
// This keeps the Overpass tile cache profile-independent: travel mode switching rerenders
// instantly without any re-fetch.
//
// Uses an imperative Leaflet layer group with canvas renderer to bypass React
// reconciliation for individual polylines — canvas is 5-10x faster than SVG on mobile.
function OverlayRenderer({ ways, profileKey, preferredItemNames, showOtherPaths, hasRoute, regionRules }: {
  ways: OsmWay[]
  profileKey: string
  preferredItemNames: Set<string>
  showOtherPaths: boolean
  hasRoute: boolean
  regionRules?: ClassificationRule[]
}) {
  const map = useMap()
  const lgRef = useRef<L.LayerGroup | null>(null)

  // Mount: create layer group and add to map. Unmount: remove it.
  useEffect(() => {
    const lg = L.layerGroup()
    lg.addTo(map)
    lgRef.current = lg
    return () => {
      lg.remove()
      lgRef.current = null
    }
  }, [map])

  // Redraw whenever data or display settings change.
  useEffect(() => {
    const lg = lgRef.current
    if (!lg) return

    lg.clearLayers()

    // Reduce overlay line weight when a route is shown so the route stands out.
    const overlayWeight = hasRoute ? 3 : 5

    for (const way of ways) {
      const itemName = classifyOsmTagsToItem(way.tags, profileKey, regionRules)
      if (!showOtherPaths && (itemName === null || !preferredItemNames.has(itemName))) continue
      const isPreferred = itemName !== null && preferredItemNames.has(itemName)
      const color = isPreferred ? PREFERRED_COLOR : OTHER_COLOR

      const polyline = L.polyline(way.coordinates, {
        color,
        weight: overlayWeight,
        opacity: 0.7,
        renderer: canvasRenderer,
      })

      // Bind tooltip without image — fetch Mapillary image lazily on first hover.
      polyline.bindTooltip(buildTooltipHtml(itemName, way.tags, isPreferred, null), {
        sticky: true,
        direction: 'top',
        className: 'bike-segment-tooltip',
      })

      let imageFetched = false
      polyline.on('tooltipopen', () => {
        if (imageFetched) return
        imageFetched = true
        const coords = way.coordinates
        const mid = coords[Math.floor(coords.length / 2)]
        getStreetImage(mid[0], mid[1]).then((img) => {
          if (!img) return
          const tip = polyline.getTooltip()
          if (!tip) return
          polyline.setTooltipContent(buildTooltipHtml(itemName, way.tags, isPreferred, img.thumbUrl))
        })
      })

      polyline.addTo(lg)
    }
  }, [ways, profileKey, preferredItemNames, showOtherPaths, hasRoute, regionRules])

  return null
}

interface ControllerProps {
  enabled: boolean
  profileKey: string
  preferredItemNames: Set<string>
  showOtherPaths: boolean
  hasRoute: boolean
  onStatusChange: (status: string) => void
  regionRules?: ClassificationRule[]
}

function OverlayController({ enabled, profileKey, preferredItemNames, showOtherPaths, hasRoute, onStatusChange, regionRules }: ControllerProps) {
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
    resize() {
      // Fired when invalidateSize() is called (e.g. after CSS layout settles).
      // Re-trigger tile loading so the correct viewport bounds are used.
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(loadVisibleTiles, 200)
    },
  })

  const rafRef = useRef(0)

  useEffect(() => {
    if (enabled) {
      // Reset tile tracking only when the overlay is enabled (not on profile change).
      // Tile data is profile-independent — travel mode switching just rerenders with new itemNames.
      generationRef.current++
      loadingTilesRef.current = new Set()
      loadedTilesRef.current = new Set()

      // Force Leaflet to recalculate container size, then wait one frame for
      // the browser to finish CSS layout before querying bounds. Without this
      // delay, getBounds() can return a zero/undersized viewport on initial
      // load, causing no tiles to be fetched until the user pans or zooms.
      map.invalidateSize()
      rafRef.current = requestAnimationFrame(() => {
        map.invalidateSize()

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
      })
    } else {
      generationRef.current++
      loadingTilesRef.current = new Set()
      loadedTilesRef.current = new Set()
      setTileData(new Map())
      onStatusChange('idle')
    }
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      cancelAnimationFrame(rafRef.current)
    }
  }, [enabled]) // eslint-disable-line react-hooks/exhaustive-deps

  // Memoized to prevent OverlayRenderer from re-running its effect when tileData
  // reference changes but contents haven't — e.g. unrelated parent re-renders.
  const allWays = useMemo<OsmWay[]>(() => {
    const result: OsmWay[] = []
    for (const ways of tileData.values()) {
      for (const w of ways) result.push(w)
    }
    return result
  }, [tileData])

  if (!enabled || allWays.length === 0) return null
  return <OverlayRenderer ways={allWays} profileKey={profileKey} preferredItemNames={preferredItemNames} showOtherPaths={showOtherPaths} hasRoute={hasRoute} regionRules={regionRules} />
}

interface Props {
  enabled: boolean
  profileKey: string
  preferredItemNames: Set<string>
  showOtherPaths: boolean
  hasRoute: boolean
  onStatusChange: (status: string) => void
  regionRules?: ClassificationRule[]
}

export default function BikeMapOverlay({ enabled, profileKey, preferredItemNames, showOtherPaths, hasRoute, onStatusChange, regionRules }: Props) {
  return <OverlayController enabled={enabled} profileKey={profileKey} preferredItemNames={preferredItemNames} showOtherPaths={showOtherPaths} hasRoute={hasRoute} onStatusChange={onStatusChange} regionRules={regionRules} />
}
