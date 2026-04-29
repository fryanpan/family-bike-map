import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  fetchBikeInfraForTile, getVisibleTiles, isTileCached, getCachedTile, tileKey,
  classifyOsmTagsToItem, isOverlayHiddenSurface, isRoughSurface,
} from '../services/overpass'
import { PREFERRED_COLOR, OTHER_COLOR, PROFILE_LEGEND, getDisplayPathLevel } from '../utils/classify'
import { classifyEdge, PATH_LEVEL_LABELS } from '../utils/lts'
import type { PathLevel } from '../utils/lts'
import { colorForLevel, weightMultiplierForLevel } from './SimpleLegend'
import { useAdminSettings } from '../services/adminSettings'
import { getStreetViewUrl } from '../services/streetview'
import { useMapEngine } from '../services/mapEngine/context'
import type { MapEngine, PolylineHandle, MarkerHandle, PopupHandle } from '../services/mapEngine'
import type { ClassificationRule } from '../services/rules'
import type { OsmWay } from '../utils/types'

// Max tiles allowed in viewport. Beyond this the map is too zoomed out
// to be useful — show the "zoom in" prompt instead of firing many
// parallel requests. 30 covers reasonable metro views.
const MAX_VISIBLE_TILES = 30

// Hit-area weight for the transparent tap-target polylines. Sized for
// fingertips on mobile. The visible coloured polyline still paints on
// top, so the user sees no visual change.
const HIT_POLYLINE_WEIGHT = 24

// Zoom threshold for showing cobble markers. Below this zoom the
// markers would crowd the city-overview map; above it, the rough-
// surface indicator becomes useful (the user is close enough to care
// which side street is paved smoothly vs. cobbled).
const COBBLE_MARKER_MIN_ZOOM = 16

