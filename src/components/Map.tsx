import { useEffect, useRef, useState, useMemo } from 'react'
import { PREFERRED_COLOR, OTHER_COLOR, getLegendItem } from '../utils/classify'
import { classifyEdge, PATH_LEVEL_LABELS } from '../utils/lts'
import { colorForLevel } from './SimpleLegend'
import { useAdminSettings } from '../services/adminSettings'
import { getCachedTile, latLngToTile, classifyOsmTagsToItem, getVisibleTiles } from '../services/overpass'
import { getStreetViewUrl } from '../services/streetview'
import { createEngine, resolveEngine, readEnvKeys } from '../services/mapEngine'
import type { MapEngine, PolylineHandle, MarkerHandle, LatLng as EngineLatLng } from '../services/mapEngine'
import { MapEngineContext } from '../services/mapEngine/context'
import BikeMapOverlay from './BikeMapOverlay'
import type { ClassificationRule } from '../services/rules'
import type { Place, Route, RouteSegment, OsmWay } from '../utils/types'

// Short labels for segment types — shown directly on the map instead of
// emoji icons.
const SHORT_LABELS: Record<string, string> = {
  'Bike path': 'Radweg',
  'Fahrradstrasse': 'Fahrradstr.',
  'Shared foot path': 'Park path',
  'Elevated sidewalk path': 'Sidewalk path',
  'Living street': 'Living st.',
  'Painted bike lane': 'Bike lane',
  'Shared bus lane': 'Bus lane',
  'Residential/local road': 'Local road',
  'Rough surface': 'Bumpy · slow',
}

const WALKING_COLOR = '#6b7280'

// Hit-area weight for transparent tap-target polylines. Sized for a
// fingertip on mobile (~44px Apple HIG / Material 48dp) — we use 24px
// because the visible line already adds another ~7-8px and Leaflet's
// hit-test is generous beyond the visible stroke.
const HIT_POLYLINE_WEIGHT = 24

/** Haversine distance in meters between two [lat, lng] points. */
function segDistM(a: [number, number], b: [number, number]): number {
  const R = 6371000
  const dLat = (b[0] - a[0]) * Math.PI / 180
  const dLng = (b[1] - a[1]) * Math.PI / 180
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * Math.PI / 180) * Math.cos(b[0] * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

function midpoint(coords: [number, number][]): [number, number] {
  return coords[Math.floor(coords.length / 2)]
}

/** Coalesce nearby same-type segments for icon placement. Merges
 *  segments of the same itemName when the gap between them is <= gapM
 *  meters. Returns coalesced segments; used only for icon placement,
 *  not polyline rendering (which stays pixel-accurate). */
function coalesceForIcons(segments: RouteSegment[], gapM = 20): RouteSegment[] {
  if (segments.length === 0) return []
  const result: RouteSegment[] = [{ ...segments[0], coordinates: [...segments[0].coordinates] }]
  for (let i = 1; i < segments.length; i++) {
    const prev = result[result.length - 1]
    const curr = segments[i]
    const prevEnd = prev.coordinates[prev.coordinates.length - 1]
    const currStart = curr.coordinates[0]
    const gap = prevEnd && currStart ? segDistM(prevEnd, currStart) : Infinity
    if (curr.itemName === prev.itemName && gap <= gapM) {
      prev.coordinates = [...prev.coordinates, ...curr.coordinates]
    } else {
      result.push({ ...curr, coordinates: [...curr.coordinates] })
    }
  }
  return result
}

/** Find the OSM way in cached tiles whose path most closely matches a
 *  route segment. Sample-and-sum-min-distance scoring; searches the
 *  segment-midpoint tile + its 8 neighbors. Returns null if no ways
 *  are cached nearby. */
function findNearestWayToSegment(segCoords: [number, number][]): { way: OsmWay; distance: number } | null {
  if (segCoords.length === 0) return null
  const sampleCount = Math.min(5, segCoords.length)
  const samples: Array<[number, number]> = []
  for (let i = 0; i < sampleCount; i++) {
    const idx = Math.round((i * (segCoords.length - 1)) / Math.max(1, sampleCount - 1))
    samples.push(segCoords[idx])
  }
  const mid = segCoords[Math.floor(segCoords.length / 2)]
  const { row, col } = latLngToTile(mid[0], mid[1])
  let best: OsmWay | null = null
  let bestScore = Infinity
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const tile = getCachedTile(row + dr, col + dc)
      if (!tile) continue
      for (const way of tile) {
        if (way.coordinates.length === 0) continue
        let sum = 0
        for (const [sLat, sLng] of samples) {
          let minD = Infinity
          for (const [wLat, wLng] of way.coordinates) {
            const d = Math.abs(wLat - sLat) + Math.abs(wLng - sLng)
            if (d < minD) minD = d
          }
          sum += minD
        }
        if (sum < bestScore) { bestScore = sum; best = way }
      }
    }
  }
  return best ? { way: best, distance: bestScore } : null
}

