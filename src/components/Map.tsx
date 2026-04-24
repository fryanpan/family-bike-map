import L from 'leaflet'
import { useEffect, useRef, useMemo, useState } from 'react'
import { Marker, MapContainer, Polyline, Popup, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { PREFERRED_COLOR, OTHER_COLOR, getLegendItem } from '../utils/classify'
import { classifyEdge, PATH_LEVEL_LABELS } from '../utils/lts'
import { colorForLevel } from './SimpleLegend'
import { useAdminSettings } from '../services/adminSettings'
import { getVisibleTiles, getCachedTile, latLngToTile, classifyOsmTagsToItem } from '../services/overpass'
import { getStreetViewUrl } from '../services/streetview'
import BikeMapOverlay from './BikeMapOverlay'
import type { ClassificationRule } from '../services/rules'
import type { Place, Route, RouteSegment, OsmWay } from '../utils/types'

// Fix Leaflet default icons broken by Vite's asset bundling
import markerIconUrl from 'leaflet/dist/images/marker-icon.png'
import markerIcon2xUrl from 'leaflet/dist/images/marker-icon-2x.png'
import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png'
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: markerIconUrl,
  iconRetinaUrl: markerIcon2xUrl,
  shadowUrl: markerShadowUrl,
})

const startIcon = L.divIcon({
  html: '<div class="pin pin-start">A</div>',
  className: '',
  iconSize: [30, 38],
  iconAnchor: [15, 38],
})
const endIcon = L.divIcon({
  html: '<div class="pin pin-end">B</div>',
  className: '',
  iconSize: [30, 38],
  iconAnchor: [15, 38],
})
const waypointIcon = L.divIcon({
  html: '<div class="pin pin-waypoint">+</div>',
  className: '',
  iconSize: [26, 26],
  iconAnchor: [13, 26],
})

// Short labels for segment types — shown directly on the map instead of emoji icons
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

function makeTextLabel(text: string): L.DivIcon {
  return L.divIcon({
    html: `<div class="seg-label">${text}</div>`,
    className: '',
    iconSize: [0, 0],
    iconAnchor: [0, 10],
  })
}

function MapCenterController({ currentLocation }: { currentLocation: { lat: number; lng: number } | null }) {
  const map = useMap()
  const hasCentered = useRef(false)

  useEffect(() => {
    if (currentLocation && !hasCentered.current) {
      map.setView([currentLocation.lat, currentLocation.lng], 14)
      hasCentered.current = true
    }
  }, [currentLocation, map])

  return null
}

/** Navigate the map to a point when it changes. Deduplicates by lat/lng. */
function MapMoveController({ point, zoom, animate }: {
  point: { lat: number; lng: number } | null
  zoom: number
  animate?: boolean
}) {
  const map = useMap()
  const prevRef = useRef<{ lat: number; lng: number } | null>(null)

  useEffect(() => {
    if (!point) return
    if (prevRef.current?.lat === point.lat && prevRef.current?.lng === point.lng) return
    prevRef.current = point
    if (animate) {
      map.flyTo([point.lat, point.lng], zoom, { duration: 0.8 })
    } else {
      map.setView([point.lat, point.lng], zoom)
    }
  }, [point, map, zoom, animate])

  return null
}

function FitBoundsController({ route }: { route: Route | null }) {
  const map = useMap()

  useEffect(() => {
    if (!route || route.coordinates.length < 2) return
    const bounds = L.latLngBounds(route.coordinates.map(([lat, lng]) => [lat, lng]))
    // Asymmetric padding to account for floating panels:
    // Mobile: top routing header (~80px), bottom route list (~200px)
    // Desktop: left panel (~360px)
    const isMobile = window.innerWidth < 768
    const paddingTopLeft: [number, number] = isMobile ? [40, 100] : [360, 40]
    const paddingBottomRight: [number, number] = isMobile ? [40, Math.round(window.innerHeight * 0.38)] : [40, 40]
    map.fitBounds(bounds, { paddingTopLeft, paddingBottomRight })
  }, [route, map])

  return null
}

function midpoint(coords: [number, number][]): [number, number] {
  return coords[Math.floor(coords.length / 2)]
}

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