// ── Tooltip HTML helpers (unchanged) ──────────────────────────────────────

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
  const tagsHtml = debugTags.map((t) => `<div>${escapeHtml(t)}</div>`).join('')
  const imageHtml = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="Street view" style="width:100%;border-radius:4px;margin-top:6px;display:block" loading="lazy" />`
    : ''
  const { pathLevel } = classifyEdge(tags)
  const info = PATH_LEVEL_LABELS[pathLevel]
  const ltsHtml = `<div style="margin-top:6px;padding:5px 7px;background:#f3f4f6;border-radius:4px">
    <div style="font-size:11px"><b>LTS ${pathLevel}</b> · ${escapeHtml(info.short)}</div>
    <div style="font-size:11px;color:#4b5563;margin-top:2px">${escapeHtml(info.description)}</div>
  </div>`
  return `<div style="font-size:12px;line-height:1.5;width:240px">
    <div style="font-weight:700;white-space:normal;word-break:break-word">${itemName ?? 'Unknown'}${name}</div>
    <div style="margin-top:2px">${preferredLabel}</div>
    ${ltsHtml}
    ${tagsHtml ? `<div style="color:#6b7280;font-size:11px;margin-top:4px">${tagsHtml}</div>` : ''}
    ${imageHtml}
  </div>`
}

// ── Renderer ───────────────────────────────────────────────────────────────

interface RenderedWay {
  way: OsmWay
  pathLevel: PathLevel
  color: string
  weight: number
  opacity: number
  itemName: string | null
  isPreferred: boolean
  drawHalo: boolean
}

function OverlayRenderer({ engine, ways, profileKey, preferredItemNames, showOtherPaths, hasRoute, regionRules }: {
  engine: MapEngine
  ways: OsmWay[]
  profileKey: string
  preferredItemNames: Set<string>
  showOtherPaths: boolean
  hasRoute: boolean
  regionRules?: ClassificationRule[]
}) {
  const settings = useAdminSettings()
  const [zoom, setZoom] = useState<number>(() => engine.getZoom())

  // Zoom drives cobble-marker visibility. Subscribe via the engine's
  // event facade rather than the underlying Leaflet/Google APIs.
  useEffect(() => {
    const off = engine.on('zoomend', (ev) => {
      if (ev.type === 'zoomend') setZoom(ev.zoom)
    })
    return () => { off() }
  }, [engine])

  useEffect(() => {
    const polylineHandles: PolylineHandle[] = []
    const markerHandles: MarkerHandle[] = []
    let openPopup: PopupHandle | null = null

    const BROWSING_WEIGHT = 4

    const preferredLevels = new Set<PathLevel>()
    for (const group of PROFILE_LEGEND[profileKey] ?? []) {
      if (!group.defaultPreferred) continue
      for (const item of group.items) preferredLevels.add(item.level)
    }

    // Pass 0 — classify + filter.
    const toRender: RenderedWay[] = []
    const roughWays: OsmWay[] = []
    for (const way of ways) {
      const { pathLevel: routingPathLevel } = classifyEdge(way.tags)
      if (routingPathLevel === '4') continue
      if (isOverlayHiddenSurface(way.tags)) {
        // Surface IS rough — keep it for the cobble-marker pass.
        if (isRoughSurface(way.tags)) roughWays.push(way)
        continue
      }

      const itemName = classifyOsmTagsToItem(way.tags, profileKey, regionRules)
      const pathLevel = getDisplayPathLevel(itemName, profileKey, routingPathLevel)
      const isLevelPreferred = preferredLevels.has(pathLevel)
      if (!isLevelPreferred && !showOtherPaths) continue

      const isPreferred = itemName !== null && preferredItemNames.has(itemName)
      const color = isLevelPreferred ? colorForLevel(pathLevel, settings.tiers) : OTHER_COLOR
      const isBikeInfraTier = pathLevel === '1a' || pathLevel === '1b' || pathLevel === '2a'
      const browsingWeight = BROWSING_WEIGHT * weightMultiplierForLevel(pathLevel, settings.tiers)
      const weightScaled = hasRoute && isBikeInfraTier
        ? browsingWeight * 0.8
        : hasRoute
          ? browsingWeight * 0.75
          : browsingWeight
      const weight = Math.max(2, Math.round(weightScaled))
      const opacity = hasRoute && isBikeInfraTier
        ? settings.overlayOpacityBrowsing * 0.8
        : hasRoute
          ? settings.overlayOpacityWithRoute
          : settings.overlayOpacityBrowsing
      const drawHalo = isBikeInfraTier
      toRender.push({ way, pathLevel, color, weight, opacity, itemName, isPreferred, drawHalo })

      // Reference unused locals to keep the noUnusedLocals tsc rule happy
      // when a future tweak removes a reader. (TS ignores via void.)
      void isPreferred
    }

    // Pass 1 — halos. Done first so a later coloured polyline isn't
    // overpainted by a neighbour's halo at shared junction nodes.
    for (const r of toRender) {
      if (!r.drawHalo) continue
      polylineHandles.push(engine.addPolyline(
        r.way.coordinates,
        {
          color: '#ffffff',
          weight: r.weight + settings.overlayHaloExtra,
          opacity: r.opacity,
          interactive: false,
          useCanvasRenderer: true,
        },
      ))
    }

    // Pass 2 — coloured polylines + transparent wider hit polyline for
    // mobile taps. Hit polyline added FIRST so the visible line still
    // paints on top.
    for (const r of toRender) {
      const { way, color, weight, opacity, itemName, isPreferred } = r

      const onClick = () => {
        if (openPopup) engine.closePopup(openPopup)
        // Open the popup with placeholder content; lazy-load Street View
        // image once and update it in.
        const handle = engine.openPopup(
          way.coordinates[Math.floor(way.coordinates.length / 2)],
          buildTooltipHtml(itemName, way.tags, isPreferred, null),
          {
            maxWidth: 260,
            className: 'bike-segment-popup',
            onClose: () => { if (openPopup === handle) openPopup = null },
          },
        )
        openPopup = handle
        const mid = way.coordinates[Math.floor(way.coordinates.length / 2)]
        const imgUrl = getStreetViewUrl(mid[0], mid[1], { size: '400x240' })
        // The proxied URL just needs to be set into the popup HTML —
        // the browser fetches the image directly via <img src>.
        engine.updatePopup(handle, buildTooltipHtml(itemName, way.tags, isPreferred, imgUrl))
      }

      // Transparent hit-area polyline (added first → bottom z-order).
      polylineHandles.push(engine.addPolyline(
        way.coordinates,
        {
          color: '#000',
          weight: HIT_POLYLINE_WEIGHT,
          opacity: 0,
          useCanvasRenderer: true,
        },
        { onClick },
      ))

      // Visible coloured polyline (added second → top z-order).
      polylineHandles.push(engine.addPolyline(
        way.coordinates,
        { color, weight, opacity, useCanvasRenderer: true },
        { onClick },
      ))
    }

    // Pass 3 — cobble markers for rough-surface ways. Gated on zoom so
    // the city-overview map stays clean.
    if (zoom >= COBBLE_MARKER_MIN_ZOOM) {
      for (const way of roughWays) {
        if (way.coordinates.length === 0) continue
        const mid = way.coordinates[Math.floor(way.coordinates.length / 2)]
        const handle = engine.addMarker(
          mid,
          {
            kind: 'html',
            html: '<div class="cobble-marker" title="Rough / cobbled">🪨</div>',
            size: [18, 18],
            anchor: [9, 9],
          },
          {
            onClick: () => {
              if (openPopup) engine.closePopup(openPopup)
              const popupHandle = engine.openPopup(
                mid,
                buildTooltipHtml('Rough surface', way.tags, false, null),
                {
                  maxWidth: 260,
                  className: 'bike-segment-popup',
                  onClose: () => { if (openPopup === popupHandle) openPopup = null },
                },
              )
              openPopup = popupHandle
              const imgUrl = getStreetViewUrl(mid[0], mid[1], { size: '400x240' })
              engine.updatePopup(popupHandle, buildTooltipHtml('Rough surface', way.tags, false, imgUrl))
            },
          },
        )
        markerHandles.push(handle)
      }
    }

    return () => {
      for (const h of polylineHandles) engine.removePolyline(h)
      for (const h of markerHandles)   engine.removeMarker(h)
      if (openPopup) engine.closePopup(openPopup)
    }
  }, [engine, ways, profileKey, preferredItemNames, showOtherPaths, hasRoute, regionRules, settings, zoom])

  return null
}

// ── Tile loader ───────────────────────────────────────────────────────────

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
  const engine = useMapEngine()
  const [tileData, setTileData] = useState<Map<string, OsmWay[]>>(new Map())

  const loadingTilesRef = useRef<Set<string>>(new Set())
  const loadedTilesRef  = useRef<Set<string>>(new Set())
  const generationRef   = useRef(0)

  const loadVisibleTiles = useCallback(async () => {
    if (!engine || !enabled) return
    const [sw, ne] = engine.getBounds()
    const bounds = {
      getSouth: () => sw[0], getNorth: () => ne[0],
      getWest:  () => sw[1], getEast:  () => ne[1],
    }
    const tiles = getVisibleTiles(bounds)

    if (tiles.length > MAX_VISIBLE_TILES) { onStatusChange('zoom'); return }

    const toLoad = tiles.filter((t) => {
      const k = tileKey(t.row, t.col)
      return !loadedTilesRef.current.has(k) && !loadingTilesRef.current.has(k)
    })

    if (toLoad.length === 0) { onStatusChange('ok'); return }

    onStatusChange('loading')
    const generation = generationRef.current
    for (const t of toLoad) loadingTilesRef.current.add(tileKey(t.row, t.col))

    let anyError = false
    await Promise.all(toLoad.map(async (t) => {
      const k = tileKey(t.row, t.col)
      try {
        const ways = await fetchBikeInfraForTile(t.row, t.col)
        if (generationRef.current !== generation) return
        loadedTilesRef.current.add(k)
        setTileData((prev) => { const next = new Map(prev); next.set(k, ways); return next })
      } catch (err) {
        console.warn(`[BikeMapOverlay] Tile ${t.row}:${t.col} failed:`, err)
        anyError = true
      } finally {
        loadingTilesRef.current.delete(k)
      }
    }))

    if (generationRef.current !== generation) return
    const hasAnyVisibleData = tiles.some((t) =>
      loadedTilesRef.current.has(tileKey(t.row, t.col)) || isTileCached(t.row, t.col)
    )
    if (anyError && !hasAnyVisibleData) onStatusChange('error')
    else                                onStatusChange('ok')
  }, [enabled, engine, onStatusChange])

  // Subscribe to map move/zoom/resize via the engine event API.
  useEffect(() => {
    if (!engine) return
    const debounce = (ms: number, fn: () => void) => {
      let t: ReturnType<typeof setTimeout> | null = null
      return () => {
        if (t) clearTimeout(t)
        t = setTimeout(fn, ms)
      }
    }
    const onMove   = debounce(400, loadVisibleTiles)
    const onZoom   = debounce(400, loadVisibleTiles)
    const onResize = debounce(200, loadVisibleTiles)
    const offMove   = engine.on('moveend', onMove)
    const offZoom   = engine.on('zoomend', onZoom)
    const offResize = engine.on('resize',  onResize)
    return () => { offMove(); offZoom(); offResize() }
  }, [engine, loadVisibleTiles])

  // Initial mount: prime from in-memory cache, then load missing tiles.
  useEffect(() => {
    if (!engine) return
    if (enabled) {
      generationRef.current++
      loadingTilesRef.current = new Set()
      loadedTilesRef.current = new Set()
      engine.invalidateSize()
      const raf = requestAnimationFrame(() => {
        engine.invalidateSize()
        const [sw, ne] = engine.getBounds()
        const bounds = {
          getSouth: () => sw[0], getNorth: () => ne[0],
          getWest:  () => sw[1], getEast:  () => ne[1],
        }
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
      return () => { cancelAnimationFrame(raf) }
    } else {
      generationRef.current++
      loadingTilesRef.current = new Set()
      loadedTilesRef.current = new Set()
      setTileData(new Map())
      onStatusChange('idle')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, engine])

  const allWays = useMemo<OsmWay[]>(() => {
    const result: OsmWay[] = []
    for (const ways of tileData.values()) for (const w of ways) result.push(w)
    return result
  }, [tileData])

  if (!engine || !enabled || allWays.length === 0) return null
  return (
    <OverlayRenderer
      engine={engine}
      ways={allWays}
      profileKey={profileKey}
      preferredItemNames={preferredItemNames}
      showOtherPaths={showOtherPaths}
      hasRoute={hasRoute}
      regionRules={regionRules}
    />
  )
}

// ── Public component (unchanged shape) ────────────────────────────────────

interface Props {
  enabled: boolean
  profileKey: string
  preferredItemNames: Set<string>
  showOtherPaths: boolean
  hasRoute: boolean
  onStatusChange: (status: string) => void
  regionRules?: ClassificationRule[]
}

export default function BikeMapOverlay(props: Props) {
  return <OverlayController {...props} />
}
