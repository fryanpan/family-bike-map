import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { getStreetImage } from '../services/mapillary'
import { getDefaultPreferredItems } from '../utils/classify'
import type { MapillaryImage } from '../services/mapillary'
import type { CityScan, AuditWay } from '../services/audit'
import { classifyOsmTagsToItem } from '../services/overpass'
import type { ClassificationRule } from '../services/rules'
import { classifyEdge, PATH_LEVELS, PATH_LEVEL_LABELS } from '../utils/lts'
import type { PathLevel, LtsClassification } from '../utils/lts'
import { MODE_RULES, applyModeRule } from '../data/modes'
import type { RideMode, ModeDecision } from '../data/modes'

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

const INITIAL_IMAGES = 6
const EXPANDED_IMAGES = 18
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
  note,
}: {
  classification: string
  ways: AuditWay[]
  isPreferred: boolean
  note?: string
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
      {note && <div className="sc-note">{note}</div>}

      {/* Image grid: 6 columns on desktop (see .sc-images CSS). */}
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

type Bucket = 'preferred' | 'not-preferred'

// Bucket a group by the router's ACTUAL decision, not just by level.
// A bike path with surface=grass is LTS 1a but rejected by the mode rule
// for kid-starting-out, so it belongs in "Not preferred" — this mirrors
// the router exactly (no parallel classifier).
function bucketForDecision(decision: ModeDecision): Bucket {
  if (!decision.accepted) return 'not-preferred'
  if (decision.isWalking) return 'not-preferred'
  if (decision.costMultiplier > 1.01) return 'not-preferred'
  return 'preferred'
}

function noteForDecision(decision: ModeDecision, rule: ReturnType<typeof resolveRule>, classification: LtsClassification): string {
  const { surface, smoothness } = classification
  if (!decision.accepted) {
    return `Rejected by this mode (${decision.reason}). Routed as a walked bridge only where there's no alternative.`
  }
  if (decision.isWalking) {
    return `Walked on the sidewalk at ${rule.walkingSpeedKmh} km/h (cobble or rough surface). Router avoids unless no alternative.`
  }
  if (decision.costMultiplier > 1.01) {
    const why =
      smoothness && ['bad', 'very_bad', 'horrible', 'very_horrible', 'impassable'].includes(smoothness)
        ? `smoothness=${smoothness}`
        : (surface ? `surface=${surface}` : 'rough')
    return `Rideable at ${decision.speedKmh} km/h but ${decision.costMultiplier.toFixed(1)}× cost (${why}) — router detours when it can.`
  }
  return `Routed at ${decision.speedKmh} km/h. First-choice path for this mode.`
}

function resolveRule(mode: RideMode) { return MODE_RULES[mode] }

export default function AuditSamplesTab({ scan, regionRules }: Props) {
  const [travelMode, setTravelMode] = useState<RideMode>('kid-starting-out')

  // Two-level bucket: bucket (Preferred / Not preferred) → PathLevel →
  // classification item → { ways, note, decision }. Each scan.groups
  // entry is tag-uniform, so one `applyModeRule` call classifies all
  // ways in that group. We key the nested card on (classification +
  // primary bucketing reason) so a way with the same classification
  // name but a different decision (e.g. asphalt Bike path vs grass
  // Bike path) gets its own card.
  interface ItemEntry { ways: AuditWay[]; decision: ModeDecision; classification: LtsClassification }

  const byBucket = useMemo(() => {
    const out = new Map<Bucket, Map<PathLevel, Map<string, ItemEntry>>>()
    for (const bucket of ['preferred', 'not-preferred'] as const) {
      const m = new Map<PathLevel, Map<string, ItemEntry>>()
      for (const lvl of PATH_LEVELS) m.set(lvl, new Map())
      out.set(bucket, m)
    }
    if (!scan) return out

    const rule = MODE_RULES[travelMode]

    for (const group of scan.groups) {
      const sampleTags = group.samples[0]?.tags
      if (!sampleTags) continue
      const classification = classifyEdge(sampleTags)
      const decision = applyModeRule(rule, classification, null)
      const bucket = bucketForDecision(decision)
      const cls = classifyOsmTagsToItem(sampleTags, travelMode, regionRules) ?? 'Unclassified'
      // Include a short decision tag in the key so same-name groups with
      // different decisions don't collide (asphalt vs grass Bike path).
      const decisionTag = decision.accepted
        ? (decision.isWalking ? 'walk' : decision.costMultiplier > 1.01 ? 'rough' : 'ok')
        : 'rej'
      const cardKey = `${cls}::${decisionTag}`
      const levelMap = out.get(bucket)!.get(classification.pathLevel)!
      const existing = levelMap.get(cardKey)
      if (existing) {
        existing.ways.push(...group.samples.filter((w) => w.center))
      } else {
        levelMap.set(cardKey, {
          ways: [...group.samples.filter((w) => w.center)],
          decision,
          classification,
        })
      }
    }
    return out
  }, [scan, travelMode, regionRules])

  if (!scan) {
    return <div className="audit-empty">Scan a city first to see samples by class.</div>
  }

  const rule = resolveRule(travelMode)

  return (
    <div className="st">
      <div className="st-controls">
        <label className="st-label">Travel Mode</label>
        <select
          className="audit-select"
          value={travelMode}
          onChange={(e) => setTravelMode(e.target.value as RideMode)}
        >
          <option value="kid-starting-out">Kid starting out</option>
          <option value="kid-confident">Kid confident</option>
          <option value="kid-traffic-savvy">Kid traffic-savvy</option>
          <option value="carrying-kid">Carrying kid</option>
          <option value="training">Training</option>
        </select>
      </div>

      {(['preferred', 'not-preferred'] as const).map((bucket) => {
        const byLevel = byBucket.get(bucket)!
        const levelsInBucket = PATH_LEVELS.filter((lvl) => (byLevel.get(lvl)?.size ?? 0) > 0)
        if (levelsInBucket.length === 0) return null
        const sortBySize = (a: [string, ItemEntry], b: [string, ItemEntry]) => b[1].ways.length - a[1].ways.length
        return (
          <div key={bucket} className={`st-bucket st-bucket-${bucket}`}>
            <h2 className={`st-bucket-heading st-bucket-heading-${bucket}`}>
              {bucket === 'preferred' ? 'Preferred paths' : 'Not preferred paths'}
            </h2>
            {levelsInBucket.map((lvl) => {
              const itemMap = byLevel.get(lvl)!
              const info = PATH_LEVEL_LABELS[lvl]
              const entries = [...itemMap.entries()].sort(sortBySize)
              return (
                <div key={lvl} className={`st-section st-level st-level-${bucket}`}>
                  <div className="st-level-header">
                    <span className="st-level-code">LTS {lvl}</span>
                    <span className="st-level-name">{info.short}</span>
                  </div>
                  <p className="st-level-desc">{info.description}</p>
                  {entries.map(([cardKey, entry]) => {
                    const displayName = cardKey.split('::')[0]
                    const note = noteForDecision(entry.decision, rule, entry.classification)
                    return (
                      <ClassCard
                        key={cardKey}
                        classification={displayName}
                        ways={entry.ways}
                        isPreferred={bucket === 'preferred'}
                        note={note}
                      />
                    )
                  })}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
