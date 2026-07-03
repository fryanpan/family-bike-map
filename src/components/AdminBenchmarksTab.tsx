import { useEffect, useState } from 'react'
import { getRouteTimings } from '../services/routeTiming'
import type { RouteTiming } from '../services/routeTiming'

/**
 * One-line-per-run record written by scripts/render-route-comparisons.ts
 * to public/route-compare/history.jsonl. The shape evolved over time —
 * `version` and `google` fields are only present on newer runs.
 */
interface BenchmarkRun {
  runDate: string
  version?: string
  commit?: string
  count: number
  avgPreferredPct: { client?: number; valhalla?: number; brouter?: number; google?: number }
  avgDistanceKm: { client?: number; valhalla?: number; brouter?: number; google?: number }
  flaggedCount: number
}

function folderFor(run: BenchmarkRun): string {
  return run.version ? `${run.runDate}-${run.version}` : run.runDate
}

function fmtPct(v: number | undefined): string {
  return v != null ? `${(v * 100).toFixed(0)}%` : '—'
}

function fmtKm(v: number | undefined): string {
  return v != null ? v.toFixed(2) : '—'
}

function fmtMs(v: number | null): string {
  return v != null ? v.toFixed(1) : '—'
}

/**
 * Session route timings (routeTiming.ts ring buffer) — the readout the
 * phone measurement protocol in server/README.md is built on: plan routes,
 * open this tab, transcribe the rows. Client rows carry the tile/graph/A*
 * phase breakdown; server rows are the HTTP round-trip only.
 */
function RouteTimingsSection() {
  const [timings, setTimings] = useState<RouteTiming[]>(() => getRouteTimings())

  return (
    <div className="benchmarks-timings">
      <h3>
        Recent route timings (this session){' '}
        <button type="button" onClick={() => setTimings(getRouteTimings())}>Refresh</button>
      </h3>
      {timings.length === 0 ? (
        <p className="benchmarks-intro">
          No routes computed this session yet — plan a route on the map, then hit Refresh.
          Client rows break down tile load / graph build / A*; server rows show the HTTP
          round-trip (set the route-server URL under Settings → routingBackend to compare).
        </p>
      ) : (
        <table className="benchmarks-table">
          <thead>
            <tr>
              <th>When</th>
              <th>Backend</th>
              <th>Mode</th>
              <th>Tiles (ms)</th>
              <th>Graph (ms)</th>
              <th>A* (ms)</th>
              <th>Total (ms)</th>
              <th>Nodes</th>
              <th>Edges</th>
              <th>Found</th>
            </tr>
          </thead>
          <tbody>
            {timings.map((t, i) => (
              <tr key={`${t.at}-${i}`}>
                <td className="mono">{new Date(t.at).toLocaleTimeString()}</td>
                <td>{t.backend}</td>
                <td>{t.mode}</td>
                <td className="num">{fmtMs(t.tileLoadMs)}</td>
                <td className="num">{fmtMs(t.graphBuildMs)}</td>
                <td className="num">{fmtMs(t.astarMs)}</td>
                <td className="num">{fmtMs(t.totalMs)}</td>
                <td className="num">{t.graphNodes ?? '—'}</td>
                <td className="num">{t.graphEdges ?? '—'}</td>
                <td>{t.found ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default function AdminBenchmarksTab() {
  const [runs, setRuns] = useState<BenchmarkRun[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/route-compare/history.jsonl')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then((text) => {
        if (cancelled) return
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
        const parsed: BenchmarkRun[] = []
        for (const line of lines) {
          try { parsed.push(JSON.parse(line) as BenchmarkRun) } catch { /* skip bad lines */ }
        }
        // Most recent first — date DESC, then original line order (later lines win on same date).
        parsed.reverse()
        setRuns(parsed)
      })
      .catch((e) => { if (!cancelled) setErr(String(e)) })
    return () => { cancelled = true }
  }, [])

  // The session route-timings readout renders regardless of whether the
  // benchmark history loaded — it's local state, not a fetched artifact.
  if (err) return <div className="benchmarks-tab"><RouteTimingsSection /><div className="audit-empty">Couldn't load benchmark history: {err}</div></div>
  if (!runs) return <div className="benchmarks-tab"><RouteTimingsSection /><div className="audit-empty">Loading benchmark history…</div></div>
  if (runs.length === 0) return <div className="benchmarks-tab"><RouteTimingsSection /><div className="audit-empty">No benchmark runs recorded yet.</div></div>

  const latest = runs[0]
  const latestHref = `/route-compare/${folderFor(latest)}/`

  return (
    <div className="benchmarks-tab">
      <RouteTimingsSection />
      <p className="benchmarks-intro">
        Client/Valhalla/BRouter/Google route comparisons generated by
        <code> bun scripts/render-route-comparisons.ts</code>. Each run is published to its own folder so
        the result is pinned to the exact version and commit that produced it.
      </p>

      <div className="benchmarks-latest">
        <strong>Latest:</strong>{' '}
        <a href={latestHref} target="_blank" rel="noreferrer">
          {folderFor(latest)} ({latest.count} samples)
        </a>
      </div>

      <table className="benchmarks-table">
        <thead>
          <tr>
            <th rowSpan={2}>Date</th>
            <th rowSpan={2}>Version</th>
            <th rowSpan={2}>Commit</th>
            <th rowSpan={2}>N</th>
            <th colSpan={4}>Avg preferred %</th>
            <th colSpan={4}>Avg distance (km)</th>
            <th rowSpan={2}>Flagged</th>
            <th rowSpan={2}></th>
          </tr>
          <tr>
            <th>Client</th><th>Valhalla</th><th>BRouter</th><th>Google</th>
            <th>Client</th><th>Valhalla</th><th>BRouter</th><th>Google</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run, i) => {
            const href = `/route-compare/${folderFor(run)}/`
            return (
              <tr key={i}>
                <td>{run.runDate}</td>
                <td className="mono">{run.version ?? '—'}</td>
                <td className="mono">{run.commit ?? '—'}</td>
                <td className="num">{run.count}</td>
                <td className="num">{fmtPct(run.avgPreferredPct.client)}</td>
                <td className="num">{fmtPct(run.avgPreferredPct.valhalla)}</td>
                <td className="num">{fmtPct(run.avgPreferredPct.brouter)}</td>
                <td className="num">{fmtPct(run.avgPreferredPct.google)}</td>
                <td className="num">{fmtKm(run.avgDistanceKm.client)}</td>
                <td className="num">{fmtKm(run.avgDistanceKm.valhalla)}</td>
                <td className="num">{fmtKm(run.avgDistanceKm.brouter)}</td>
                <td className="num">{fmtKm(run.avgDistanceKm.google)}</td>
                <td className="num">{run.flaggedCount}</td>
                <td><a href={href} target="_blank" rel="noreferrer">open →</a></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
