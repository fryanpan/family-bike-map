/**
 * Evaluation harness tab for the audit panel.
 *
 * Lets the user enter an origin/destination (or pick from route log history),
 * then runs routes across all engines/modes and displays a comparison table.
 */

import { useState, useCallback } from 'react'
import { getRoute, formatDistance, formatDuration, DEFAULT_PROFILES } from '../services/routing'
import { getBRouterRoutes } from '../services/brouter'
import type { Place, Route, ProfileKey } from '../utils/types'

interface EvalResult {
  engine: string
  mode: string
  route: Route | null
  error?: string
}

interface TestCase {
  startLat: number
  startLng: number
  startLabel: string
  endLat: number
  endLng: number
  endLabel: string
}

/** Berlin default test cases for quick evaluation. */
const PRESET_TEST_CASES: TestCase[] = [
  {
    startLat: 52.4951, startLng: 13.4231, startLabel: 'Kreuzberg (Oranienplatz)',
    endLat: 52.5200, endLng: 13.4050, endLabel: 'Mitte (Alexanderplatz)',
  },
  {
    startLat: 52.4750, startLng: 13.4440, startLabel: 'Neukoelln (Hermannplatz)',
    endLat: 52.5340, endLng: 13.3890, endLabel: 'Prenzlauer Berg (Mauerpark)',
  },
  {
    startLat: 52.5075, startLng: 13.3325, startLabel: 'Charlottenburg (Zoo)',
    endLat: 52.5120, endLng: 13.3950, endLabel: 'Tiergarten (Brandenburger Tor)',
  },
]

const ENGINE_MODES: Array<{ engine: string; mode: string; profileKey?: ProfileKey }> = [
  { engine: 'Valhalla', mode: 'toddler', profileKey: 'toddler' },
  { engine: 'Valhalla', mode: 'trailer', profileKey: 'trailer' },
  { engine: 'Valhalla', mode: 'training', profileKey: 'training' },
  { engine: 'BRouter', mode: 'trekking' },
]

function makePlaceFromTestCase(tc: TestCase, which: 'start' | 'end'): Place {
  if (which === 'start') {
    return { lat: tc.startLat, lng: tc.startLng, label: tc.startLabel, shortLabel: tc.startLabel }
  }
  return { lat: tc.endLat, lng: tc.endLng, label: tc.endLabel, shortLabel: tc.endLabel }
}

