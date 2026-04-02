import React, { useState } from 'react'
import L from 'leaflet'
import { Marker, MapContainer, Polyline, TileLayer, Tooltip, useMapEvents } from 'react-leaflet'
import { SAFETY, PROFILE_LEGEND, SAFETY_LEVEL } from '../utils/classify'
import type { LegendLevel } from '../utils/classify'
import BikeMapOverlay from './BikeMapOverlay'
import type { Route, RouteSegment, SafetyClass } from '../utils/types'

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

// Official Fahrradstrasse sign (Zeichen 244.1): blue circle with white bicycle
function FahrradstrasseSign() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
      <circle cx="8" cy="8" r="8" fill="#1565C0"/>
      <circle cx="4.5" cy="11" r="2.2" fill="none" stroke="white" strokeWidth="1.2"/>
      <circle cx="11.5" cy="11" r="2.2" fill="none" stroke="white" strokeWidth="1.2"/>
      <path d="M4.5 11 L7 7.5 L11.5 11" fill="none" stroke="white" strokeWidth="1.1"/>
      <path d="M7 7.5 L9 7.5" stroke="white" strokeWidth="1.1"/>
      <path d="M9 7.5 L11.5 6.5" stroke="white" strokeWidth="1.1"/>
      <path d="M7 7.5 L6.5 6.8 L8.5 6.8" fill="none" stroke="white" strokeWidth="1"/>
      <circle cx="8.5" cy="6" r="1" fill="white"/>
    </svg>
  )
}

// Separated bike path icon: elevated bike lane beside car lane
function SeparatedPathSign() {
  return (
    <svg width="22" height="14" viewBox="0 0 22 14" style={{ flexShrink: 0 }}>
      <rect x="0" y="0" width="22" height="6.5" rx="1" fill="#dbeafe"/>
      <rect x="0" y="8" width="22" height="6" rx="1" fill="#f1f5f9"/>
      <rect x="0" y="6" width="22" height="2" fill="#94a3b8"/>
      <circle cx="5" cy="3.2" r="1.8" fill="none" stroke="#0ea5e9" strokeWidth="1"/>
      <circle cx="10" cy="3.2" r="1.8" fill="none" stroke="#0ea5e9" strokeWidth="1"/>
      <path d="M5 3.2 L7 1.2 L10 3.2" fill="none" stroke="#0ea5e9" strokeWidth="1"/>
      <path d="M8 1.8 L10 1.2" stroke="#0ea5e9" strokeWidth="1"/>
      <rect x="13" y="8.8" width="7" height="3.5" rx="1" fill="#94a3b8"/>
      <rect x="14" y="8" width="5" height="2.5" rx="0.5" fill="#cbd5e1"/>
    </svg>
  )
}

const LEGEND_ICON_OVERRIDE: Record<string, React.ReactNode> = {
  'Fahrradstrasse':                      <FahrradstrasseSign />,
  'Separated bike track':                <SeparatedPathSign />,
  'Separated bike track (narrow)':       <SeparatedPathSign />,
  'Separated bike track (slow)':         <SeparatedPathSign />,
}

function midpoint(coords: [number, number][]): [number, number] {
  return coords[Math.floor(coords.length / 2)]
}