// ── Segment popup ──────────────────────────────────────────────────────────
//
// Rendered as a fixed-position React overlay anchored to the click
// point. We don't use the engine's openPopup() for this case because
// the popup has interactive React (Reroute / Flag buttons + image
// loading state) — easier to keep in React than to imperatively wire
// click handlers across HTML strings.

interface SelectedSegment {
  seg: RouteSegment
  index: number
  latLng: EngineLatLng
}

function SegmentPopupOverlay({
  selected,
  engine,
  profileKey,
  onClose,
  onReroute,
  onFlag,
}: {
  selected: SelectedSegment
  engine: MapEngine
  profileKey: string
  onClose: () => void
  onReroute?: (wayIds: number[]) => void
  onFlag?: (seg: RouteSegment) => void
}) {
  const { seg, latLng } = selected

  // Re-projected pixel position; refreshed on map move/zoom so the
  // popup tracks the underlying lat/lng.
  const [pixel, setPixel] = useState<[number, number]>(() => engine.latLngToContainerPoint(latLng))
  useEffect(() => {
    setPixel(engine.latLngToContainerPoint(latLng))
    const off1 = engine.on('zoomend', () => setPixel(engine.latLngToContainerPoint(latLng)))
    const off2 = engine.on('moveend', () => setPixel(engine.latLngToContainerPoint(latLng)))
    return () => { off1(); off2() }
  }, [engine, latLng])

  const nearest = useMemo(() => findNearestWayToSegment(seg.coordinates), [seg])
  const wayToAvoid = nearest?.way.osmId ?? null
  const tags = nearest?.way.tags ?? {}
  const segMid: [number, number] = seg.coordinates.length > 0
    ? seg.coordinates[Math.floor(seg.coordinates.length / 2)]
    : latLng
  const imgUrl = useMemo(() => getStreetViewUrl(segMid[0], segMid[1], { size: '400x240' }), [segMid])

  const tagRows = useMemo(() => {
    const rows: string[] = []
    if (tags.highway) rows.push(`highway=${tags.highway}`)
    if (tags.cycleway) rows.push(`cycleway=${tags.cycleway}`)
    if (tags['cycleway:right']) rows.push(`cycleway:right=${tags['cycleway:right']}`)
    if (tags['cycleway:left']) rows.push(`cycleway:left=${tags['cycleway:left']}`)
    if (tags['cycleway:both']) rows.push(`cycleway:both=${tags['cycleway:both']}`)
    if (tags.surface) rows.push(`surface=${tags.surface}`)
    if (tags.smoothness) rows.push(`smoothness=${tags.smoothness}`)
    if (tags.maxspeed) rows.push(`maxspeed=${tags.maxspeed}`)
    if (tags.bicycle_road === 'yes') rows.push('bicycle_road=yes')
    if (tags.segregated) rows.push(`segregated=${tags.segregated}`)
    return rows
  }, [tags])

  const legendItem = getLegendItem(seg.itemName, profileKey)
  const title = seg.isWalking
    ? '🚶 Walk your bike here'
    : `${legendItem?.icon ?? ''} ${seg.itemName ?? 'Route segment'}`
  const { pathLevel } = classifyEdge(tags)
  const levelInfo = PATH_LEVEL_LABELS[pathLevel]

  const rerouteWayIds: number[] = wayToAvoid != null ? [wayToAvoid] : (seg.wayIds ?? [])

  // Position the popup with a small offset from the click point. Width
  // is capped so it fits on small mobile screens; the .leaflet-popup
  // CSS already styles it nicely so we re-use the segment-popup classes.
  return (
    <div
      className="leaflet-popup segment-popup engine-popup"
      style={{
        position: 'absolute',
        left: pixel[0],
        top: pixel[1],
        transform: 'translate(-50%, -100%)',
        zIndex: 1000,
        pointerEvents: 'auto',
      }}
    >
      <div className="leaflet-popup-content-wrapper">
        <div className="leaflet-popup-content">
          <div className="segment-popup-body">
            <button
              className="engine-popup-close"
              aria-label="Close"
              onClick={onClose}
              style={{
                position: 'absolute', top: 4, right: 6,
                background: 'transparent', border: 0, cursor: 'pointer',
                fontSize: 18, color: '#6b7280', padding: '0 4px', lineHeight: 1,
              }}
            >×</button>
            <div className="segment-popup-title">{title}</div>
            {tags.name && <div className="segment-popup-name">{tags.name}</div>}

            <div className="segment-popup-lts">
              <span className="segment-popup-lts-tag">LTS {pathLevel}</span>
              <span className="segment-popup-lts-name">{levelInfo.short}</span>
              <div className="segment-popup-lts-desc">{levelInfo.description}</div>
            </div>

            {imgUrl && (
              <img src={imgUrl} alt="Street view" className="segment-popup-img" loading="lazy" />
            )}

            {tagRows.length > 0 && (
              <div className="segment-popup-tags">
                {tagRows.map((r, i) => <div key={i} className="segment-popup-tag">{r}</div>)}
              </div>
            )}

            <div className="segment-popup-actions">
              {onReroute && rerouteWayIds.length > 0 && (
                <button
                  className="segment-popup-btn segment-popup-btn-primary"
                  onClick={() => { onReroute(rerouteWayIds); onClose() }}
                >↩ Reroute around</button>
              )}
              {onFlag && (
                <button
                  className="segment-popup-btn"
                  onClick={() => { onFlag(seg); onClose() }}
                >🚩 Flag as wrong</button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Helper hooks: each manages a single class of imperative draw ───────────

function useFitBoundsOnRouteChange(engine: MapEngine | null, route: Route | null): void {
  useEffect(() => {
    if (!engine || !route || route.coordinates.length < 2) return
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
    for (const [lat, lng] of route.coordinates) {
      if (lat < minLat) minLat = lat
      if (lat > maxLat) maxLat = lat
      if (lng < minLng) minLng = lng
      if (lng > maxLng) maxLng = lng
    }
    const isMobile = window.innerWidth < 768
    const paddingTopLeft: [number, number] = isMobile ? [40, 100] : [360, 40]
    const paddingBottomRight: [number, number] = isMobile ? [40, Math.round(window.innerHeight * 0.38)] : [40, 40]
    engine.fitBounds([[minLat, minLng], [maxLat, maxLng]], { paddingTopLeft, paddingBottomRight })
  }, [engine, route])
}

function useCenterOnFirstLocation(
  engine: MapEngine | null,
  currentLocation: { lat: number; lng: number } | null,
): void {
  const hasCentered = useRef(false)
  useEffect(() => {
    if (!engine || !currentLocation || hasCentered.current) return
    engine.setView([currentLocation.lat, currentLocation.lng], 14)
    hasCentered.current = true
  }, [engine, currentLocation])
}

function useFlyToPoint(
  engine: MapEngine | null,
  point: { lat: number; lng: number } | null,
  zoom: number,
  animate: boolean,
): void {
  const prev = useRef<{ lat: number; lng: number } | null>(null)
  useEffect(() => {
    if (!engine || !point) return
    if (prev.current?.lat === point.lat && prev.current?.lng === point.lng) return
    prev.current = point
    if (animate) engine.flyTo([point.lat, point.lng], zoom)
    else engine.setView([point.lat, point.lng], zoom)
  }, [engine, point, zoom, animate])
}

function useStartEndMarkers(
  engine: MapEngine | null,
  startPoint: { lat: number; lng: number } | null,
  endPoint:   { lat: number; lng: number } | null,
): void {
  useEffect(() => {
    if (!engine) return
    const handles: MarkerHandle[] = []
    if (startPoint) {
      handles.push(engine.addMarker(
        [startPoint.lat, startPoint.lng],
        { kind: 'html', html: '<div class="pin pin-start">A</div>', size: [30, 38], anchor: [15, 38] },
      ))
    }
    if (endPoint) {
      handles.push(engine.addMarker(
        [endPoint.lat, endPoint.lng],
        { kind: 'html', html: '<div class="pin pin-end">B</div>', size: [30, 38], anchor: [15, 38] },
      ))
    }
    return () => { for (const h of handles) engine.removeMarker(h) }
  }, [engine, startPoint, endPoint])
}

function useWaypointMarkers(
  engine: MapEngine | null,
  waypoints: Array<{ lat: number; lng: number }>,
  onRemove: (i: number) => void,
): void {
  useEffect(() => {
    if (!engine) return
    const handles: MarkerHandle[] = waypoints.map((wp, i) =>
      engine.addMarker(
        [wp.lat, wp.lng],
        { kind: 'html', html: '<div class="pin pin-waypoint">+</div>', size: [26, 26], anchor: [13, 26] },
        {
          onClick: () => onRemove(i),
          tooltipHtml: '<span style="font-size:11px">Via point — click to remove</span>',
        },
      ),
    )
    return () => { for (const h of handles) engine.removeMarker(h) }
  }, [engine, waypoints, onRemove])
}

function useFlyToPlaceMarker(
  engine: MapEngine | null,
  flyToPlace: Place | null,
): void {
  useEffect(() => {
    if (!engine || !flyToPlace) return
    const h = engine.addMarker(
      [flyToPlace.lat, flyToPlace.lng],
      { kind: 'html', html: '<div class="pin"></div>', size: [25, 41], anchor: [12, 41] },
    )
    return () => { engine.removeMarker(h) }
  }, [engine, flyToPlace])
}

function useCurrentLocationMarker(
  engine: MapEngine | null,
  currentLocation: { lat: number; lng: number } | null,
  heading: number | null,
): void {
  useEffect(() => {
    if (!engine || !currentLocation) return
    const rotatePart = heading != null ? ` rotate(${heading}deg)` : ''
    const transform = `transform: translate(-50%, -50%)${rotatePart};`
    const html =
      `<div class="current-location-pulse"></div>` +
      `<div class="current-location-turtle" style="${transform}">${TURTLE_SVG}</div>`
    const h = engine.addMarker(
      [currentLocation.lat, currentLocation.lng],
      { kind: 'html', html, className: 'current-location-icon', size: [64, 64], anchor: [32, 32] },
      undefined,
      { zIndexOffset: -100 },
    )
    return () => { engine.removeMarker(h) }
  }, [engine, currentLocation, heading])
}

function useAlternateRoutes(
  engine: MapEngine | null,
  routes: Route[],
  selectedRouteIndex: number,
  onSelectRoute?: (index: number) => void,
): void {
  useEffect(() => {
    if (!engine) return
    const handles: PolylineHandle[] = []
    routes.forEach((altRoute, i) => {
      if (i === selectedRouteIndex) return
      const handlers = onSelectRoute ? {
        onClick: () => onSelectRoute(i),
        tooltipHtml: `<span style="font-size:12px">Route ${i + 1} — click to select</span>`,
      } : undefined
      handles.push(engine.addPolyline(
        altRoute.coordinates,
        { color: '#64748b', weight: 5, opacity: 0.6, dashed: true },
        handlers,
      ))
    })
    return () => { for (const h of handles) engine.removePolyline(h) }
  }, [engine, routes, selectedRouteIndex, onSelectRoute])
}

function useRouteSuggestions(
  engine: MapEngine | null,
  route: Route | null,
  profileKey: string,
  preferredItemNames: Set<string>,
  regionRules: ClassificationRule[] | undefined,
  onAddWaypoint?: (lat: number, lng: number) => void,
): void {
  useEffect(() => {
    if (!engine || !route || route.coordinates.length < 2 || !onAddWaypoint) return

    // Bounding box of the route padded by ~30%, then expanded into a
    // small lat/lng pad. We don't have direct bounds.pad() on engine
    // but we can compute it explicitly.
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
    for (const [lat, lng] of route.coordinates) {
      if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat
      if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng
    }
    const padLat = (maxLat - minLat) * 0.3
    const padLng = (maxLng - minLng) * 0.3
    const padded: [[number, number], [number, number]] = [
      [minLat - padLat, minLng - padLng],
      [maxLat + padLat, maxLng + padLng],
    ]
    const tiles = getVisibleTiles({
      getNorth: () => padded[1][0],
      getSouth: () => padded[0][0],
      getEast:  () => padded[1][1],
      getWest:  () => padded[0][1],
    })

    const allWays: OsmWay[] = []
    for (const t of tiles) {
      const cached = getCachedTile(t.row, t.col)
      if (cached) allWays.push(...cached)
    }
    const THRESHOLD = 0.005
    const routeCoords = route.coordinates
    const suggestions = allWays.filter((way) => {
      const itemName = classifyOsmTagsToItem(way.tags, profileKey, regionRules)
      if (!itemName || !preferredItemNames.has(itemName)) return false
      for (const [wLat, wLng] of way.coordinates) {
        for (const [rLat, rLng] of routeCoords) {
          if (Math.abs(wLat - rLat) < THRESHOLD && Math.abs(wLng - rLng) < THRESHOLD) return true
        }
      }
      return false
    })

    const handles: PolylineHandle[] = []
    for (const way of suggestions) {
      const itemName = classifyOsmTagsToItem(way.tags, profileKey, regionRules)
      const tooltip = `<span style="font-size:11px">${itemName ?? 'Preferred'}` +
        (way.tags.name ? ` — ${way.tags.name}` : '') +
        '<br/><b>Click to route through here</b></span>'
      handles.push(engine.addPolyline(
        way.coordinates,
        { color: '#10b981', weight: 5, opacity: 0.5 },
        {
          onClick: (latLng) => onAddWaypoint(latLng[0], latLng[1]),
          tooltipHtml: tooltip,
        },
      ))
    }
    return () => { for (const h of handles) engine.removePolyline(h) }
  }, [engine, route, profileKey, preferredItemNames, regionRules, onAddWaypoint])
}

function useMapClick(
  engine: MapEngine | null,
  onAddWaypoint?: (lat: number, lng: number) => void,
): void {
  useEffect(() => {
    if (!engine || !onAddWaypoint) return
    const off = engine.on('click', (ev) => {
      if (ev.type === 'click') onAddWaypoint(ev.latLng[0], ev.latLng[1])
    })
    return () => { off() }
  }, [engine, onAddWaypoint])
}

// ── Route polylines + segment selection ────────────────────────────────────

function useRoutePolylines(
  engine: MapEngine | null,
  route: Route | null,
  profileKey: string,
  preferredItemNames: Set<string>,
  selectedIndex: number | null,
  onSelectSegment: (s: SelectedSegment) => void,
): void {
  const settings = useAdminSettings()
  useEffect(() => {
    if (!engine || !route) return
    const handles: PolylineHandle[] = []
    const markerHandles: MarkerHandle[] = []
    if (route.segments?.length) {
      const visible = route.segments
      const HALO_COLOR = '#ffffff'
      const HALO_EXTRA = settings.routeHaloExtra
      const ROUTE_WEIGHT_DEFAULT = settings.routeLineWeight
      const ROUTE_WEIGHT_SELECTED = settings.routeLineWeightSelected

      // Single continuous halo across the whole route — guarantees no
      // visible seam between adjacent same-coloured segments.
      handles.push(engine.addPolyline(
        route.coordinates,
        {
          color: HALO_COLOR,
          weight: ROUTE_WEIGHT_DEFAULT + HALO_EXTRA,
          opacity: 1,
          interactive: false,
        },
      ))

      // Each segment: transparent wide hit polyline FIRST (under the
      // visible line; clicks within ~12px of the line still register),
      // then the visible coloured polyline ON TOP. Both have the same
      // click handler so either path triggers the same selection.
      visible.forEach((seg, i) => {
        const isSelected = selectedIndex === i
        const handleClick = (latLng: EngineLatLng) => onSelectSegment({ seg, index: i, latLng })

        // Hit polyline (added first → bottom z-order). Sized for finger
        // taps — visible line stays visually unchanged.
        handles.push(engine.addPolyline(
          seg.coordinates,
          { color: '#000', weight: HIT_POLYLINE_WEIGHT, opacity: 0 },
          { onClick: handleClick },
        ))

        if (seg.isWalking) {
          const w = isSelected ? ROUTE_WEIGHT_SELECTED : ROUTE_WEIGHT_DEFAULT
          handles.push(engine.addPolyline(
            seg.coordinates,
            { color: WALKING_COLOR, weight: w, opacity: 1 },
            {
              onClick: handleClick,
              tooltipHtml: '<span style="font-size:13px">&#x1F6B6; Walk your bike</span>',
            },
          ))
          return
        }

        const isPreferred = seg.itemName !== null && preferredItemNames.has(seg.itemName)
        const legendItem = getLegendItem(seg.itemName, profileKey)
        const tierLevel = seg.pathLevel ?? legendItem?.level
        const color = tierLevel && isPreferred
          ? colorForLevel(tierLevel, settings.tiers)
          : isPreferred ? PREFERRED_COLOR : OTHER_COLOR
        const weight = isSelected ? ROUTE_WEIGHT_SELECTED : ROUTE_WEIGHT_DEFAULT
        const tooltip = legendItem && !isSelected
          ? `<span style="font-size:13px">${legendItem.icon} ${seg.itemName ?? ''}</span>`
          : undefined
        handles.push(engine.addPolyline(
          seg.coordinates,
          { color, weight, opacity: 1 },
          { onClick: handleClick, tooltipHtml: tooltip },
        ))
      })

      // Segment text labels: coalesced, shown directly on map via
      // text-only divIcon markers.
      coalesceForIcons(visible).forEach((seg, i) => {
        if (seg.coordinates.length < 10) return
        const label = seg.isWalking ? 'Walk' : SHORT_LABELS[seg.itemName ?? '']
        if (!label) return
        const m = midpoint(seg.coordinates)
        markerHandles.push(engine.addMarker(
          m,
          { kind: 'html', html: `<div class="seg-label">${label}</div>`, size: [0, 0], anchor: [0, 10] },
        ))
        // Reference i to suppress unused-var warnings without weakening typing.
        void i
      })
    } else {
      // No segments — render a single blue polyline.
      handles.push(engine.addPolyline(
        route.coordinates,
        { color: '#2563eb', weight: 8, opacity: 0.9 },
      ))
    }

    return () => {
      for (const h of handles) engine.removePolyline(h)
      for (const m of markerHandles) engine.removeMarker(m)
    }
  }, [engine, route, profileKey, preferredItemNames, selectedIndex, settings, onSelectSegment])
}

// ── Floating buttons (recenter + fit-route) ───────────────────────────────

const TURTLE_SVG = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="12" cy="44" rx="7" ry="4.5" fill="#85038c" transform="rotate(-40 12 44)"/>
  <ellipse cx="52" cy="44" rx="7" ry="4.5" fill="#85038c" transform="rotate(40 52 44)"/>
  <ellipse cx="11" cy="22" rx="7" ry="4.5" fill="#85038c" transform="rotate(-140 11 22)"/>
  <ellipse cx="53" cy="22" rx="7" ry="4.5" fill="#85038c" transform="rotate(140 53 22)"/>
  <path d="M 29 52 L 32 58 L 35 52 Z" fill="#85038c"/>
  <circle cx="32" cy="10" r="6" fill="#85038c"/>
  <circle cx="29.5" cy="9.2" r="1" fill="#fff"/>
  <circle cx="34.5" cy="9.2" r="1" fill="#fff"/>
  <circle cx="29.5" cy="9.2" r="0.5" fill="#111"/>
  <circle cx="34.5" cy="9.2" r="0.5" fill="#111"/>
  <ellipse cx="32" cy="32" rx="17" ry="16" fill="#85038c"/>
  <ellipse cx="27" cy="26" rx="6" ry="4" fill="#b956c1" opacity="0.55"/>
  <ellipse cx="32" cy="32" rx="17" ry="16" fill="none" stroke="#4c0252" stroke-width="1.25"/>
  <g stroke="#4c0252" stroke-width="0.9" fill="none" opacity="0.6">
    <path d="M 32 20 L 41 25.5 L 41 38.5 L 32 44 L 23 38.5 L 23 25.5 Z"/>
    <path d="M 32 20 L 32 44"/>
    <path d="M 23 25.5 L 41 38.5"/>
    <path d="M 41 25.5 L 23 38.5"/>
  </g>
</svg>`

function RecenterButton({ engine, currentLocation }: {
  engine: MapEngine | null
  currentLocation: { lat: number; lng: number } | null
}) {
  return (
    <button
      className="recenter-btn"
      // The parent overlay wrapper sets pointer-events: none so map
      // gestures fall through to the engine; this button needs to opt
      // back in or it would be unclickable.
      style={{ pointerEvents: 'auto' }}
      disabled={!currentLocation || !engine}
      title={currentLocation ? 'Center on current location' : 'Location not available'}
      aria-label="Center on current location"
      onClick={() => {
        if (!engine || !currentLocation) return
        const { lat, lng } = currentLocation
        const latDelta = 1 / 111
        const lngDelta = 1 / (111 * Math.cos(lat * Math.PI / 180))
        engine.fitBounds(
          [[lat - latDelta, lng - lngDelta], [lat + latDelta, lng + lngDelta]],
          { animate: true, paddingTopLeft: [0, 0], paddingBottomRight: [0, 0] },
        )
      }}
    >
      <span className="recenter-btn-turtle" dangerouslySetInnerHTML={{ __html: TURTLE_SVG }} />
    </button>
  )
}

function FitRouteButton({ engine, route }: { engine: MapEngine | null; route: Route | null }) {
  if (!route || route.coordinates.length < 2) return null
  return (
    <button
      className="fit-route-btn"
      style={{ pointerEvents: 'auto' }}
      title="Re-fit map to your route"
      aria-label="Re-fit map to your route"
      onClick={() => {
        if (!engine) return
        let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
        for (const [lat, lng] of route.coordinates) {
          if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat
          if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng
        }
        const isMobile = window.innerWidth < 768
        const paddingTopLeft: [number, number] = isMobile ? [40, 100] : [360, 40]
        const paddingBottomRight: [number, number] = isMobile ? [40, Math.round(window.innerHeight * 0.38)] : [40, 40]
        engine.fitBounds([[minLat, minLng], [maxLat, maxLng]], { paddingTopLeft, paddingBottomRight, animate: true })
      }}
    >
      <svg viewBox="0 0 24 24" width="22" height="22" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4"
          stroke="#1f2937" strokeWidth="2" strokeLinecap="round" fill="none" />
        <path d="M8 14c1.5-1 2.5-2 3.5-3.5C12.5 9 13 8 15 8c1.5 0 2 .5 1 2.5"
          stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
        <circle cx="8" cy="14" r="1.6" fill="#10b981" />
        <circle cx="16" cy="10" r="1.6" fill="#ef4444" />
      </svg>
    </button>
  )
}

// ── Top-level Map component ────────────────────────────────────────────────

interface Props {
  startPoint: { lat: number; lng: number; shortLabel?: string } | null
  endPoint: { lat: number; lng: number; shortLabel?: string } | null
  route: Route | null
  routes?: Route[]
  selectedRouteIndex?: number
  waypoints: Array<{ lat: number; lng: number }>
  onRemoveWaypoint: (index: number) => void
  overlayEnabled: boolean
  profileKey: string
  onOverlayStatusChange: (status: string) => void
  currentLocation: { lat: number; lng: number } | null
  currentHeading?: number | null
  preferredItemNames: Set<string>
  showOtherPaths: boolean
  flyToPlace?: Place | null
  regionRules?: ClassificationRule[]
  onSelectRoute?: (index: number) => void
  onAddWaypoint?: (lat: number, lng: number) => void
  onRerouteAround?: (wayIds: number[]) => void
  onFlagSegment?: (seg: RouteSegment) => void
}

export default function Map(props: Props) {
  const {
    startPoint, endPoint, route, routes = [], selectedRouteIndex = 0,
    waypoints, onRemoveWaypoint, overlayEnabled, profileKey,
    onOverlayStatusChange, currentLocation, currentHeading,
    preferredItemNames, showOtherPaths, flyToPlace, regionRules,
    onSelectRoute, onAddWaypoint, onRerouteAround, onFlagSegment,
  } = props

  const settings = useAdminSettings()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [engine, setEngine] = useState<MapEngine | null>(null)

  // Mount the engine once on first render. The chosen kind comes from
  // admin settings; if the kind is changed by the user the page must
  // be reloaded — we don't try to swap engines in place because each
  // adapter has very different lifecycle/teardown semantics.
  useEffect(() => {
    if (!containerRef.current) return
    const env = readEnvKeys()
    const resolved = resolveEngine(
      settings.mapEngine,
      env,
      settings.mapStyle === '' ? undefined : settings.mapStyle,
    )
    const eng = createEngine(resolved.kind)
    let mounted = true
    eng.mount(containerRef.current, {
      center: [52.52, 13.405],
      zoom: 13,
      baseStyle: resolved.baseStyle,
      maptilerKey: env.maptilerKey,
      googleMapsKey: env.googleMapsKey,
      googleShowLandmarks: settings.googleShowLandmarks,
    }).then(() => {
      if (mounted) setEngine(eng)
    }).catch((err) => {
      console.error('[Map] engine mount failed:', err)
    })
    return () => {
      mounted = false
      eng.unmount()
      setEngine(null)
    }
  // Re-mount only when engine, style, or POI toggle change — these all
  // require Google Maps / Leaflet to fully reinitialize. Other settings
  // mutate live via existing effects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.mapEngine, settings.mapStyle, settings.googleShowLandmarks])

  // The previously-selected segment for the popup. Lives in React state
  // because the popup is a React component portaling onto the map div.
  const [selectedSegment, setSelectedSegment] = useState<SelectedSegment | null>(null)

  // Wire all the imperative draws.
  useFitBoundsOnRouteChange(engine, route)
  useCenterOnFirstLocation(engine, currentLocation)
  useFlyToPoint(engine, startPoint, 14, false)
  useFlyToPoint(engine, flyToPlace ?? null, 16, true)
  useStartEndMarkers(engine, startPoint, endPoint)
  useWaypointMarkers(engine, waypoints, onRemoveWaypoint)
  useFlyToPlaceMarker(engine, flyToPlace ?? null)
  useCurrentLocationMarker(engine, currentLocation, currentHeading ?? null)
  useAlternateRoutes(engine, routes, selectedRouteIndex, onSelectRoute)
  useRouteSuggestions(engine, route, profileKey, preferredItemNames, regionRules, onAddWaypoint)
  useMapClick(engine, onAddWaypoint)
  useRoutePolylines(
    engine, route, profileKey, preferredItemNames,
    selectedSegment?.index ?? null, setSelectedSegment,
  )

  return (
    <MapEngineContext.Provider value={engine}>
      {/* Outer wrapper hosts BOTH the engine's container and the React-
          owned overlays as siblings. Don't render the React overlays
          AS CHILDREN of the engine's container — Leaflet / Google
          mutate that container's DOM and React's reconciliation can
          fight with them. */}
      <div style={{ width: '100%', height: '100%', position: 'relative' }}>
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

        {/* React overlays (siblings, absolutely positioned over the
            engine's container). pointer-events: none on the wrapper so
            the engine still receives pan/zoom/click on empty regions;
            individual overlays opt back in when they need clicks. */}
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
          {/* Bike-infra overlay reads the engine via context. */}
          {engine && (
            <BikeMapOverlay
              enabled={overlayEnabled}
              profileKey={profileKey}
              preferredItemNames={preferredItemNames}
              showOtherPaths={showOtherPaths}
              hasRoute={!!route}
              onStatusChange={onOverlayStatusChange}
              regionRules={regionRules}
            />
          )}

          {selectedSegment && engine && (
            <SegmentPopupOverlay
              selected={selectedSegment}
              engine={engine}
              profileKey={profileKey}
              onClose={() => setSelectedSegment(null)}
              onReroute={onRerouteAround}
              onFlag={onFlagSegment}
            />
          )}

          <RecenterButton engine={engine} currentLocation={currentLocation} />
          <FitRouteButton engine={engine} route={route} />
        </div>
      </div>
    </MapEngineContext.Provider>
  )
}
