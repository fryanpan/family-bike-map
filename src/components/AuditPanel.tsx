import { useState, useEffect, useCallback } from 'react'
import { CITY_PRESETS, scanCity, reclassifyGroups } from '../services/audit'
import { saveScan, loadScan } from '../services/auditCache'
import AuditGroupDetail from './AuditGroupDetail'
import AuditRulesTab from './AuditRulesTab'
import AuditSamplesTab from './AuditSamplesTab'
import AuditLegendTab from './AuditLegendTab'
import AuditEvalTab from './AuditEvalTab'
import type { CityScan, AuditGroup } from '../services/audit'
import { fetchRules } from '../services/rules'
import type { RegionRules } from '../services/rules'

type FilterStatus = 'all' | 'classified' | 'unclassified'
type ActiveTab = 'samples' | 'groups' | 'rules' | 'legend' | 'eval'
const VALID_TABS: ActiveTab[] = ['samples', 'groups', 'rules', 'legend', 'eval']

function parseTabFromUrl(): ActiveTab {
  const params = new URLSearchParams(window.location.search)
  const val = params.get('admin')
  if (val && VALID_TABS.includes(val as ActiveTab)) return val as ActiveTab
  return 'samples'
}

interface Props {
  onClose: () => void
  initialTab?: ActiveTab
}

