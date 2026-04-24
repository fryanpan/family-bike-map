import { useState, useEffect, useCallback } from 'react'
import { CITY_PRESETS, scanCity, reclassifyGroups } from '../services/audit'
import type { CityPreset } from '../services/audit'
import { saveScan, loadScan } from '../services/auditCache'
import AuditGroupDetail from './AuditGroupDetail'
import AuditSamplesTab from './AuditSamplesTab'
import AdminSettingsTab from './AdminSettingsTab'
import AdminBenchmarksTab from './AdminBenchmarksTab'
import type { CityScan, AuditGroup } from '../services/audit'
import { fetchRules } from '../services/rules'
import type { RegionRules } from '../services/rules'

type OuterTab = 'audit' | 'settings' | 'benchmarks'
type InnerTab = 'samples' | 'groups'
type FilterStatus = 'all' | 'classified' | 'unclassified'

// Sentinel for the "sample tiles around my current location" dropdown
// option. When selected, scanning requests browser geolocation and
// builds a bbox around the user. Defaults to this on open so auditing
// "just works" in whatever city Bryan is actually in.
const CURRENT_LOCATION = 'Current location'
// Half-span (degrees) for the bbox around a detected current location.
// 0.18° ≈ 20 km at Berlin/SF latitudes — covers ~16 tiles, of which
// `scanCity` randomly samples up to 20.
const CURRENT_LOCATION_HALF_SPAN_DEG = 0.18

async function getCurrentLocationBbox(): Promise<CityPreset['bbox']> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new Error('geolocation unavailable'))
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords
        const r = CURRENT_LOCATION_HALF_SPAN_DEG
        resolve({
          south: latitude - r, north: latitude + r,
          west: longitude - r, east: longitude + r,
        })
      },
      (err) => reject(err),
      { timeout: 10000, enableHighAccuracy: false },
    )
  })
}

const VALID_OUTER: OuterTab[] = ['audit', 'settings', 'benchmarks']
const VALID_INNER: InnerTab[] = ['samples', 'groups']

function parseOuterFromUrl(): OuterTab {
  const params = new URLSearchParams(window.location.search)
  const val = params.get('admin')
  if (val && VALID_OUTER.includes(val as OuterTab)) return val as OuterTab
  if (val && VALID_INNER.includes(val as InnerTab)) return 'audit'
  return 'audit'
}

function parseInnerFromUrl(): InnerTab {
  const params = new URLSearchParams(window.location.search)
  const val = params.get('admin')
  if (val && VALID_INNER.includes(val as InnerTab)) return val as InnerTab
  return 'samples'
}

interface Props {
  onClose: () => void
  initialTab?: OuterTab
}

