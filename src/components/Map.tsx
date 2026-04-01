import L from 'leaflet'
import { Marker, MapContainer, Polyline, TileLayer, Tooltip, useMapEvents } from 'react-leaflet'
import { SAFETY, PROFILE_LEGEND } from '../utils/classify'
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

function ClickHandler({ onClick }: { onClick: (latlng: L.LatLng) => void }) {
  useMapEvents({ click: (e) => onClick(e.latlng) })
  return null
}

function EditModeButton({ editMode, onToggle }: { editMode: boolean; onToggle: () => void }) {
  return (
    <button
      className={`edit-mode-btn${editMode ? ' edit-mode-active' : ''}`}
      onClick={onToggle}
      title={editMode ? 'Exit edit mode' : 'Activate to tap map and set points'}
    >
      ✏️ {editMode ? 'Editing' : 'Edit'}
    </button>
  )
}

function midpoint(coords: [number, number][]): [number, number] {
  return coords[Math.floor(coords.length / 2)]
}

function RouteDisplay({ route }: { route: Route | null }) {
  if (!route) return null

  if (route.segments?.length) {
    return (
      <>
        {route.segments.map((seg: RouteSegment, i: number) => {
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
        {route.segments
          .filter((seg) => seg.coordinates.length >= 4)
          .map((seg, i) => {
            const s = SAFETY[seg.safetyClass] ?? SAFETY.acceptable
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
      weight={5}
      opacity={0.85}
    />
  )
}

function Legend({
  segments,
  overlayOn,
  profileKey,
}: {
  segments: RouteSegment[] | null
  overlayOn: boolean
  profileKey: string
}) {
  // Profile-aware legend: show per-profile great/ok/bad groups when route loaded or overlay on.
  const profileGroups = PROFILE_LEGEND[profileKey]
  const hasRoute = segments && segments.length > 0
  const showLegend = hasRoute || overlayOn

  if (!showLegend) return null

  // When showing a route, only show levels that actually appear in the segments.
  const presentClasses = hasRoute
    ? new Set(segments!.map((s) => s.safetyClass))
    : null

  // Map safety classes to profile levels to know which levels appear in the route.
  const levelAppears = (level: string): boolean => {
    if (!presentClasses) return true
    const levelToClasses: Record<string, string[]> = {
      great: ['great', 'good'],
      ok:    ['ok', 'acceptable'],
      bad:   ['caution', 'avoid'],
    }
    return (levelToClasses[level] ?? []).some((c) => (presentClasses as Set<string>).has(c))
  }

  if (profileGroups) {
    const visibleGroups = profileGroups.filter((g) => levelAppears(g.level))
    if (!visibleGroups.length) return null
    return (
      <div className="map-legend">
        {visibleGroups.map((group) => (
          <div key={group.level} className="legend-group">
            <div className="legend-level-row">
              <span className="legend-dot" style={{ background: group.color }} />
              <span className="legend-level-label">{group.label}</span>
            </div>
            {group.items.map((item) => (
              <div key={item.name} className="legend-item legend-item-sub">
                <span className="legend-icon">{item.icon}</span>
                <span className="legend-text">{item.name}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    )
  }

  // Fallback: show raw safety classes for unknown profiles
  const classes = segments
    ? [...new Set(segments.map((s) => s.safetyClass))]
    : (Object.keys(SAFETY) as (keyof typeof SAFETY)[])
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

interface Props {
  startPoint: { lat: number; lng: number; shortLabel?: string } | null
  endPoint: { lat: number; lng: number; shortLabel?: string } | null
  route: Route | null
  waypoints: Array<{ lat: number; lng: number }>
  onMapClick: (latlng: L.LatLng) => void
  onRemoveWaypoint: (index: number) => void
  overlayEnabled: boolean
  profileKey: string
  onOverlayStatusChange: (status: string) => void
  editMode: boolean
  onToggleEditMode: () => void
  legendVisible?: boolean
}

export default function Map({
  startPoint,
  endPoint,
  route,
  waypoints,
  onMapClick,
  onRemoveWaypoint,
  overlayEnabled,
  profileKey,
  onOverlayStatusChange,
  editMode,
  onToggleEditMode,
  legendVisible = true,
}: Props) {
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

      {editMode && <ClickHandler onClick={onMapClick} />}

      <BikeMapOverlay enabled={overlayEnabled} profileKey={profileKey} onStatusChange={onOverlayStatusChange} />

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
          eventHandlers={editMode ? { click: () => onRemoveWaypoint(i) } : {}}
        >
        </Marker>
      ))}

      {legendVisible && <Legend segments={routeSegments} overlayOn={overlayEnabled} profileKey={profileKey} />}

      <EditModeButton editMode={editMode} onToggle={onToggleEditMode} />
    </MapContainer>
  )
}