export default function AuditPanel({ onClose, initialTab }: Props) {
  const [selectedCity, setSelectedCity] = useState(CITY_PRESETS[0].name)
  const [scan, setScan] = useState<CityScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  // Expansion
  const [expandedGroup, setExpandedGroup] = useState<number | null>(null)

  // Filters
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all')
  const [filterText, setFilterText] = useState('')

  // Tabs — default to samples (the main admin view)
  const [activeTab, setActiveTabRaw] = useState<ActiveTab>(initialTab ?? parseTabFromUrl())

  const setActiveTab = useCallback((tab: ActiveTab) => {
    setActiveTabRaw(tab)
    const params = new URLSearchParams(window.location.search)
    params.set('admin', tab)
    window.history.replaceState({}, '', `?${params.toString()}`)
  }, [])

  // Region rules (KV-backed)
  const [rules, setRulesRaw] = useState<RegionRules>({ rules: [], legendItems: [] })

  // When rules change, reclassify the scan groups immediately
  const setRules = useCallback((newRules: RegionRules) => {
    setRulesRaw(newRules)
    setScan((prev) => prev ? reclassifyGroups(prev, newRules.rules) : prev)
  }, [])

  // Load cached scan and rules on mount and when city changes.
  // Reclassify scan groups once both are available.
  useEffect(() => {
    let cancelled = false
    // TODO: add a schema version to CityScan so we can detect stale cache cleanly
    Promise.all([
      loadScan(selectedCity).catch(() => null),
      fetchRules(selectedCity.toLowerCase()).catch(() => ({ rules: [], legendItems: [] } as RegionRules)),
    ]).then(([cached, r]) => {
      if (cancelled) return
      setRulesRaw(r)
      // Discard cached scans from old schema (missing totalDistanceKm)
      if (cached && Array.isArray(cached.groups) && cached.groups.every((g: AuditGroup) => typeof g.totalDistanceKm === 'number')) {
        setScan(r.rules.length > 0 ? reclassifyGroups(cached, r.rules) : cached)
      }
    })
    return () => { cancelled = true }
  }, [selectedCity])

  // Reset scan when city changes
  const handleCityChange = useCallback((city: string) => {
    setSelectedCity(city)
    setScan(null)
    setProgress(null)
    setRulesRaw({ rules: [], legendItems: [] })
  }, [])

  async function handleScan() {
    const preset = CITY_PRESETS.find((p) => p.name === selectedCity)
    if (!preset || scanning) return

    setScanning(true)
    setProgress({ done: 0, total: 1 })

    try {
      const result = await scanCity(selectedCity, preset.bbox, (done, total) => {
        setProgress({ done, total })
      })
      setScan(result)
      await saveScan(selectedCity, result)
    } finally {
      setScanning(false)
      setProgress(null)
    }
  }

  // Filter groups
  const filteredGroups: AuditGroup[] = (scan?.groups ?? []).filter((g) => {
    if (filterStatus === 'classified' && g.classification === null) return false
    if (filterStatus === 'unclassified' && g.classification !== null) return false
    if (filterText) {
      const q = filterText.toLowerCase()
      if (!g.signature.toLowerCase().includes(q) &&
          !(g.classification ?? '').toLowerCase().includes(q)) {
        return false
      }
    }
    return true
  })

  const progressPct = progress
    ? Math.round((progress.done / progress.total) * 100)
    : null

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
          onChange={(e) => handleCityChange(e.target.value)}
          disabled={scanning}
        >
          {CITY_PRESETS.map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>

        <button
          className="btn-primary audit-scan-btn"
          onClick={handleScan}
          disabled={scanning}
        >
          {scanning ? `Scanning ${progressPct ?? 0}%` : 'Scan'}
        </button>

        {scan && (
          <span className="audit-meta">
            {scan.totalWays} ways &middot; {scan.groups.length} groups &middot; {scan.tilesScanned} tiles
          </span>
        )}
      </div>

      <div className="audit-tabs">
        <button
          className={`audit-tab${activeTab === 'samples' ? ' audit-tab-active' : ''}`}
          onClick={() => setActiveTab('samples')}
        >
          Samples
        </button>
        <button
          className={`audit-tab${activeTab === 'groups' ? ' audit-tab-active' : ''}`}
          onClick={() => setActiveTab('groups')}
        >
          Groups
        </button>
        <button
          className={`audit-tab${activeTab === 'rules' ? ' audit-tab-active' : ''}`}
          onClick={() => setActiveTab('rules')}
        >
          Rules
        </button>
        <button
          className={`audit-tab${activeTab === 'legend' ? ' audit-tab-active' : ''}`}
          onClick={() => setActiveTab('legend')}
        >
          Legend Items
        </button>
        <button
          className={`audit-tab${activeTab === 'eval' ? ' audit-tab-active' : ''}`}
          onClick={() => setActiveTab('eval')}
        >
          Eval
        </button>
      </div>

      {activeTab === 'groups' && (
        <>
          <div className="audit-filters">
            <select
              className="audit-select"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as FilterStatus)}
            >
              <option value="all">All</option>
              <option value="classified">Classified</option>
              <option value="unclassified">Unclassified</option>
            </select>

            <input
              className="audit-search-input"
              type="text"
              placeholder="Search tags..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
          </div>

          <div className="audit-groups">
            {filteredGroups.length === 0 && scan && (
              <p className="audit-empty">No groups match the current filters.</p>
            )}
            {!scan && !scanning && (
              <p className="audit-empty">Select a city and press Scan to start.</p>
            )}
            {filteredGroups.map((g, i) => (
              <div key={i}>
                <div
                  className={`audit-group-card${expandedGroup === i ? ' audit-group-card-expanded' : ''}`}
                  onClick={() => setExpandedGroup(expandedGroup === i ? null : i)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setExpandedGroup(expandedGroup === i ? null : i)
                    }
                  }}
                >
                  <div className="audit-group-sig">{g.signature || '(no tags)'}</div>
                  <div className="audit-group-meta">
                    <span className="audit-group-count">{g.wayCount} ways{g.totalDistanceKm != null ? ` · ${g.totalDistanceKm < 1 ? `${Math.round(g.totalDistanceKm * 1000)}m` : `${g.totalDistanceKm.toFixed(1)}km`}` : ''}</span>
                    <span className={g.classification ? 'audit-cls-known' : 'audit-cls-null'}>
                      {g.classification ?? 'unclassified'}
                    </span>
                  </div>
                </div>
                {expandedGroup === i && (
                  <AuditGroupDetail
                    group={g}
                    region={selectedCity.toLowerCase()}
                    rules={rules}
                    onRulesChange={setRules}
                  />
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {activeTab === 'rules' && (
        <AuditRulesTab
          rules={rules}
          region={selectedCity.toLowerCase()}
          onRulesChange={setRules}
        />
      )}

      {activeTab === 'legend' && (
        <AuditLegendTab
          rules={rules}
          region={selectedCity.toLowerCase()}
          onRulesChange={setRules}
        />
      )}

      {activeTab === 'samples' && (
        <AuditSamplesTab scan={scan} regionRules={rules.rules} />
      )}

      {activeTab === 'eval' && (
        <AuditEvalTab />
      )}
    </div>
  )
}
