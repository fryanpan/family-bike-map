import L from 'leaflet'
import { useEffect, useRef } from 'react'
import { Marker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { PREFERRED_COLOR, OTHER_COLOR, getLegendItem } from '../utils/classify'
import BikeMapOverlay from './BikeMapOverlay'
import type { ClassificationRule } from '../services/rules'
import type { Place, Route, RouteSegment } from '../utils/types'

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
  'Rough surface': 'Rough',
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
function RouteDisplay({
  route,
  profileKey,
  preferredItemNames,
}: {
  route: Route | null
  profileKey: string
  preferredItemNames: Set<string>
}) {
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
                weight={14}
                opacity={0.85}
                dashArray="8 8"
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
          return (
            <Polyline
              key={i}
              positions={seg.coordinates}
              color={color}
              weight={16}
              opacity={0.95}
            >
              {legendItem && (
                <Tooltip sticky direction="top" offset={[0, -6]}>
                  <span style={{ fontSize: 13 }}>{legendItem.icon} {seg.itemName}</span>
                </Tooltip>
              )}
            </Polyline>
          )
        })}
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
}: Props) {
  return (
    <MapContainer
      center={[52.52, 13.405]}
      zoom={13}
      style={{ width: '100%', height: '100%' }}
    >
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
            weight={8}
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

      {/* Selected route (prominent) */}
      <RouteDisplay
        route={route}
        profileKey={profileKey}
        preferredItemNames={preferredItemNames}
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
