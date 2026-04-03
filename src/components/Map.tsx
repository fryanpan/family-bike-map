import L from 'leaflet'
import { useEffect, useRef } from 'react'
import { Marker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { PREFERRED_COLOR, OTHER_COLOR, getLegendItem } from '../utils/classify'
import BikeMapOverlay from './BikeMapOverlay'
import type { Route, RouteSegment } from '../utils/types'

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

function makeSegmentIcon(emoji: string): L.DivIcon {
  return L.divIcon({
    html: `<div class="seg-icon">${emoji}</div>`,
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  })
}

function MapCenterController({ currentLocation }: { currentLocation: { lat: number; lng: number } | null }) {
  const map = useMap()
  const hasCentered = useRef(false)

  useEffect(() => {
    if (currentLocation && !hasCentered.current) {
      map.setView([currentLocation.lat, currentLocation.lng], 13)
      hasCentered.current = true
    }
  }, [currentLocation, map])

  return null
}

function FitBoundsController({ route }: { route: Route | null }) {
  const map = useMap()

  useEffect(() => {
    if (!route || route.coordinates.length < 2) return
    const bounds = L.latLngBounds(route.coordinates.map(([lat, lng]) => [lat, lng]))
    map.fitBounds(bounds, { padding: [40, 40] })
  }, [route, map])

  return null
}

function midpoint(coords: [number, number][]): [number, number] {
  return coords[Math.floor(coords.length / 2)]
}

// Route segments are colored green (preferred) or orange (other).
// Other segments are hidden when showOtherPaths is false.
function RouteDisplay({
  route,
  profileKey,
  preferredItemNames,
  showOtherPaths,
}: {
  route: Route | null
  profileKey: string
  preferredItemNames: Set<string>
  showOtherPaths: boolean
}) {
  if (!route) return null

  if (route.segments?.length) {
    const visible = route.segments.filter(
      (seg) => (seg.itemName !== null && preferredItemNames.has(seg.itemName)) || showOtherPaths
    )
    return (
      <>
        {visible.map((seg: RouteSegment, i: number) => {
          const isPreferred = seg.itemName !== null && preferredItemNames.has(seg.itemName)
          const color = isPreferred ? PREFERRED_COLOR : OTHER_COLOR
          const legendItem = getLegendItem(seg.itemName, profileKey)
          return (
            <Polyline
              key={i}
              positions={seg.coordinates}
              color={color}
              weight={12}
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
        {visible
          .filter((seg) => seg.coordinates.length >= 4)
          .map((seg, i) => {
            const legendItem = getLegendItem(seg.itemName, profileKey)
            if (!legendItem) return null
            return (
              <Marker
                key={`icon-${i}`}
                position={midpoint(seg.coordinates)}
                icon={makeSegmentIcon(legendItem.icon)}
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
      weight={12}
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
  waypoints: Array<{ lat: number; lng: number }>
  onRemoveWaypoint: (index: number) => void
  overlayEnabled: boolean
  profileKey: string
  onOverlayStatusChange: (status: string) => void
  currentLocation: { lat: number; lng: number } | null
  preferredItemNames: Set<string>
  showOtherPaths: boolean
}

export default function Map({
  startPoint,
  endPoint,
  route,
  waypoints,
  onRemoveWaypoint,
  overlayEnabled,
  profileKey,
  onOverlayStatusChange,
  currentLocation,
  preferredItemNames,
  showOtherPaths,
}: Props) {
  return (
    <MapContainer
      center={[52.52, 13.405]}
      zoom={13}
      style={{ width: '100%', height: '100%' }}
    >
      <MapCenterController currentLocation={currentLocation} />
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
        onStatusChange={onOverlayStatusChange}
      />

      <RouteDisplay
        route={route}
        profileKey={profileKey}
        preferredItemNames={preferredItemNames}
        showOtherPaths={showOtherPaths}
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