/**
 * Coalesce nearby same-type segments for icon placement.
 * Merges segments of the same itemName when the gap between them is <= gapM meters.
 * Returns coalesced segments with combined coordinates — used only for icon placement,
 * not for polyline rendering (which stays pixel-accurate).
 */
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
      // Merge: extend prev with curr's coordinates
      prev.coordinates = [...prev.coordinates, ...curr.coordinates]
    } else {
      result.push({ ...curr, coordinates: [...curr.coordinates] })
    }
  }
  return result
}

const WALKING_COLOR = '#6b7280' // gray for walk-your-bike segments

// Route segments are colored green (preferred) or orange (other).
// Walking segments render as dashed gray lines.
// ALL segments are always shown — the showOtherPaths toggle controls the overlay, not the route.
/**
 * Popup shown when the user taps a route segment. Displays the segment's
 * classification, a Mapillary street-view image (fetched async), the
 * relevant OSM tags, and the reroute-around / flag-as-wrong actions.
 *
 * Used in both pre-nav routing and in-ride navigation states — the user
 * can report a bad segment either before starting or while riding past
 * it, since either context lets them judge whether the classifier was
 * right about it.
 */
/**
 * Find the OSM way in cached tiles whose path most closely matches the
 * given route segment. "Matches" = smallest sum of per-coord Manhattan
 * distances from the segment's sample points to the way's coords. We
 * sample up to 5 evenly-spaced points along the segment so long
 * segments don't get dominated by the endpoints.
 *
 * This is more accurate than matching a single click point because:
 *   - one segment can be made of multiple adjacent ways; we want the
 *     way the SEGMENT traverses, not a tangentially-nearby way
 *   - click lands anywhere on the drawn polyline; the segment itself
 *     is the actual source of truth
 *
 * Searches the tile containing the segment's midpoint + its 8 neighbors.
 * Returns null if no ways are cached nearby.
 */
