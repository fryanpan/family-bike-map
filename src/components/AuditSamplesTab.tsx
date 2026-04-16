import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
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

// ── Lightbox with prev/next carousel ────────────────────────────────────

function Lightbox({
  items,
  index,
  onClose,
  onNav,
}: {
  items: FoundImage[]
  index: number
  onClose: () => void
  onNav: (idx: number) => void
}) {
  const touchStartX = useRef<number | null>(null)
  const item = items[index]

  const goPrev = useCallback(() => {
    if (index > 0) onNav(index - 1)
  }, [index, onNav])

  const goNext = useCallback(() => {
    if (index < items.length - 1) onNav(index + 1)
  }, [index, items.length, onNav])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') goPrev()
      if (e.key === 'ArrowRight') goNext()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, goPrev, goNext])

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
  }
  const onTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    if (dx > 60) goPrev()
    else if (dx < -60) goNext()
    touchStartX.current = null
  }

  const tags = TAG_KEYS.filter((k) => item.way.tags[k]).map((k) => `${k}=${item.way.tags[k]}`)

  return (
    <div className="lb-backdrop" onClick={onClose}>
      <div
        className="lb-container"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <button className="lb-close" onClick={onClose}>×</button>

        {/* Counter */}
        <div className="lb-counter">{index + 1} / {items.length}</div>

        {/* Prev arrow */}
        {index > 0 && (
          <button className="lb-arrow lb-arrow-left" onClick={goPrev}>‹</button>
        )}

        {/* Image */}
        <img src={item.image.thumbUrl} alt="" className="lb-img" />

        {/* Next arrow */}
        {index < items.length - 1 && (
          <button className="lb-arrow lb-arrow-right" onClick={goNext}>›</button>
        )}

        {/* Meta bar */}
        <div className="lb-meta">
          {item.way.tags.name && <div className="lb-name">{item.way.tags.name}</div>}
          <div className="lb-tags">
            {tags.map((t, i) => <span key={i} className="lb-tag">{t}</span>)}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── ClassCard: one infrastructure type ──────────────────────────────────

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

  const target = expanded ? EXPANDED_IMAGES : INITIAL_IMAGES
  const visible = found.slice(0, target)
  const hasMore = found.length > INITIAL_IMAGES && !expanded

  const openLightbox = useCallback((i: number) => setLightboxIdx(i), [])
  const closeLightbox = useCallback(() => setLightboxIdx(null), [])
  const navLightbox = useCallback((i: number) => setLightboxIdx(i), [])

  return (
    <div className={`sc${isPreferred ? ' sc-preferred' : ''}`}>
      {/* Header row */}
      <div className="sc-header">
        <span className="sc-title">{classification}</span>
        <span className="sc-count">{ways.length} ways</span>
        {(hasMore || expanded) && (
          <button className="sc-toggle" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Show less' : `Show more (${found.length})`}
          </button>
        )}
      </div>

      {/* Image grid: 3 columns collapsed, 3 columns expanded (but more rows) */}
      <div className="sc-images">
        {visible.map((s, i) => (
          <div key={i} className="sc-img-wrap" onClick={() => openLightbox(i)}>
            <img src={s.image.thumbUrl} alt={classification} loading="lazy" />
            <div className="sc-img-label">
              {s.way.tags.name && <span>{s.way.tags.name}</span>}
            </div>
          </div>
        ))}
        {searching && visible.length < target && (
          <div className="sc-img-wrap sc-img-loading">
            <div className="spinner" style={{ width: 20, height: 20 }} />
          </div>
        )}
      </div>

      {lightboxIdx !== null && found[lightboxIdx] && (
        <Lightbox
          items={found}
          index={lightboxIdx}
          onClose={closeLightbox}
          onNav={navLightbox}
        />
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
    <div className="st">
      <div className="st-controls">
        <label className="st-label">Travel Mode</label>
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
        <div className="st-section">
          <h2 className="st-heading st-heading-pref">Preferred</h2>
          {[...preferred.entries()].map(([cls, ways]) => (
            <ClassCard key={cls} classification={cls} ways={ways} isPreferred />
          ))}
        </div>
      )}

      {other.size > 0 && (
        <div className="st-section">
          <h2 className="st-heading st-heading-other">Other</h2>
          {[...other.entries()].map(([cls, ways]) => (
            <ClassCard key={cls} classification={cls} ways={ways} isPreferred={false} />
          ))}
        </div>
      )}
    </div>
  )
}
