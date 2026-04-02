import L from 'leaflet'
import { useEffect, useRef } from 'react'
import { Marker, MapContainer, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { SAFETY } from '../utils/classify'
import type { LegendLevel } from '../utils/classify'
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

function midpoint(coords: [number, number][]): [number, number] {
  return coords[Math.floor(coords.length / 2)]
}

// All route segments are always fully visible — not affected by legend toggles.
function RouteDisplay({ route }: { route: Route | null }) {
  if (!route) return null

  if (route.segments?.length) {
    return (
      <>
        {route.segments.map((seg: RouteSegment, i: number) => {
          const s = SAFETY[seg.safetyClass] ?? SAFETY.avoid
          return (
            <Polyline
              key={i}
              positions={seg.coordinates}
              color={s.color}
              weight={12}
              opacity={0.95}
            >
              <Tooltip sticky direction="top" offset={[0, -6]}>
                <span style={{ fontSize: 13 }}>{s.icon} {s.label}</span>
              </Tooltip>
            </Polyline>
          )
        })}
        {route.segments
          .filter((seg) => seg.coordinates.length >= 4)
          .map((seg, i) => {
            const s = SAFETY[seg.safetyClass] ?? SAFETY.avoid
            return (
              <Marker
                key={`icon-${i}`}
                position={midpoint(seg.coordinates)}
                icon={makeSegmentIcon(s.icon)}
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
  hiddenLevels: Set<LegendLevel>
  currentLocation: { lat: number; lng: number } | null
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
  hiddenLevels,
  currentLocation,
}: Props) {
  return (
    <MapContainer
      center={[52.52, 13.405]}
      zoom={13}
      style={{ width: '100%', height: '100%' }}
    >
      <MapCenterController currentLocation={currentLocation} />
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      <BikeMapOverlay
        enabled={overlayEnabled}
        profileKey={profileKey}
        hiddenLevels={hiddenLevels}
        onStatusChange={onOverlayStatusChange}
      />

      <RouteDisplay route={route} />

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
