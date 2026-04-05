import { useState, useEffect, useMemo, useRef } from 'react'
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet'
import L from 'leaflet'
import { getStreetImage } from '../services/mapillary'
import type { MapillaryImage } from '../services/mapillary'
import type { AuditGroup, AuditWay } from '../services/audit'
import { PROFILE_LEGEND } from '../utils/classify'
import { saveRules } from '../services/rules'
import type { RegionRules, ClassificationRule } from '../services/rules'

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

type ImageState = { loading: true } | { loading: false; image: MapillaryImage | null }

/** Collect all unique legend item names across all profiles. */
function getAllLegendItemNames(): string[] {
  const names = new Set<string>()
  for (const groups of Object.values(PROFILE_LEGEND)) {
    for (const group of groups) {
      for (const item of group.items) {
        names.add(item.name)
      }
    }
  }
  return [...names].sort()
}

const LEGEND_ITEM_NAMES = getAllLegendItemNames()

interface Props {
  group: AuditGroup
  region: string
  rules: RegionRules
  onRulesChange: (rules: RegionRules) => void
}

export default function AuditGroupDetail({ group, region, rules, onRulesChange }: Props) {
  const [images, setImages] = useState<Map<number, ImageState>>(new Map())
  const [expandedImage, setExpandedImage] = useState<string | null>(null)
  const [reviewed, setReviewed] = useState(false)
  const [overrideOpen, setOverrideOpen] = useState(false)
  const overrideRef = useRef<HTMLDivElement>(null)

  const samplesWithCenter = useMemo(
    () => group.samples.filter((s) => s.center),
    [group.samples],
  )

  // Fetch Mapillary images for each sample
  useEffect(() => {
    const stateMap = new Map<number, ImageState>()
    for (const s of samplesWithCenter) {
      stateMap.set(s.osmId, { loading: true })
    }
    setImages(new Map(stateMap))
    setExpandedImage(null)

    let cancelled = false
    for (const s of samplesWithCenter) {
      getStreetImage(s.center!.lat, s.center!.lon).then((img) => {
        if (cancelled) return
        setImages((prev) => {
          const next = new Map(prev)
          next.set(s.osmId, { loading: false, image: img })
          return next
        })
      })
    }
    return () => { cancelled = true }
  }, [samplesWithCenter])

  // Close override dropdown on outside click
  useEffect(() => {
    if (!overrideOpen) return
    function handleClick(e: MouseEvent) {
      if (overrideRef.current && !overrideRef.current.contains(e.target as Node)) {
        setOverrideOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [overrideOpen])

  /** Build a match object from the group's tag signature (e.g. "highway=cycleway surface=asphalt"). */
  function buildMatchFromSignature(): Record<string, string> {
    const match: Record<string, string> = {}
    for (const part of group.signature.split(/\s+/)) {
      const eq = part.indexOf('=')
      if (eq > 0) {
        match[part.slice(0, eq)] = part.slice(eq + 1)
      }
    }
    return match
  }

  async function handleOverride(classification: string) {
    setOverrideOpen(false)
    const newRule: ClassificationRule = {
      match: buildMatchFromSignature(),
      classification,
      travelModes: {},
    }
    const updated: RegionRules = {
      ...rules,
      rules: [...rules.rules, newRule],
    }
    await saveRules(region, updated)
    onRulesChange(updated)
  }

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

      {/* Mapillary images */}
      <div className="audit-images">
        {samplesWithCenter.map((s) => {
          const state = images.get(s.osmId)
          if (!state || state.loading) {
            return <div key={s.osmId} className="audit-thumb audit-thumb-loading" />
          }
          if (!state.image) {
            return (
              <div key={s.osmId} className="audit-thumb audit-thumb-none">
                No image
              </div>
            )
          }
          return (
            <img
              key={s.osmId}
              className="audit-thumb"
              src={state.image.thumbUrl}
              alt={`Street view near way ${s.osmId}`}
              onClick={() => setExpandedImage(
                expandedImage === state.image!.thumbUrl ? null : state.image!.thumbUrl,
              )}
            />
          )
        })}
      </div>

      {/* Expanded image */}
      {expandedImage && (
        <img
          className="audit-image-expanded"
          src={expandedImage}
          alt="Street view expanded"
          onClick={() => setExpandedImage(null)}
        />
      )}

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

      {/* Review actions */}
      <div className="audit-actions">
        <button
          className={`audit-action-btn audit-action-correct${reviewed ? ' audit-action-reviewed' : ''}`}
          onClick={() => setReviewed(true)}
        >
          {reviewed ? '\u2714 Correct' : 'Correct'}
        </button>
        <div className="audit-override-wrap" ref={overrideRef}>
          <button
            className="audit-action-btn audit-action-override"
            onClick={() => setOverrideOpen((v) => !v)}
          >
            Override &#x25BE;
          </button>
          {overrideOpen && (
            <ul className="audit-override-menu">
              {LEGEND_ITEM_NAMES.map((name) => (
                <li key={name}>
                  <button
                    className="audit-override-option"
                    onClick={() => handleOverride(name)}
                  >
                    {name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button disabled className="audit-action-btn audit-action-flag">Flag</button>
      </div>
    </div>
  )
}
