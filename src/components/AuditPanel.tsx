import { useState } from 'react'
import { CITY_PRESETS } from '../services/audit'
import type { CityScan, AuditGroup } from '../services/audit'

interface Props {
  onClose: () => void
}

export default function AuditPanel({ onClose }: Props) {
  const [selectedCity, setSelectedCity] = useState(CITY_PRESETS[0].name)
  const [scan] = useState<CityScan | null>(null)

  // Placeholder groups list (wired up in next commit)
  const groups: AuditGroup[] = scan?.groups ?? []

  return (
    <div className="audit-overlay">
      <div className="audit-header">
        <h2 className="audit-title">Classification Audit</h2>
        <button className="audit-close-btn" onClick={onClose} aria-label="Close audit panel">
          &#x2715;
        </button>
      </div>

      <div className="audit-controls">
        <select
          className="audit-select"
          value={selectedCity}
          onChange={(e) => setSelectedCity(e.target.value)}
        >
          {CITY_PRESETS.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>

        <button className="btn-primary audit-scan-btn" disabled>
          Scan
        </button>

        {scan && (
          <span className="audit-meta">
            {scan.totalWays} ways &middot; {scan.groups.length} groups &middot; {scan.tilesScanned} tiles
          </span>
        )}
      </div>

      <div className="audit-groups">
        {groups.length === 0 && (
          <p className="audit-empty">Select a city and press Scan to start.</p>
        )}
        {groups.map((g, i) => (
          <div key={i} className="audit-group-card">
            <div className="audit-group-sig">{g.signature || '(no tags)'}</div>
            <div className="audit-group-meta">
              <span className="audit-group-count">{g.wayCount} ways</span>
              <span className={g.classification ? 'audit-cls-known' : 'audit-cls-null'}>
                {g.classification ?? 'unclassified'}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
