import { useState, useEffect, useMemo } from 'react'
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

const TARGET_PER_CLASS = 25
const TAG_KEYS = ['highway', 'cycleway', 'cycleway:right', 'cycleway:left', 'cycleway:both', 'surface', 'smoothness', 'maxspeed', 'bicycle', 'segregated']

interface FoundImage {
  way: AuditWay
  image: MapillaryImage
}

function ClassSection({ classification, ways }: { classification: string; ways: AuditWay[] }) {
  const [found, setFound] = useState<FoundImage[]>([])
  const [searching, setSearching] = useState(false)
  const [done, setDone] = useState(false)
  const [expanded, setExpanded] = useState<number | null>(null)

  const candidates = useMemo(() => shuffle(ways.filter((w) => w.center)), [ways])

  useEffect(() => {
    let cancelled = false
    setFound([])
    setDone(false)
    setSearching(true)

    async function search() {
      const results: FoundImage[] = []
      for (let i = 0; i < candidates.length && results.length < TARGET_PER_CLASS; i += 5) {
        const batch = candidates.slice(i, i + 5)
        const images = await Promise.all(
          batch.map((w) => getStreetImage(w.center!.lat, w.center!.lon))
        )
        for (let j = 0; j < batch.length; j++) {
          if (cancelled) return
          if (images[j]) results.push({ way: batch[j], image: images[j]! })
        }
        if (!cancelled) setFound([...results])
      }
      if (!cancelled) { setSearching(false); setDone(true) }
    }

    search()
    return () => { cancelled = true }
  }, [candidates])

  return (
    <div className="audit-class-section">
      <h3 className="audit-class-title">
        {classification}
        <span className="audit-class-count">
          {found.length}{searching ? '+' : ''} / {TARGET_PER_CLASS}
        </span>
      </h3>
      <div className="audit-class-grid">
        {found.map((s, i) => {
          const isExpanded = expanded === i
          const allTags = TAG_KEYS
            .filter((k) => s.way.tags[k])
            .map((k) => `${k}=${s.way.tags[k]}`)
          const visibleTags = isExpanded ? allTags : allTags.slice(0, 3)
          const hiddenCount = allTags.length - 3
          return (
            <div
              key={i}
              className={`audit-class-card${isExpanded ? ' audit-class-card-expanded' : ''}`}
              onClick={() => setExpanded(isExpanded ? null : i)}
            >
              <img
                src={s.image.thumbUrl}
                alt={classification}
                className="audit-class-img"
                loading="lazy"
              />
              <div className="audit-class-card-meta">
                {s.way.tags.name && <span className="audit-class-name">{s.way.tags.name}</span>}
                {visibleTags.map((t, ti) => (
                  <span key={ti} className="audit-class-tag">{t}</span>
                ))}
                {!isExpanded && hiddenCount > 0 && (
                  <span className="audit-class-more">+{hiddenCount} more</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      {searching && <div className="audit-class-loading">Searching for images…</div>}
      {done && found.length === 0 && <div className="audit-class-loading">No Mapillary images found</div>}
    </div>
  )
}

export default function AuditSamplesTab({ scan, regionRules }: Props) {
  const [travelMode, setTravelMode] = useState('kid-starting-out')

  // Group ways by classification for the selected travel mode, split into preferred/other
  const { preferred, other } = useMemo(() => {
    if (!scan) return { preferred: new Map<string, AuditWay[]>(), other: new Map<string, AuditWay[]>() }

    const preferredItems = getDefaultPreferredItems(travelMode)
    const prefMap = new Map<string, AuditWay[]>()
    const otherMap = new Map<string, AuditWay[]>()

    for (const group of scan.groups) {
      // Reclassify with the selected travel mode
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
    <div className="audit-samples-tab">
      <div className="audit-samples-controls">
        <label className="audit-samples-label">Travel Mode</label>
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
        <div className="audit-samples-group">
          <h2 className="audit-samples-group-title audit-samples-preferred">Preferred</h2>
          {[...preferred.entries()].map(([cls, ways]) => (
            <ClassSection key={cls} classification={cls} ways={ways} />
          ))}
        </div>
      )}

      {other.size > 0 && (
        <div className="audit-samples-group">
          <h2 className="audit-samples-group-title audit-samples-other">Other</h2>
          {[...other.entries()].map(([cls, ways]) => (
            <ClassSection key={cls} classification={cls} ways={ways} />
          ))}
        </div>
      )}
    </div>
  )
}