function RouteDisplay({
  route,
  hiddenSafetyClasses,
}: {
  route: Route | null
  hiddenSafetyClasses: Set<SafetyClass>
}) {
  if (!route) return null

  if (route.segments?.length) {
    const visible = route.segments.filter((seg) => !hiddenSafetyClasses.has(seg.safetyClass))
    return (
      <>
        {visible.map((seg: RouteSegment, i: number) => {
          const s = SAFETY[seg.safetyClass] ?? SAFETY.avoid
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
        {visible
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
      weight={5}
      opacity={0.85}
    />
  )
}

// Check mark SVG for toggle boxes
function CheckMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" style={{ display: 'block' }}>
      <polyline points="1.5,5 4,7.5 8.5,2" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function Legend({
  segments,
  overlayOn,
  profileKey,
  hiddenSafetyClasses,
  onToggleSafetyClass,
  onToggleGroup,
}: {
  segments: RouteSegment[] | null
  overlayOn: boolean
  profileKey: string
  hiddenSafetyClasses: Set<SafetyClass>
  onToggleSafetyClass: (cls: SafetyClass) => void
  onToggleGroup: (level: LegendLevel) => void
}) {
  const profileGroups = PROFILE_LEGEND[profileKey]
  const hasRoute = segments && segments.length > 0
  const showLegend = hasRoute || overlayOn

  if (!showLegend) return null

  // When showing a route, only show levels that actually appear in the segments.
  const presentClasses = hasRoute
    ? new Set(segments!.map((s) => s.safetyClass))
    : null

  const levelAppears = (level: string): boolean => {
    if (!presentClasses) return true
    const levelToClasses: Record<string, string[]> = {
      good: ['great', 'good'],
      ok:   ['ok'],
      bad:  ['avoid'],
    }
    return (levelToClasses[level] ?? []).some((c) => (presentClasses as Set<string>).has(c))
  }

  if (profileGroups) {
    const visibleGroups = profileGroups.filter((g) => levelAppears(g.level))
    if (!visibleGroups.length) return null

    return (
      <div className="map-legend">
        {visibleGroups.map((group) => {
          // Group is "checked" if at least one item in it is visible
          const groupSafetyClasses = [...new Set(group.items.map((i) => i.safetyClass))]
          const allHidden = groupSafetyClasses.every((c) => hiddenSafetyClasses.has(c))
          const groupChecked = !allHidden

          return (
            <div key={group.level} className={`legend-group${allHidden ? ' legend-group-hidden' : ''}`}>
              <button
                className="legend-group-toggle"
                onClick={() => onToggleGroup(group.level)}
                title={`${groupChecked ? 'Hide' : 'Show'} ${group.label} paths`}
              >
                <span className={`legend-toggle-box${groupChecked ? ' checked' : ''}`}>
                  {groupChecked && <CheckMark />}
                </span>
                <span className="legend-level-label">{group.label}</span>
              </button>
              {group.items.map((item) => {
                const itemColor = SAFETY[item.safetyClass]?.color ?? '#888'
                const itemChecked = !hiddenSafetyClasses.has(item.safetyClass)
                const iconNode = LEGEND_ICON_OVERRIDE[item.name] ?? (
                  <span className="legend-icon">{item.icon}</span>
                )
                return (
                  <button
                    key={item.name}
                    className={`legend-item legend-item-toggle${itemChecked ? '' : ' legend-item-off'}`}
                    onClick={() => onToggleSafetyClass(item.safetyClass)}
                    title={`${itemChecked ? 'Hide' : 'Show'} ${item.name}`}
                  >
                    <span className={`legend-toggle-box legend-toggle-box-sm${itemChecked ? ' checked' : ''}`}>
                      {itemChecked && <CheckMark />}
                    </span>
                    <span className="legend-dot" style={{ background: itemColor }} />
                    {iconNode}
                    <span className="legend-text">{item.name}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    )
  }

  // Fallback: show raw safety classes for unknown profiles (non-interactive)
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
  legendVisible = true,
}: Props) {
  const routeSegments = route?.segments ?? null

  // Default: 'avoid' safetyClass hidden (bad paths off)
  const [hiddenSafetyClasses, setHiddenSafetyClasses] = useState<Set<SafetyClass>>(
    () => new Set<SafetyClass>(['avoid'])
  )

  // Compute hidden LegendLevels from hidden safetyClasses (for overlay filtering)
  const hiddenLevels = new Set<LegendLevel>(
    [...hiddenSafetyClasses].map((cls) => SAFETY_LEVEL[cls])
  )

  function toggleSafetyClass(cls: SafetyClass) {
    setHiddenSafetyClasses((prev) => {
      const next = new Set(prev)
      if (next.has(cls)) next.delete(cls)
      else next.add(cls)
      return next
    })
  }

  function toggleGroup(level: LegendLevel) {
    const profileGroups = PROFILE_LEGEND[profileKey]
    if (!profileGroups) return
    const group = profileGroups.find((g) => g.level === level)
    if (!group) return
    const groupClasses = [...new Set(group.items.map((i) => i.safetyClass))]
    const allHidden = groupClasses.every((c) => hiddenSafetyClasses.has(c))
    setHiddenSafetyClasses((prev) => {
      const next = new Set(prev)
      if (allHidden) {
        // All hidden → show all
        groupClasses.forEach((c) => next.delete(c))
      } else {
        // Some or all visible → hide all
        groupClasses.forEach((c) => next.add(c))
      }
      return next
    })
  }

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

      <BikeMapOverlay
        enabled={overlayEnabled}
        profileKey={profileKey}
        hiddenLevels={hiddenLevels}
        onStatusChange={onOverlayStatusChange}
      />

      <RouteDisplay route={route} hiddenSafetyClasses={hiddenSafetyClasses} />

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

      {legendVisible && (
        <Legend
          segments={routeSegments}
          overlayOn={overlayEnabled}
          profileKey={profileKey}
          hiddenSafetyClasses={hiddenSafetyClasses}
          onToggleSafetyClass={toggleSafetyClass}
          onToggleGroup={toggleGroup}
        />
      )}
    </MapContainer>
  )
}
