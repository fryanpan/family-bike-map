import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  fetchBikeInfraForTile, getVisibleTiles, isTileCached, getCachedTile, tileKey,
  classifyOsmTagsToItem, isOverlayHiddenSurface, isRoughSurface, isOverlayCrossing,
} from '../services/overpass'
import { getDisplayPathLevel, getOverlayMaxGradientPct } from '../utils/classify'
import { prefetchElevation, overlayGradientPct } from '../services/elevation'
import { classifyEdge, PATH_LEVEL_LABELS } from '../utils/lts'
import type { PathLevel } from '../utils/lts'
import { colorForLevel, weightMultiplierForLevel } from './SimpleLegend'
import { useAdminSettings } from '../services/adminSettings'
import { resolveStreetImagery } from '../services/streetImagery'
import { useMapEngine } from '../services/mapEngine/context'
import type { MapEngine, PolylineHandle, PopupHandle, PathLayerHandle, PathLayerFeature } from '../services/mapEngine'
import type { ClassificationRule } from '../services/rules'
import type { OsmWay } from '../utils/types'
import { simplifyPath } from '../utils/simplifyPath'

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
  imageCredit?: string | null,
): string {
  const debugTags = getDebugTags(tags)
  const name = tags.name ? ` — ${escapeHtml(tags.name)}` : ''
  const preferredLabel = isPreferred
    ? `<span style="color:#10b981;font-weight:600">Preferred</span>`
    : `<span style="color:#f97316;font-weight:600">Not preferred</span>`
  const tagsHtml = debugTags.map((t) => `<div>${escapeHtml(t)}</div>`).join('')
  // Mapillary images need an attribution caption; Street View carries its
  // own baked-in watermark, so a credit is passed only for the fallback.
  const creditHtml = imageUrl && imageCredit
    ? `<div style="font-size:10px;color:#6b7280;text-align:right;margin-top:2px">via ${escapeHtml(imageCredit)}</div>`
    : ''
  const imageHtml = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="Street-level view" style="width:100%;border-radius:4px;margin-top:6px;display:block" loading="lazy" />${creditHtml}`
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
  /** Coordinates after per-zoom Douglas-Peucker decimation. Shared
   *  across all overlay passes (halo / hit / colour / stipple) so the
   *  simplification cost is paid once per render. */
  coords: [number, number][]
  pathLevel: PathLevel
  color: string
  weight: number
  opacity: number
  itemName: string | null
  isPreferred: boolean
  drawHalo: boolean
}

function OverlayRenderer({ engine, ways, profileKey, preferredItemNames, hasRoute, regionRules }: {
  engine: MapEngine
  ways: OsmWay[]
  profileKey: string
  preferredItemNames: Set<string>
  hasRoute: boolean
  regionRules?: ClassificationRule[]
}) {
  const settings = useAdminSettings()
  const [zoom, setZoom] = useState<number>(() => engine.getZoom())
  // Bumped once the terrain-RGB tiles covering the loaded ways have been
  // fetched, so the render effect re-runs and the steepness gate can read
  // real elevations. Until then overlayGradientPct returns null and every
  // way shows (fail-soft) — steep ways simply pop out a beat later.
  const [elevReady, setElevReady] = useState(0)
  // Per-way gross gradient, cached by OSM id. Gradient depends only on
  // geometry + elevation (both stable per way for the session), NOT on
  // mode — so a mode switch or zoom that re-runs the render effect reuses
  // these instead of recomputing ~1600 lookups. Only non-null results are
  // cached: a way computed before its terrain tile arrived stays uncached
  // and recomputes on the next render (elevReady) so the gate still fires.
  const gradientCache = useRef<Map<string | number, number>>(new Map())

  // Zoom drives cobble-marker visibility. Subscribe via the engine's
  // event facade rather than the underlying Leaflet/Google APIs.
  useEffect(() => {
    const off = engine.on('zoomend', (ev) => {
      if (ev.type === 'zoomend') setZoom(ev.zoom)
    })
    return () => { off() }
  }, [engine])

  // Prefetch terrain-RGB tiles for the steepness gate. Bounded to the
  // VISIBLE viewport (engine.getBounds()), NOT the union of all loaded
  // ways: tileData accumulates across pans and a single OSM way with an
  // outlier node can span the bbox across a continent, which would make
  // prefetchElevation fire thousands of tile requests and stall the page.
  // The viewport is always small (≤ MAX_VISIBLE_TILES). Off-screen ways
  // fail soft (null gradient → shown) until the user pans to them.
  // Re-runs when ways change (i.e. a pan loaded new tiles). Tiles are
  // cached in-memory and shared with the router.
  useEffect(() => {
    if (ways.length === 0) return
    const [sw, ne] = engine.getBounds()
    const bbox = { south: sw[0], west: sw[1], north: ne[0], east: ne[1] }
    if (![bbox.south, bbox.west, bbox.north, bbox.east].every(Number.isFinite)) return
    let cancelled = false
    void prefetchElevation(bbox)
      .then(() => { if (!cancelled) setElevReady((v) => v + 1) })
    return () => { cancelled = true }
  }, [ways, engine])

  useEffect(() => {
    const polylineHandles: PolylineHandle[] = []
    const pathLayerHandles: PathLayerHandle[] = []
    let openPopup: PopupHandle | null = null

    const BROWSING_WEIGHT = 4

    // Max gross gradient this mode tolerates on the browse overlay. Steeper
    // shown ways (e.g. 20% `highway=path` hiking trails) are hidden.
    const maxGradientPct = getOverlayMaxGradientPct(profileKey)

    // Pass 0 — classify + filter.
    const toRender: RenderedWay[] = []
    const roughWays: OsmWay[] = []
    for (const way of ways) {
      // Traffic-control pseudo-ways (single-coordinate signal/stop nodes in
      // the tile payload — see isControlNode) are router input, not paint.
      if (way.coordinates.length < 2) continue
      const { pathLevel: routingPathLevel } = classifyEdge(way.tags)
      if (routingPathLevel === '4') continue
      // Crossing / traffic-island stubs are real connectors for routing but
      // render as disconnected confetti on the browse overlay — drop them.
      if (isOverlayCrossing(way.tags)) continue
      if (isOverlayHiddenSurface(way.tags)) {
        // Surface IS rough — keep it for the cobble-marker pass.
        if (isRoughSurface(way.tags)) roughWays.push(way)
        continue
      }

      const itemName = classifyOsmTagsToItem(way.tags, profileKey, regionRules)
      const pathLevel = getDisplayPathLevel(itemName, profileKey, routingPathLevel)
      const isPreferred = itemName !== null && preferredItemNames.has(itemName)
      // Overlay shows ONLY items the active mode prefers. Items at a
      // preferred LEVEL but flagged non-preferred for this mode (e.g.
      // 'Protected bike lane on major road' for kid-confident — still
      // pathLevel '1a' but the legend opts the mode out) are hidden
      // here too. Non-preferred ways still render on the route polyline
      // (see useRoutePolylines in Map.tsx) so users see every segment
      // along their actual route regardless of overlay visibility.
      if (!isPreferred) continue
      // Hide ways too steep for this mode. overlayGradientPct returns null
      // (→ shown) when elevation isn't loaded yet or the way is too short
      // for z=12 to resolve a grade, so this fails soft. Cache hits skip
      // the elevation lookups on mode/zoom re-renders.
      let gradientPct = gradientCache.current.get(way.osmId) ?? null
      if (gradientPct == null) {
        gradientPct = overlayGradientPct(way.coordinates)
        if (gradientPct != null) gradientCache.current.set(way.osmId, gradientPct)
      }
      if (gradientPct != null && gradientPct > maxGradientPct) continue
      const color = colorForLevel(pathLevel, settings.tiers)
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
      // Decimate the geometry once per render. All overlay passes
      // (halo, hit-area, colour, plus the stipple pass for rough
      // ways) share this simplified path so the GPU vertex count
      // collapses at low zoom. At z >= 16 simplifyPath returns the
      // input unchanged so taps still hit precise geometry.
      const coords = simplifyPath(way.coordinates, zoom)
      toRender.push({ way, coords, pathLevel, color, weight, opacity, itemName, isPreferred, drawHalo })

      // Reference unused locals to keep the noUnusedLocals tsc rule happy
      // when a future tweak removes a reader. (TS ignores via void.)
      void isPreferred
    }

    // Index toRender by way.id so the click handler can dispatch from
    // the deck.gl PathLayer's onClick — feature.id is echoed back to us.
    const wayIndex = new Map<string | number, RenderedWay>()
    for (const r of toRender) wayIndex.set(r.way.osmId, r)

    // Resolve street-level imagery for an already-open popup and fill it in.
    // Street View where Google has coverage, else Mapillary, else nothing —
    // so coverage gaps don't show a gray "no imagery" tile. Async (a free
    // metadata coverage check runs first), so we re-check the popup is still
    // the active one before updating: the user may have clicked away.
    const fillPopupImagery = (
      handle: PopupHandle,
      mid: [number, number],
      render: (imgUrl: string | null, credit: string | null) => string,
    ) => {
      void resolveStreetImagery(mid[0], mid[1]).then((r) => {
        if (openPopup !== handle) return
        engine.updatePopup(handle, render(r.url ?? null, r.credit ?? null))
      })
    }

    const openSegmentPopup = (r: RenderedWay) => {
      if (openPopup) engine.closePopup(openPopup)
      const mid = r.way.coordinates[Math.floor(r.way.coordinates.length / 2)]
      const handle = engine.openPopup(
        mid,
        buildTooltipHtml(r.itemName, r.way.tags, r.isPreferred, null),
        {
          maxWidth: 260,
          className: 'bike-segment-popup',
          onClose: () => { if (openPopup === handle) openPopup = null },
        },
      )
      openPopup = handle
      fillPopupImagery(handle, mid, (imgUrl, credit) =>
        buildTooltipHtml(r.itemName, r.way.tags, r.isPreferred, imgUrl, credit))
    }

    // Pass 1 — halos. Done first (lowest z-order) so a later coloured
    // polyline isn't overpainted by a neighbour's halo at shared
    // junction nodes. Drawn in a single bulk PathLayer for perf.
    const haloFeatures: PathLayerFeature[] = []
    for (const r of toRender) {
      if (!r.drawHalo) continue
      haloFeatures.push({
        id: 'halo:' + r.way.osmId,
        coordinates: r.coords,
        color: '#ffffff',
        width: r.weight + settings.overlayHaloExtra,
        opacity: r.opacity,
      })
    }
    if (haloFeatures.length > 0) {
      pathLayerHandles.push(engine.addPathLayer(haloFeatures))
    }

    // Pass 2a — invisible wide hit-area layer for finger taps. Sits
    // above halos but below the visible colour, with full hit width
    // (HIT_POLYLINE_WEIGHT). deck.gl picks at rendered geometry, so
    // we need this dedicated layer for forgiving mobile taps.
    const hitFeatures: PathLayerFeature[] = toRender.map((r) => ({
      id: r.way.osmId,
      coordinates: r.coords,
      color: '#000000',
      width: HIT_POLYLINE_WEIGHT,
      opacity: 0,
      meta: r,
    }))
    if (hitFeatures.length > 0) {
      pathLayerHandles.push(engine.addPathLayer(hitFeatures, {
        onClick: (id) => {
          const r = wayIndex.get(id)
          if (r) openSegmentPopup(r)
        },
      }))
    }

    // Pass 2b — visible coloured polylines (top z-order of pass 2).
    const colorFeatures: PathLayerFeature[] = toRender.map((r) => ({
      id: 'color:' + r.way.osmId,
      coordinates: r.coords,
      color: r.color,
      width: r.weight,
      opacity: r.opacity,
    }))
    if (colorFeatures.length > 0) {
      pathLayerHandles.push(engine.addPathLayer(colorFeatures))
    }

    // Pass 3 — rough-surface stipple overlay. A fine grey dashed
    // polyline drawn along the way's geometry signals "rough / bumpy"
    // without the visual noise of an emoji marker. The stipple texture
    // reads at-a-glance as a different surface; it's quiet at city
    // overview zooms, distinct at street-detail zooms. Gated on zoom
    // so the overview map stays clean. (Replaced the prior 🪨 emoji
    // marker per Joanna's UX feedback 2026-04-30 — the icons read as
    // arbitrary visual noise; a textured overlay matches the
    // navigational meaning much better.)
    if (zoom >= COBBLE_MARKER_MIN_ZOOM) {
      for (const way of roughWays) {
        if (way.coordinates.length < 2) continue
        const onClick = () => {
          if (openPopup) engine.closePopup(openPopup)
          const mid = way.coordinates[Math.floor(way.coordinates.length / 2)]
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
          fillPopupImagery(popupHandle, mid, (imgUrl, credit) =>
            buildTooltipHtml('Rough surface', way.tags, false, imgUrl, credit))
        }
        polylineHandles.push(engine.addPolyline(
          way.coordinates,
          {
            color: '#6b7280',          // grey-500
            weight: 5,
            opacity: 0.85,
            // Fine stipple — short dash + short gap reads as "wavy /
            // textured surface", distinct from the longer dash we use
            // for alternate routes (10 6).
            dashArray: '1 4',
            useCanvasRenderer: true,
          },
          { onClick },
        ))
      }
    }

    return () => {
      for (const h of polylineHandles) engine.removePolyline(h)
      for (const h of pathLayerHandles) engine.removePathLayer(h)
      if (openPopup) engine.closePopup(openPopup)
    }
  }, [engine, ways, profileKey, preferredItemNames, hasRoute, regionRules, settings, zoom, elevReady])

  return null
}

// ── Tile loader ───────────────────────────────────────────────────────────

interface ControllerProps {
  enabled: boolean
  profileKey: string
  preferredItemNames: Set<string>
  hasRoute: boolean
  onStatusChange: (status: string) => void
  regionRules?: ClassificationRule[]
}

function OverlayController({ enabled, profileKey, preferredItemNames, hasRoute, onStatusChange, regionRules }: ControllerProps) {
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
  hasRoute: boolean
  onStatusChange: (status: string) => void
  regionRules?: ClassificationRule[]
}

export default function BikeMapOverlay(props: Props) {
  return <OverlayController {...props} />
}