function findNearestWayToSegment(segCoords: [number, number][]): { way: OsmWay; distance: number } | null {
  if (segCoords.length === 0) return null

  // Sample up to 5 points along the segment
  const sampleCount = Math.min(5, segCoords.length)
  const samples: Array<[number, number]> = []
  for (let i = 0; i < sampleCount; i++) {
    const idx = Math.round((i * (segCoords.length - 1)) / Math.max(1, sampleCount - 1))
    samples.push(segCoords[idx])
  }

  // Use the midpoint to pick which tiles to search
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
        // For each sample, find its nearest distance to this way.
        // Sum those distances — the best-matching way has the smallest sum.
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

function SegmentPopup({
  seg,
  latlng,
  profileKey,
  onClose,
  onReroute,
  onFlag,
}: {
  seg: RouteSegment
  latlng: [number, number]
  profileKey: string
  onClose: () => void
  onReroute?: (wayIds: number[]) => void
  onFlag?: (seg: RouteSegment) => void
}) {
  const [imgUrl, setImgUrl] = useState<string | null>(null)
  const [imgLoading, setImgLoading] = useState(true)

  // Resolve the OsmWay that best matches this segment's path. Matching
  // against the whole segment (not a single click point) gives tags
  // and reroute targets that describe what the segment ACTUALLY is,
  // not a tangentially-nearby way. More accurate than seg.wayIds when
  // buildSegments coalesces multiple source ways or drops them.
  const nearest = useMemo(() => findNearestWayToSegment(seg.coordinates), [seg])
  const wayToAvoid: number | null = nearest?.way.osmId ?? null
  const tags: Record<string, string> = nearest?.way.tags ?? {}

  // Street-view midpoint is the segment midpoint, not the click point.
  // If the user clicked near the end of a long segment, we still want
  // an image representative of the segment as a whole.
  const segMid: [number, number] = seg.coordinates.length > 0
    ? seg.coordinates[Math.floor(seg.coordinates.length / 2)]
    : latlng

  useEffect(() => {
    // Street View Static is served directly as an <img src>; no async
    // fetch needed. Load state stops at "loading" until the img onLoad
    // fires (handled by the <img> below).
    setImgUrl(getStreetViewUrl(segMid[0], segMid[1], { size: '400x240' }))
    setImgLoading(false)
  }, [segMid])

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

  // LTS tier + plain-language description for the popover. Derived from
  // the same classifyEdge() the router uses — one classifier, one truth.
  const { pathLevel } = classifyEdge(tags)
  const levelInfo = PATH_LEVEL_LABELS[pathLevel]

  // Reroute-around: prefer the way resolved at click time; otherwise
  // fall back to the segment's full wayIds list (older behavior).
  const rerouteWayIds: number[] = wayToAvoid != null
    ? [wayToAvoid]
    : (seg.wayIds ?? [])

  return (
    <Popup
      position={latlng}
      className="segment-popup"
      eventHandlers={{ remove: onClose }}
    >
      <div className="segment-popup-body">
        <div className="segment-popup-title">{title}</div>
        {tags.name && (
          <div className="segment-popup-name">{tags.name}</div>
        )}

        <div className="segment-popup-lts">
          <span className="segment-popup-lts-tag">LTS {pathLevel}</span>
          <span className="segment-popup-lts-name">{levelInfo.short}</span>
          <div className="segment-popup-lts-desc">{levelInfo.description}</div>
        </div>

        {imgLoading && <div className="segment-popup-img-loading">Loading street view…</div>}
        {!imgLoading && imgUrl && (
          <img src={imgUrl} alt="Street view" className="segment-popup-img" loading="lazy" />
        )}
        {!imgLoading && !imgUrl && (
          <div className="segment-popup-img-missing">No street view available nearby.</div>
        )}

        {tagRows.length > 0 && (
          <div className="segment-popup-tags">
            {tagRows.map((r, i) => (
              <div key={i} className="segment-popup-tag">{r}</div>
            ))}
          </div>
        )}

        <div className="segment-popup-actions">
          {onReroute && rerouteWayIds.length > 0 && (
            <button
              className="segment-popup-btn segment-popup-btn-primary"
              onClick={() => { onReroute(rerouteWayIds); onClose() }}
            >
              ↩ Reroute around
            </button>
          )}
          {onFlag && (
            <button
              className="segment-popup-btn"
              onClick={() => { onFlag(seg); onClose() }}
            >
              🚩 Flag as wrong
            </button>
          )}
        </div>
      </div>
    </Popup>
  )
}

function RouteDisplay({
  route,
  profileKey,
  preferredItemNames,
  onRerouteAround,
  onFlagSegment,
}: {
  route: Route | null
  profileKey: string
  preferredItemNames: Set<string>
  onRerouteAround?: (wayIds: number[]) => void
  onFlagSegment?: (seg: RouteSegment) => void
}) {
  const settings = useAdminSettings()
  // Selected segment for popup (shared across pre-nav and nav).
  // latlng is the click point; the popup anchors there.
  const [selected, setSelected] = useState<{
    seg: RouteSegment
    index: number
    latlng: [number, number]
  } | null>(null)

  if (!route) return null

  if (route.segments?.length) {
    const visible = route.segments
    // Route rendering is a two-layer stack:
    //   1. ONE continuous white halo polyline that spans the entire route
    //      (using route.coordinates). A single line means no gaps between
    //      segments, and no per-segment halo differences to expose white
    //      seams at tier transitions.
    //   2. Per-segment colored polylines on top, so each tier can render
    //      in its own color and carry click-to-reroute affordance.
    // All segments use the SAME line weight — tier distinction is color
    // only. Walking segments render solid gray (no dashes) with a tooltip
    // explaining "walk your bike."
    const HALO_COLOR = '#ffffff'
    const HALO_EXTRA = settings.routeHaloExtra
    const ROUTE_WEIGHT_DEFAULT = settings.routeLineWeight
    const ROUTE_WEIGHT_SELECTED = settings.routeLineWeightSelected
    return (
      <>
        {/* Single continuous halo for the whole route. */}
        <Polyline
          positions={route.coordinates}
          color={HALO_COLOR}
          weight={ROUTE_WEIGHT_DEFAULT + HALO_EXTRA}
          opacity={1}
          interactive={false}
        />
        {/* Colored layer on top — per-segment so tier colors render. */}
        {visible.map((seg: RouteSegment, i: number) => {
          if (seg.isWalking) {
            return (
              <Polyline
                key={i}
                positions={seg.coordinates}
                color={WALKING_COLOR}
                weight={selected?.index === i ? ROUTE_WEIGHT_SELECTED : ROUTE_WEIGHT_DEFAULT}
                opacity={1}
                eventHandlers={{
                  click: (e) => {
                    setSelected({ seg, index: i, latlng: [e.latlng.lat, e.latlng.lng] })
                  },
                }}
              >
                <Tooltip sticky direction="top" offset={[0, -6]}>
                  <span style={{ fontSize: 13 }}>&#x1F6B6; Walk your bike</span>
                </Tooltip>
              </Polyline>
            )
          }
          const isPreferred = seg.itemName !== null && preferredItemNames.has(seg.itemName)
          const legendItem = getLegendItem(seg.itemName, profileKey)
          const isSelected = selected?.index === i
          // Color from seg.pathLevel (populated in clientRouter from the
          // same classifyEdge() the overlay uses) so a way can't render
          // one color here and a different color in the overlay. Fall
          // back to the legend-item-derived level only if pathLevel is
          // missing (shouldn't happen for routes built post-2026-04-24).
          const tierLevel = seg.pathLevel ?? legendItem?.level
          const color = tierLevel && isPreferred
            ? colorForLevel(tierLevel, settings.tiers)
            : isPreferred ? PREFERRED_COLOR : OTHER_COLOR
          const weight = isSelected ? ROUTE_WEIGHT_SELECTED : ROUTE_WEIGHT_DEFAULT
          return (
            <Polyline
              key={i}
              positions={seg.coordinates}
              color={color}
              weight={weight}
              opacity={1}
              eventHandlers={{
                click: (e) => {
                  setSelected({ seg, index: i, latlng: [e.latlng.lat, e.latlng.lng] })
                },
              }}
            >
              {legendItem && !isSelected && (
                <Tooltip sticky direction="top" offset={[0, -6]}>
                  <span style={{ fontSize: 13 }}>{legendItem.icon} {seg.itemName}</span>
                </Tooltip>
              )}
            </Polyline>
          )
        })}
        {selected && (
          <SegmentPopup
            seg={selected.seg}
            latlng={selected.latlng}
            profileKey={profileKey}
            onClose={() => setSelected(null)}
            onReroute={onRerouteAround}
            onFlag={onFlagSegment}
          />
        )}
        {/* Segment text labels: coalesced, shown directly on map */}
        {coalesceForIcons(visible)
          .filter((seg) => seg.coordinates.length >= 10)
          .map((seg, i) => {
            if (seg.isWalking) {
              return (
                <Marker
                  key={`label-${i}`}
                  position={midpoint(seg.coordinates)}
                  icon={makeTextLabel('Walk')}
                />
              )
            }
            const label = SHORT_LABELS[seg.itemName ?? '']
            if (!label) return null
            return (
              <Marker
                key={`label-${i}`}
                position={midpoint(seg.coordinates)}
                icon={makeTextLabel(label)}
              />
            )
          })}
      </>
    )
  }

  return (
    <Polyline
      positions={route.coordinates}
      color="#2563eb"
      weight={8}
      opacity={0.9}
    />
  )
}

/**
 * Overhead-view baby turtle, reused for both the on-map current-location
 * marker and the recenter-on-me button so the two read as the same object.
 * Drawn in a 64×64 viewBox — facing north by default so rotating by
 * `heading` (0 = north, clockwise) aims the head in the direction of
 * travel.
 */
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

/** Build a current-location divIcon. Rotates the whole turtle by `heading`
 *  (0 = north, clockwise) so the head points in the direction of travel.
 *  When heading is null the turtle stays oriented north and the pulse ring
 *  conveys "I know where you are but not which way you're facing." */
function makeCurrentLocationIcon(heading: number | null): L.DivIcon {
  const rotatePart = heading != null ? ` rotate(${heading}deg)` : ''
  const transform = `transform: translate(-50%, -50%)${rotatePart};`
  return L.divIcon({
    html: `<div class="current-location-pulse"></div><div class="current-location-turtle" style="${transform}">${TURTLE_SVG}</div>`,
    className: 'current-location-icon',
    iconSize: [64, 64],
    iconAnchor: [32, 32],
  })
}

/**
 * Recenter-on-current-location control. Rendered inside the
 * MapContainer so it gets access to useMap. Button sits above the
 * leaflet zoom buttons; disabled until a location is available.
 */
function RecenterButton({ currentLocation }: { currentLocation: { lat: number; lng: number } | null }) {
  const map = useMap()
  return (
    <button
      className="recenter-btn"
      disabled={!currentLocation}
      title={currentLocation ? 'Center on current location' : 'Location not available'}
      aria-label="Center on current location"
      onClick={() => {
        if (!currentLocation) return
        // Zoom to ~1 km in each direction (2 km total span) regardless
        // of the user's current zoom. Uses fitBounds so the aspect-ratio
        // adjustment happens automatically for portrait vs landscape.
        const { lat, lng } = currentLocation
        const latDelta = 1 / 111                       // ~1 km lat
        const lngDelta = 1 / (111 * Math.cos(lat * Math.PI / 180)) // ~1 km lng at this lat
        map.fitBounds(
          [[lat - latDelta, lng - lngDelta], [lat + latDelta, lng + lngDelta]],
          { animate: true, padding: [0, 0] },
        )
      }}
    >
      <span className="recenter-btn-turtle" dangerouslySetInnerHTML={{ __html: TURTLE_SVG }} />
    </button>
  )
}

/**
 * Show preferred infrastructure segments near the route as clickable suggestions.
 * Click a suggestion to add a waypoint at that point, forcing the route through it.
 */
function RouteSuggestions({ route, profileKey, preferredItemNames, regionRules, onAddWaypoint }: {
  route: Route | null
  profileKey: string
  preferredItemNames: Set<string>
  regionRules?: ClassificationRule[]
  onAddWaypoint: (lat: number, lng: number) => void
}) {
  const map = useMap()

  const suggestions = useMemo(() => {
    if (!route || route.coordinates.length < 2) return []

    // Get all cached tile data in the route's bounding area
    const bounds = L.latLngBounds(route.coordinates.map(([lat, lng]) => [lat, lng] as [number, number]))
    const padded = bounds.pad(0.3) // expand by 30% to catch nearby segments
    const tiles = getVisibleTiles(padded)

    const allWays: OsmWay[] = []
    for (const t of tiles) {
      const cached = getCachedTile(t.row, t.col)
      if (cached) allWays.push(...cached)
    }

    // Filter to preferred segments within ~500m of the route
    const THRESHOLD = 0.005 // ~500m in degrees
    const routeCoords = route.coordinates

    return allWays.filter((way) => {
      const itemName = classifyOsmTagsToItem(way.tags, profileKey, regionRules)
      if (!itemName || !preferredItemNames.has(itemName)) return false

      // Check if any point of this way is near the route
      for (const [wLat, wLng] of way.coordinates) {
        for (const [rLat, rLng] of routeCoords) {
          if (Math.abs(wLat - rLat) < THRESHOLD && Math.abs(wLng - rLng) < THRESHOLD) {
            return true
          }
        }
      }
      return false
    })
  }, [route, profileKey, preferredItemNames, regionRules, map])

  if (suggestions.length === 0) return null

  return (
    <>
      {suggestions.map((way, i) => (
        <Polyline
          key={`suggest-${way.osmId ?? i}`}
          positions={way.coordinates}
          color="#10b981"
          weight={5}
          opacity={0.5}
          eventHandlers={{
            click: (e) => {
              L.DomEvent.stopPropagation(e.originalEvent)
              onAddWaypoint(e.latlng.lat, e.latlng.lng)
            },
          }}
        >
          <Tooltip sticky direction="top" offset={[0, -6]}>
            <span style={{ fontSize: 11 }}>
              {classifyOsmTagsToItem(way.tags, profileKey, regionRules) ?? 'Preferred'}
              {way.tags.name ? ` — ${way.tags.name}` : ''}
              <br /><b>Click to route through here</b>
            </span>
          </Tooltip>
        </Polyline>
      ))}
    </>
  )
}

function MapClickHandler({ onAddWaypoint }: { onAddWaypoint?: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      if (onAddWaypoint) {
        onAddWaypoint(e.latlng.lat, e.latlng.lng)
      }
    },
  })
  return null
}

