import { useState, useEffect, useMemo } from 'react'
import { getStreetImage } from '../services/mapillary'
import type { MapillaryImage } from '../services/mapillary'
import type { CityScan, AuditWay } from '../services/audit'

interface Props {
  scan: CityScan | null
}

/** Shuffle array in place (Fisher-Yates) and return it. */
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

const TARGET_PER_CLASS = 25

interface FoundImage {
  way: AuditWay
  image: MapillaryImage
}

function ClassSection({ classification, ways }: { classification: string; ways: AuditWay[] }) {
  const [found, setFound] = useState<FoundImage[]>([])
  const [searching, setSearching] = useState(false)
  const [done, setDone] = useState(false)

  // Shuffle candidates once
  const candidates = useMemo(() => shuffle([...ways].filter((w) => w.center)), [ways])

  useEffect(() => {
    let cancelled = false
    setFound([])
    setDone(false)
    setSearching(true)

    async function search() {
      const results: FoundImage[] = []
      // Try candidates in batches of 5 until we have enough or run out
      for (let i = 0; i < candidates.length && results.length < TARGET_PER_CLASS; i += 5) {
        const batch = candidates.slice(i, i + 5)
        const images = await Promise.all(
          batch.map((w) => getStreetImage(w.center!.lat, w.center!.lon))
        )
        for (let j = 0; j < batch.length; j++) {
          if (cancelled) return
          if (images[j]) {
            results.push({ way: batch[j], image: images[j]! })
          }
        }
        if (!cancelled) setFound([...results])
      }
      if (!cancelled) {
        setSearching(false)
        setDone(true)
      }
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
        {found.map((s, i) => (
          <div key={i} className="audit-class-card">
            <img
              src={s.image.thumbUrl}
              alt={classification}
              className="audit-class-img"
              loading="lazy"
            />
            <div className="audit-class-card-meta">
              {s.way.tags.name && <span className="audit-class-name">{s.way.tags.name}</span>}
              <span className="audit-class-sig">
                {Object.entries(s.way.tags)
                  .filter(([k]) => ['highway', 'cycleway', 'cycleway:right', 'cycleway:left', 'surface'].includes(k))
                  .map(([k, v]) => `${k}=${v}`)
                  .join(' · ') || `OSM ${s.way.osmId}`}
              </span>
            </div>
          </div>
        ))}
      </div>
      {searching && <div className="audit-class-loading">Searching for images…</div>}
      {done && found.length === 0 && <div className="audit-class-loading">No Mapillary images found</div>}
    </div>
  )
}

export default function AuditSamplesTab({ scan }: Props) {
  const byClass = useMemo(() => {
    if (!scan) return new Map<string, AuditWay[]>()
    const map = new Map<string, AuditWay[]>()
    for (const group of scan.groups) {
      const cls = group.classification ?? 'Unclassified'
      const existing = map.get(cls) ?? []
      existing.push(...group.samples.filter((w) => w.center))
      map.set(cls, existing)
    }
    return new Map([...map.entries()].sort((a, b) => b[1].length - a[1].length))
  }, [scan])

  if (!scan) {
    return <div className="audit-empty">Scan a city first to see samples by class.</div>
  }

  return (
    <div className="audit-samples-tab">
      {[...byClass.entries()].map(([cls, ways]) => (
        <ClassSection key={cls} classification={cls} ways={ways} />
      ))}
    </div>
  )
}