export default function AuditEvalTab() {
  const [testCases, setTestCases] = useState<TestCase[]>(PRESET_TEST_CASES)
  const [results, setResults] = useState<Map<string, EvalResult[]>>(new Map())
  const [running, setRunning] = useState(false)
  const [selectedRoute, setSelectedRoute] = useState<{ tcKey: string; idx: number } | null>(null)

  // Manual entry state
  const [startLat, setStartLat] = useState('')
  const [startLng, setStartLng] = useState('')
  const [startLabel, setStartLabel] = useState('')
  const [endLat, setEndLat] = useState('')
  const [endLng, setEndLng] = useState('')
  const [endLabel, setEndLabel] = useState('')

  const tcKey = (tc: TestCase) => `${tc.startLat},${tc.startLng}->${tc.endLat},${tc.endLng}`

  const runEvalForTestCase = useCallback(async (tc: TestCase): Promise<EvalResult[]> => {
    const start = makePlaceFromTestCase(tc, 'start')
    const end = makePlaceFromTestCase(tc, 'end')
    const evalResults: EvalResult[] = []

    // Run all engines in parallel
    const promises = ENGINE_MODES.map(async ({ engine, mode, profileKey }) => {
      try {
        let route: Route | null = null
        if (engine === 'Valhalla' && profileKey) {
          const profile = DEFAULT_PROFILES[profileKey]
          if (!profile) throw new Error(`Unknown profile: ${profileKey}`)
          const routes = await getRoute(start, end, profile, [], 0)
          route = routes[0] ?? null
        } else if (engine === 'BRouter') {
          const routes = await getBRouterRoutes(start, end)
          route = routes[0] ?? null
        }
        return { engine, mode, route }
      } catch (e) {
        return { engine, mode, route: null, error: e instanceof Error ? e.message : String(e) }
      }
    })

    const settled = await Promise.all(promises)
    evalResults.push(...settled)
    return evalResults
  }, [])

  const handleRunAll = useCallback(async () => {
    setRunning(true)
    const newResults = new Map<string, EvalResult[]>()
    for (const tc of testCases) {
      const key = tcKey(tc)
      const evalResults = await runEvalForTestCase(tc)
      newResults.set(key, evalResults)
      // Update progressively
      setResults(new Map(newResults))
    }
    setRunning(false)
  }, [testCases, runEvalForTestCase])

  const handleRunSingle = useCallback(async (tc: TestCase) => {
    setRunning(true)
    const key = tcKey(tc)
    const evalResults = await runEvalForTestCase(tc)
    setResults((prev) => {
      const next = new Map(prev)
      next.set(key, evalResults)
      return next
    })
    setRunning(false)
  }, [runEvalForTestCase])

  const handleAddManual = useCallback(() => {
    const sLat = parseFloat(startLat)
    const sLng = parseFloat(startLng)
    const eLat = parseFloat(endLat)
    const eLng = parseFloat(endLng)
    if (isNaN(sLat) || isNaN(sLng) || isNaN(eLat) || isNaN(eLng)) return

    const tc: TestCase = {
      startLat: sLat, startLng: sLng, startLabel: startLabel || `${sLat.toFixed(4)},${sLng.toFixed(4)}`,
      endLat: eLat, endLng: eLng, endLabel: endLabel || `${eLat.toFixed(4)},${eLng.toFixed(4)}`,
    }
    setTestCases((prev) => [...prev, tc])
    setStartLat(''); setStartLng(''); setStartLabel('')
    setEndLat(''); setEndLng(''); setEndLabel('')
  }, [startLat, startLng, startLabel, endLat, endLng, endLabel])

  const handleRemoveTestCase = useCallback((idx: number) => {
    setTestCases((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  const selectedResult = selectedRoute
    ? results.get(selectedRoute.tcKey)?.[selectedRoute.idx]
    : null

  return (
    <div className="eval-tab">
      {/* Manual entry */}
      <div className="eval-manual-entry">
        <div className="eval-manual-row">
          <input className="eval-input" placeholder="Start lat" value={startLat} onChange={(e) => setStartLat(e.target.value)} />
          <input className="eval-input" placeholder="Start lng" value={startLng} onChange={(e) => setStartLng(e.target.value)} />
          <input className="eval-input eval-input-wide" placeholder="Label (optional)" value={startLabel} onChange={(e) => setStartLabel(e.target.value)} />
        </div>
        <div className="eval-manual-row">
          <input className="eval-input" placeholder="End lat" value={endLat} onChange={(e) => setEndLat(e.target.value)} />
          <input className="eval-input" placeholder="End lng" value={endLng} onChange={(e) => setEndLng(e.target.value)} />
          <input className="eval-input eval-input-wide" placeholder="Label (optional)" value={endLabel} onChange={(e) => setEndLabel(e.target.value)} />
        </div>
        <button className="eval-add-btn" onClick={handleAddManual}>
          + Add Test Case
        </button>
      </div>

      {/* Test cases and run button */}
      <div className="eval-controls">
        <button
          className="btn-primary eval-run-btn"
          onClick={handleRunAll}
          disabled={running || testCases.length === 0}
        >
          {running ? 'Running...' : `Run All (${testCases.length})`}
        </button>
      </div>

      <div className="eval-cases">
        {testCases.map((tc, i) => {
          const key = tcKey(tc)
          const caseResults = results.get(key)
          return (
            <div key={i} className="eval-case">
              <div className="eval-case-header">
                <span className="eval-case-label">
                  {tc.startLabel} &#x2192; {tc.endLabel}
                </span>
                <div className="eval-case-actions">
                  <button
                    className="eval-case-run-btn"
                    onClick={() => handleRunSingle(tc)}
                    disabled={running}
                    title="Run this test case"
                  >
                    &#x25B6;
                  </button>
                  <button
                    className="eval-case-remove-btn"
                    onClick={() => handleRemoveTestCase(i)}
                    title="Remove test case"
                  >
                    &#x2715;
                  </button>
                </div>
              </div>

              {caseResults && (
                <table className="eval-table">
                  <thead>
                    <tr>
                      <th>Engine</th>
                      <th>Mode</th>
                      <th>Distance</th>
                      <th>Time</th>
                      <th>Safety</th>
                      <th>LTS 1%</th>
                      <th>LTS 2%</th>
                      <th>LTS 3%</th>
                      <th>LTS 4%</th>
                      <th>Worst Segment</th>
                    </tr>
                  </thead>
                  <tbody>
                    {caseResults.map((r, ri) => {
                      const lts = r.route?.ltsBreakdown
                      const isSelected = selectedRoute?.tcKey === key && selectedRoute?.idx === ri
                      return (
                        <tr
                          key={ri}
                          className={`eval-row ${isSelected ? 'eval-row-selected' : ''} ${r.error ? 'eval-row-error' : ''}`}
                          onClick={() => setSelectedRoute({ tcKey: key, idx: ri })}
                        >
                          <td>{r.engine}</td>
                          <td>{r.mode}</td>
                          <td>{r.route ? formatDistance(r.route.summary.distance) : '-'}</td>
                          <td>{r.route ? formatDuration(r.route.summary.duration) : '-'}</td>
                          <td>{lts ? lts.familySafetyScore : '-'}</td>
                          <td>{lts ? `${lts.lts1Pct}%` : '-'}</td>
                          <td>{lts ? `${lts.lts2Pct}%` : '-'}</td>
                          <td>{lts ? `${lts.lts3Pct}%` : '-'}</td>
                          <td>{lts ? `${lts.lts4Pct}%` : '-'}</td>
                          <td className="eval-worst">
                            {lts?.worstSegment
                              ? `${lts.worstSegment.name} (LTS ${lts.worstSegment.lts}, ${Math.round(lts.worstSegment.lengthM)}m)`
                              : r.error ? r.error.slice(0, 40) : '-'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )
        })}
      </div>

      {/* Selected route preview */}
      {selectedResult?.route && (
        <div className="eval-preview">
          <h4 className="eval-preview-title">
            Route preview: {selectedResult.engine} / {selectedResult.mode}
          </h4>
          <p className="eval-preview-meta">
            {formatDistance(selectedResult.route.summary.distance)} &middot; {formatDuration(selectedResult.route.summary.duration)}
            {selectedResult.route.ltsBreakdown && (
              <> &middot; Safety: {selectedResult.route.ltsBreakdown.familySafetyScore}</>
            )}
          </p>
          <p className="eval-preview-coords">
            {selectedResult.route.coordinates.length} coordinates
            {selectedResult.route.segments && <> &middot; {selectedResult.route.segments.length} segments</>}
          </p>
        </div>
      )}
    </div>
  )
}
