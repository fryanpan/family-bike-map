import L from 'leaflet'
import { useEffect, useRef, useMemo, useState } from 'react'
import { Marker, MapContainer, Polyline, Popup, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { PREFERRED_COLOR, OTHER_COLOR, getLegendItem } from '../utils/classify'
import { getVisibleTiles, getCachedTile, latLngToTile, classifyOsmTagsToItem } from '../services/overpass'
import { getStreetImage } from '../services/mapillary'
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

  useEffect(() => {
    let cancelled = false
    setImgLoading(true)
    getStreetImage(latlng[0], latlng[1]).then((img) => {
      if (cancelled) return
      setImgUrl(img?.thumbUrl ?? null)
      setImgLoading(false)
    }).catch(() => { if (!cancelled) setImgLoading(false) })
    return () => { cancelled = true }
  }, [latlng])

  // Look up the way's OSM tags from cached tiles so the popup can show
  // classification signals (surface, cycleway, speed) that help the
  // user judge whether the classifier was right.
  const tagSummary = useMemo(() => {
    const wayId = seg.wayIds?.[0]
    if (wayId == null) return null
    const { row, col } = latLngToTile(latlng[0], latlng[1])
    const tile = getCachedTile(row, col)
    if (!tile) return null
    const way = tile.find((w) => w.osmId === wayId)
    if (!way) return null
    const tags = way.tags
    const rows: string[] = []
    if (tags.highway) rows.push(`highway=${tags.highway}`)
    if (tags.cycleway) rows.push(`cycleway=${tags.cycleway}`)
    if (tags['cycleway:right']) rows.push(`cycleway:right=${tags['cycleway:right']}`)
    if (tags['cycleway:left']) rows.push(`cycleway:left=${tags['cycleway:left']}`)
    if (tags.surface) rows.push(`surface=${tags.surface}`)
    if (tags.maxspeed) rows.push(`maxspeed=${tags.maxspeed}`)
    if (tags.bicycle_road === 'yes') rows.push('bicycle_road=yes')
    return { rows, name: tags.name }
  }, [seg, latlng])

  const legendItem = getLegendItem(seg.itemName, profileKey)
  const title = seg.isWalking
    ? '🚶 Walk your bike here'
    : `${legendItem?.icon ?? ''} ${seg.itemName ?? 'Route segment'}`

  return (
    <Popup
      position={latlng}
      className="segment-popup"
      eventHandlers={{ remove: onClose }}
    >
      <div className="segment-popup-body">
        <div className="segment-popup-title">{title}</div>
        {tagSummary?.name && (
          <div className="segment-popup-name">{tagSummary.name}</div>
        )}

        {imgLoading && <div className="segment-popup-img-loading">Loading street view…</div>}
        {!imgLoading && imgUrl && (
          <img src={imgUrl} alt="Street view" className="segment-popup-img" loading="lazy" />
        )}
        {!imgLoading && !imgUrl && (
          <div className="segment-popup-img-missing">No street view available for this segment.</div>
        )}

        {tagSummary && tagSummary.rows.length > 0 && (
          <div className="segment-popup-tags">
            {tagSummary.rows.map((r, i) => (
              <div key={i} className="segment-popup-tag">{r}</div>
            ))}
          </div>
        )}

        <div className="segment-popup-actions">
          {onReroute && (seg.wayIds?.length ?? 0) > 0 && (
            <button
              className="segment-popup-btn segment-popup-btn-primary"
              onClick={() => { onReroute(seg.wayIds ?? []); onClose() }}
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
    return (
      <>
        {visible.map((seg: RouteSegment, i: number) => {
          if (seg.isWalking) {
            return (
              <Polyline
                key={i}
                positions={seg.coordinates}
                color={WALKING_COLOR}
                weight={selected?.index === i ? 16 : 14}
                opacity={0.85}
                dashArray="8 8"
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
          const color = isPreferred ? PREFERRED_COLOR : OTHER_COLOR
          const legendItem = getLegendItem(seg.itemName, profileKey)
          const isSelected = selected?.index === i
          return (
            <Polyline
              key={i}
              positions={seg.coordinates}
              color={color}
              weight={isSelected ? 18 : 16}
              opacity={isSelected ? 1 : 0.95}
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
      weight={16}
      opacity={0.9}
    />
  )
}

const currentLocationIcon = L.divIcon({
  html: '<div class="current-location-dot"><div class="current-location-pulse"></div></div>',
  className: '',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
})

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
          weight={10}
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
            weight={10}
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
          icon={currentLocationIcon}
          zIndexOffset={-100}
        />
      )}

    </MapContainer>
  )
}
