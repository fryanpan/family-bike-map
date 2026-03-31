import L from 'leaflet'
import { Marker, MapContainer, Polyline, Popup, TileLayer, Tooltip, useMapEvents } from 'react-leaflet'
import { SAFETY } from '../utils/classify.js'
import BikeMapOverlay from './BikeMapOverlay.jsx'

// Fix Leaflet default icons broken by Vite's asset bundling
import markerIconUrl from 'leaflet/dist/images/marker-icon.png'
import markerIcon2xUrl from 'leaflet/dist/images/marker-icon-2x.png'
import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png'
delete L.Icon.Default.prototype._getIconUrl
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

function makeSegmentIcon(emoji) {
  return L.divIcon({
    html: `<div class="seg-icon">${emoji}</div>`,
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  })
}

function ClickHandler({ onClick }) {
  useMapEvents({ click: (e) => onClick(e.latlng) })
  return null
}

/** Midpoint of an array of [lat,lng] coords */
function midpoint(coords) {
  const mid = Math.floor(coords.length / 2)
  return coords[mid]
}

/** Render route as colored segments (from trace_attributes) or plain blue polyline */
function RouteDisplay({ route }) {
  if (!route) return null

  // Colored segments available
  if (route.segments?.length) {
    return (
      <>
        {route.segments.map((seg, i) => {
          const s = SAFETY[seg.safetyClass] ?? SAFETY.acceptable
          return (
            <Polyline
              key={i}
              positions={seg.coordinates}
              color={s.color}
              weight={6}
              opacity={0.9}
            >
              <Tooltip sticky direction="top" offset={[0, -6]}>
                <span style={{ fontSize: 13 }}>{s.icon} {s.label}</span>
              </Tooltip>
            </Polyline>
          )
        })}
        {/* Path type icons at segment midpoints (skip very short segments) */}
        {route.segments
          .filter((seg) => seg.coordinates.length >= 4)
          .map((seg, i) => {
            const s = SAFETY[seg.safetyClass] ?? SAFETY.acceptable
            const mid = midpoint(seg.coordinates)
            return (
              <Marker key={`icon-${i}`} position={mid} icon={makeSegmentIcon(s.icon)} />
            )
          })}
      </>
    )
  }

  // Fallback: plain blue polyline while segments are loading
  return (
    <Polyline
      positions={route.coordinates}
      color="#2563eb"
      weight={5}
      opacity={0.85}
    />
  )
}

/** Legend overlay — shown bottom-right when route has colored segments or overlay is on */
function Legend({ segments, overlayOn }) {
  // Collect which safety classes are present in the route segments
  const classes = segments
    ? [...new Set(segments.map((s) => s.safetyClass))]
    : overlayOn
    ? Object.keys(SAFETY)
    : []

  if (!classes.length) return null

  return (
    <div className="map-legend">
      {classes.map((cls) => {
        const s = SAFETY[cls]
        return (
          <div key={cls} className="legend-item">
            <span className="legend-dot" style={{ background: s.color }} />
            <span className="legend-text">{s.icon} {s.label}</span>
          </div>
        )
      })}
    </div>
  )
}

export default function Map({
  startPoint,
  endPoint,
  route,
  waypoints,
  onMapClick,
  onRemoveWaypoint,
  overlayEnabled,
  onOverlayStatusChange,
}) {
  const routeSegments = route?.segments ?? null

  return (
    <MapContainer
      center={[52.52, 13.405]}
      zoom={13}
      style={{ width: '100%', height: '100%' }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      <ClickHandler onClick={onMapClick} />

      {/* Bike infrastructure overlay */}
      <BikeMapOverlay enabled={overlayEnabled} onStatusChange={onOverlayStatusChange} />

      {/* Route */}
      <RouteDisplay route={route} />

      {/* Start marker */}
      {startPoint && (
        <Marker position={[startPoint.lat, startPoint.lng]} icon={startIcon}>
          <Popup>{startPoint.shortLabel || 'Start'}</Popup>
        </Marker>
      )}

      {/* End marker */}
      {endPoint && (
        <Marker position={[endPoint.lat, endPoint.lng]} icon={endIcon}>
          <Popup>{endPoint.shortLabel || 'End'}</Popup>
        </Marker>
      )}

      {/* Waypoint markers */}
      {waypoints.map((wp, i) => (
        <Marker key={i} position={[wp.lat, wp.lng]} icon={waypointIcon}>
          <Popup>
            <strong>Waypoint {i + 1}</strong>
            <br />
            <button style={{ marginTop: 4, cursor: 'pointer' }} onClick={() => onRemoveWaypoint(i)}>
              Remove
            </button>
          </Popup>
        </Marker>
      ))}

      {/* Legend */}
      <Legend segments={routeSegments} overlayOn={overlayEnabled} />
    </MapContainer>
  )
}
