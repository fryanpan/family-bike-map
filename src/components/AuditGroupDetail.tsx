import { useEffect, useMemo } from 'react'
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet'
import L from 'leaflet'
import type { AuditGroup, AuditWay } from '../services/audit'

// Re-use Leaflet default icon fix from Map.tsx
import markerIconUrl from 'leaflet/dist/images/marker-icon.png'
import markerIcon2xUrl from 'leaflet/dist/images/marker-icon-2x.png'
import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png'
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: markerIconUrl,
  iconRetinaUrl: markerIcon2xUrl,
  shadowUrl: markerShadowUrl,
})

/** Auto-fit map bounds to show all markers */
function FitSampleBounds({ samples }: { samples: AuditWay[] }) {
  const map = useMap()

  useEffect(() => {
    const pts = samples
      .filter((s) => s.center)
      .map((s) => [s.center!.lat, s.center!.lon] as [number, number])
    if (pts.length === 0) return
    if (pts.length === 1) {
      map.setView(pts[0], 15)
    } else {
      map.fitBounds(L.latLngBounds(pts), { padding: [24, 24] })
    }
  }, [samples, map])

  return null
}

interface Props {
  group: AuditGroup
}

export default function AuditGroupDetail({ group }: Props) {
  const samplesWithCenter = useMemo(
    () => group.samples.filter((s) => s.center),
    [group.samples],
  )

  const defaultCenter: [number, number] = samplesWithCenter.length > 0
    ? [samplesWithCenter[0].center!.lat, samplesWithCenter[0].center!.lon]
    : [52.52, 13.405]

  return (
    <div className="audit-detail">
      {/* Mini Leaflet map */}
      <div className="audit-mini-map">
        <MapContainer
          center={defaultCenter}
          zoom={14}
          style={{ width: '100%', height: '100%' }}
          zoomControl={false}
          attributionControl={false}
        >
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <FitSampleBounds samples={group.samples} />
          {samplesWithCenter.map((s) => (
            <Marker key={s.osmId} position={[s.center!.lat, s.center!.lon]} />
          ))}
        </MapContainer>
      </div>

      {/* Sample tag tables */}
      <div className="audit-samples">
        {group.samples.map((s) => (
          <div key={s.osmId} className="audit-sample">
            <div className="audit-sample-header">
              way/{s.osmId}
              {s.center && (
                <span className="audit-sample-coords">
                  {s.center.lat.toFixed(4)}, {s.center.lon.toFixed(4)}
                </span>
              )}
            </div>
            <div className="audit-sample-tags">
              {Object.entries(s.tags).map(([k, v]) => (
                <span key={k} className="audit-tag">
                  {k}=<b>{v}</b>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Placeholder review actions */}
      <div className="audit-actions">
        <button disabled className="audit-action-btn audit-action-correct">Correct</button>
        <button disabled className="audit-action-btn audit-action-override">Override &#x25BE;</button>
        <button disabled className="audit-action-btn audit-action-flag">Flag</button>
      </div>
    </div>
  )
}