const waypointAddIcon = L.divIcon({
  html: '<div class="pin pin-waypoint">+</div>',
  className: '',
  iconSize: [26, 26],
  iconAnchor: [13, 26],
})

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

export default function Map({
  startPoint,
  endPoint,
  route,
  routes = [],
  selectedRouteIndex = 0,
  waypoints,
  onRemoveWaypoint,
  overlayEnabled,
  profileKey,
  onOverlayStatusChange,
  currentLocation,
  currentHeading,
  preferredItemNames,
  showOtherPaths,
  flyToPlace,
  regionRules,
  onSelectRoute,
  onAddWaypoint,
  onRerouteAround,
  onFlagSegment,
}: Props) {
  return (
    <MapContainer
      center={[52.52, 13.405]}
      zoom={13}
      style={{ width: '100%', height: '100%' }}
    >
      <MapClickHandler onAddWaypoint={onAddWaypoint} />
      <MapCenterController currentLocation={currentLocation} />
      <MapMoveController point={startPoint} zoom={14} />
      <MapMoveController point={flyToPlace ?? null} zoom={16} animate />
      <FitBoundsController route={route} />
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      <BikeMapOverlay
        enabled={overlayEnabled}
        profileKey={profileKey}
        preferredItemNames={preferredItemNames}
        showOtherPaths={showOtherPaths}
        hasRoute={!!route}
        onStatusChange={onOverlayStatusChange}
        regionRules={regionRules}
      />

      {/* Alternate routes — visible but subdued, clickable to select */}
      {routes.map((altRoute, i) => {
        if (i === selectedRouteIndex) return null
        return (
          <Polyline
            key={`alt-${i}`}
            positions={altRoute.coordinates}
            color="#64748b"
            weight={5}
            opacity={0.6}
            dashArray="10 6"
            eventHandlers={onSelectRoute ? {
              click: (e) => { L.DomEvent.stopPropagation(e.originalEvent); onSelectRoute(i) },
            } : undefined}
          >
            <Tooltip sticky direction="top" offset={[0, -6]}>
              <span style={{ fontSize: 12 }}>Route {i + 1} — click to select</span>
            </Tooltip>
          </Polyline>
        )
      })}

      {/* Preferred segments near route — clickable to add waypoints */}
      {onAddWaypoint && (
        <RouteSuggestions
          route={route}
          profileKey={profileKey}
          preferredItemNames={preferredItemNames}
          regionRules={regionRules}
          onAddWaypoint={onAddWaypoint}
        />
      )}

      {/* Selected route (prominent, rendered on top) */}
      <RouteDisplay
        route={route}
        profileKey={profileKey}
        preferredItemNames={preferredItemNames}
        onRerouteAround={onRerouteAround}
        onFlagSegment={onFlagSegment}
      />

      {startPoint && (
        <Marker position={[startPoint.lat, startPoint.lng]} icon={startIcon}>
        </Marker>
      )}

      {endPoint && (
        <Marker position={[endPoint.lat, endPoint.lng]} icon={endIcon}>
        </Marker>
      )}

      {waypoints.map((wp, i) => (
        <Marker key={i} position={[wp.lat, wp.lng]} icon={waypointIcon}
          eventHandlers={{ click: () => onRemoveWaypoint(i) }}
        >
          <Tooltip direction="top" offset={[0, -20]}>
            <span style={{ fontSize: 11 }}>Via point — click to remove</span>
          </Tooltip>
        </Marker>
      ))}

      {flyToPlace && (
        <Marker position={[flyToPlace.lat, flyToPlace.lng]} />
      )}

      {currentLocation && (
        <Marker
          position={[currentLocation.lat, currentLocation.lng]}
          icon={makeCurrentLocationIcon(currentHeading ?? null)}
          zIndexOffset={-100}
        />
      )}

      <RecenterButton currentLocation={currentLocation} />
    </MapContainer>
  )
}