export default function AdminPanel({ onClose, initialTab }: Props) {
  const [outerTab, setOuterTabRaw] = useState<OuterTab>(initialTab ?? parseOuterFromUrl())
  const [innerTab, setInnerTabRaw] = useState<InnerTab>(parseInnerFromUrl())

  const setOuterTab = useCallback((tab: OuterTab) => {
    setOuterTabRaw(tab)
    const params = new URLSearchParams(window.location.search)
    params.set('admin', tab === 'audit' ? innerTab : tab)
    window.history.replaceState({}, '', `?${params.toString()}`)
  }, [innerTab])

  const setInnerTab = useCallback((tab: InnerTab) => {
    setInnerTabRaw(tab)
    const params = new URLSearchParams(window.location.search)
    params.set('admin', tab)
    window.history.replaceState({}, '', `?${params.toString()}`)
  }, [])

  const [selectedCity, setSelectedCity] = useState(CURRENT_LOCATION)
  const [scan, setScan] = useState<CityScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const [expandedGroup, setExpandedGroup] = useState<number | null>(null)

  const [filterStatus, setFilterStatus] = useState<FilterStatus>('all')
  const [filterText, setFilterText] = useState('')

  const [rules, setRulesRaw] = useState<RegionRules>({ rules: [], legendItems: [] })

  const setRules = useCallback((newRules: RegionRules) => {
    setRulesRaw(newRules)
    setScan((prev) => prev ? reclassifyGroups(prev, newRules.rules) : prev)
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([
      loadScan(selectedCity).catch(() => null),
      fetchRules(selectedCity.toLowerCase()).catch(() => ({ rules: [], legendItems: [] } as RegionRules)),
    ]).then(([cached, r]) => {
      if (cancelled) return
      setRulesRaw(r)
      if (cached && Array.isArray(cached.groups) && cached.groups.every((g: AuditGroup) => typeof g.totalDistanceKm === 'number')) {
        setScan(r.rules.length > 0 ? reclassifyGroups(cached, r.rules) : cached)
      }
    })
    return () => { cancelled = true }
  }, [selectedCity])

  const handleCityChange = useCallback((city: string) => {
    setSelectedCity(city)
    setScan(null)
    setProgress(null)
    setRulesRaw({ rules: [], legendItems: [] })
  }, [])

  async function handleScan() {
    if (scanning) return

    let bbox: CityPreset['bbox'] | null = null
    if (selectedCity === CURRENT_LOCATION) {
      try {
        bbox = await getCurrentLocationBbox()
      } catch (err) {
        // Browser geolocation denied or unavailable. Surface the error
        // without a silent fallback — Bryan should know why it failed.
        const msg = err instanceof Error ? err.message : String(err)
        alert(`Couldn't read current location: ${msg}`)
        return
      }
    } else {
      const preset = CITY_PRESETS.find((p) => p.name === selectedCity)
      if (!preset) return
      bbox = preset.bbox
    }

    setScanning(true)
    setProgress({ done: 0, total: 1 })

    try {
      const result = await scanCity(selectedCity, bbox, (done, total) => {
        setProgress({ done, total })
      })
      setScan(result)
      await saveScan(selectedCity, result)
    } finally {
      setScanning(false)
      setProgress(null)
    }
  }

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
        <h2 className="audit-title">Admin Tools</h2>
        <button className="audit-close-btn" onClick={onClose} aria-label="Close admin panel">
          &#x2715;
        </button>
      </div>

      {/* Outer tabs — Classification Audit | Settings | Benchmarks */}
      <div className="audit-tabs audit-tabs-outer">
        <button
          className={`audit-tab${outerTab === 'audit' ? ' audit-tab-active' : ''}`}
          onClick={() => setOuterTab('audit')}
        >
          Classification Audit
        </button>
        <button
          className={`audit-tab${outerTab === 'settings' ? ' audit-tab-active' : ''}`}
          onClick={() => setOuterTab('settings')}
        >
          Settings
        </button>
        <button
          className={`audit-tab${outerTab === 'benchmarks' ? ' audit-tab-active' : ''}`}
          onClick={() => setOuterTab('benchmarks')}
        >
          Routing Benchmarks
        </button>
      </div>

      {outerTab === 'settings' && (
        <AdminSettingsTab />
      )}

      {outerTab === 'benchmarks' && (
        <AdminBenchmarksTab />
      )}

      {outerTab === 'audit' && (
        <>
          <div className="audit-controls">
            <select
              className="audit-select"
              value={selectedCity}
              onChange={(e) => handleCityChange(e.target.value)}
              disabled={scanning}
            >
              <option value={CURRENT_LOCATION}>{CURRENT_LOCATION}</option>
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
              className={`audit-tab${innerTab === 'samples' ? ' audit-tab-active' : ''}`}
              onClick={() => setInnerTab('samples')}
            >
              Samples
            </button>
            <button
              className={`audit-tab${innerTab === 'groups' ? ' audit-tab-active' : ''}`}
              onClick={() => setInnerTab('groups')}
            >
              Groups
            </button>
          </div>

          {innerTab === 'groups' && (
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

          {innerTab === 'samples' && (
            <AuditSamplesTab scan={scan} regionRules={rules.rules} />
          )}
        </>
      )}
    </div>
  )
}
