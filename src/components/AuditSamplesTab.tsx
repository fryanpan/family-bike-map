import { useState, useEffect, useMemo, useCallback } from 'react'
import { getStreetImage } from '../services/mapillary'
import { getDefaultPreferredItems } from '../utils/classify'
import type { MapillaryImage } from '../services/mapillary'
import type { CityScan, AuditWay } from '../services/audit'
import { classifyOsmTagsToItem } from '../services/overpass'
import type { ClassificationRule } from '../services/rules'

interface Props {
  scan: CityScan | null
  regionRules?: ClassificationRule[]
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

const INITIAL_IMAGES = 3
const EXPANDED_IMAGES = 12
const TAG_KEYS = ['highway', 'cycleway', 'cycleway:right', 'cycleway:left', 'cycleway:both', 'surface', 'smoothness', 'maxspeed', 'bicycle', 'segregated', 'bicycle_road']

interface FoundImage {
  way: AuditWay
  image: MapillaryImage
}

// ── Lightbox: full-screen image + tags ──────────────────────────────────

function Lightbox({ item, onClose }: { item: FoundImage; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const tags = TAG_KEYS.filter((k) => item.way.tags[k]).map((k) => `${k}=${item.way.tags[k]}`)

  return (
    <div className="samples-lightbox" onClick={onClose}>
      <div className="samples-lightbox-inner" onClick={(e) => e.stopPropagation()}>
        <button className="samples-lightbox-close" onClick={onClose}>×</button>
        <img src={item.image.thumbUrl} alt="" className="samples-lightbox-img" />
        <div className="samples-lightbox-meta">
          {item.way.tags.name && <div className="samples-lightbox-name">{item.way.tags.name}</div>}
          <div className="samples-lightbox-tags">
            {tags.map((t, i) => <span key={i} className="samples-tag">{t}</span>)}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── ClassCard: one infrastructure type as a compact card ────────────────

function ClassCard({
  classification,
  ways,
  isPreferred,
}: {
  classification: string
  ways: AuditWay[]
  isPreferred: boolean
}) {
  const [found, setFound] = useState<FoundImage[]>([])
  const [searching, setSearching] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [lightboxIdx, setLightboxIdx] = useState<number | null>(null)

  const target = expanded ? EXPANDED_IMAGES : INITIAL_IMAGES
  const candidates = useMemo(() => shuffle(ways.filter((w) => w.center)), [ways])

  useEffect(() => {
    let cancelled = false
    setFound([])
    setSearching(true)

    async function search() {
      const results: FoundImage[] = []
      for (let i = 0; i < candidates.length && results.length < EXPANDED_IMAGES; i += 5) {
        const batch = candidates.slice(i, i + 5)
        const images = await Promise.all(
          batch.map((w) => getStreetImage(w.center!.lat, w.center!.lon))
        )
        for (let j = 0; j < batch.length; j++) {
          if (cancelled) return
          if (images[j]) results.push({ way: batch[j], image: images[j]! })
        }
        if (!cancelled) setFound([...results])
        if (results.length >= EXPANDED_IMAGES) break
      }
      if (!cancelled) setSearching(false)
    }

    search()
    return () => { cancelled = true }
  }, [candidates])

  const visible = found.slice(0, target)
  const hasMore = found.length > INITIAL_IMAGES && !expanded
  const closeLightbox = useCallback(() => setLightboxIdx(null), [])

  return (
    <div className={`samples-card${isPreferred ? ' samples-card-preferred' : ''}`}>
      <div className="samples-card-header" onClick={() => setExpanded(!expanded)}>
        <span className="samples-card-title">{classification}</span>
        <span className="samples-card-count">{ways.length} ways</span>
        {hasMore && <span className="samples-card-expand">Show more</span>}
        {expanded && <span className="samples-card-expand">Show less</span>}
      </div>

      <div className={`samples-card-grid${expanded ? ' samples-card-grid-expanded' : ''}`}>
        {visible.map((s, i) => (
          <div key={i} className="samples-thumb" onClick={() => setLightboxIdx(i)}>
            <img src={s.image.thumbUrl} alt={classification} loading="lazy" />
            <div className="samples-thumb-overlay">
              {s.way.tags.name && <span className="samples-thumb-name">{s.way.tags.name}</span>}
            </div>
          </div>
        ))}
        {searching && visible.length < target && (
          <div className="samples-thumb samples-thumb-loading">
            <div className="spinner" style={{ width: 18, height: 18 }} />
          </div>
        )}
      </div>

      {lightboxIdx !== null && visible[lightboxIdx] && (
        <Lightbox item={visible[lightboxIdx]} onClose={closeLightbox} />
      )}
    </div>
  )
}

// ── Main tab ────────────────────────────────────────────────────────────

export default function AuditSamplesTab({ scan, regionRules }: Props) {
  const [travelMode, setTravelMode] = useState('kid-starting-out')

  const { preferred, other } = useMemo(() => {
    if (!scan) return { preferred: new Map<string, AuditWay[]>(), other: new Map<string, AuditWay[]>() }

    const preferredItems = getDefaultPreferredItems(travelMode)
    const prefMap = new Map<string, AuditWay[]>()
    const otherMap = new Map<string, AuditWay[]>()

    for (const group of scan.groups) {
      const sampleTags = group.samples[0]?.tags
      const cls = sampleTags
        ? (classifyOsmTagsToItem(sampleTags, travelMode, regionRules) ?? 'Unclassified')
        : (group.classification ?? 'Unclassified')
      const isPreferred = preferredItems.has(cls)
      const map = isPreferred ? prefMap : otherMap
      const existing = map.get(cls) ?? []
      existing.push(...group.samples.filter((w) => w.center))
      map.set(cls, existing)
    }

    const sortBySize = (a: [string, AuditWay[]], b: [string, AuditWay[]]) => b[1].length - a[1].length
    return {
      preferred: new Map([...prefMap.entries()].sort(sortBySize)),
      other: new Map([...otherMap.entries()].sort(sortBySize)),
    }
  }, [scan, travelMode, regionRules])

  if (!scan) {
    return <div className="audit-empty">Scan a city first to see samples by class.</div>
  }

  return (
    <div className="samples-tab">
      <div className="samples-controls">
        <label className="samples-label">Travel Mode</label>
        <select
          className="audit-select"
          value={travelMode}
          onChange={(e) => setTravelMode(e.target.value)}
        >
          <option value="kid-starting-out">Kid starting out</option>
          <option value="kid-confident">Kid confident</option>
          <option value="kid-traffic-savvy">Kid traffic-savvy</option>
          <option value="carrying-kid">Carrying kid</option>
          <option value="training">Training</option>
        </select>
      </div>

      {preferred.size > 0 && (
        <div className="samples-section">
          <h2 className="samples-section-title samples-section-preferred">Preferred</h2>
          <div className="samples-grid">
            {[...preferred.entries()].map(([cls, ways]) => (
              <ClassCard key={cls} classification={cls} ways={ways} isPreferred />
            ))}
          </div>
        </div>
      )}

      {other.size > 0 && (
        <div className="samples-section">
          <h2 className="samples-section-title samples-section-other">Other</h2>
          <div className="samples-grid">
            {[...other.entries()].map(([cls, ways]) => (
              <ClassCard key={cls} classification={cls} ways={ways} isPreferred={false} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
