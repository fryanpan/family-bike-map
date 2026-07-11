/**
 * Route-timing instrumentation (enriched-tiles plan, scope update §4 —
 * the phone benchmark). Records how long each route computation took,
 * split into the phases that matter for the client-vs-server backend
 * decision:
 *
 *   tileLoadMs   — corridor tile collection + elevation prefetch
 *   graphBuildMs — buildRoutingGraph (classification + costing)
 *   astarMs      — routeOnGraph (snap + edge-keyed A* + segment build)
 *   totalMs      — wall time of the whole route call
 *
 * Server-backend entries only know the HTTP round-trip (totalMs); their
 * phase fields are null — the breakdown for those lives in the server
 * process's own console (the server runs the same instrumented
 * clientRoute).
 *
 * Instrumentation only: nothing here influences routing. Timings surface
 * three ways:
 *   - performance.measure entries (route:tile-load / route:graph-build /
 *     route:astar / route:total) for DevTools performance traces,
 *   - one console.debug line per route,
 *   - a session ring buffer rendered in Admin → Benchmarks ("Recent
 *     route timings") — the readout the phone measurement protocol in
 *     server/README.md is built on.
 */

export interface RouteTiming {
  /** Wall-clock epoch ms when the timing was recorded. */
  at: number
  /** Which backend produced the route: in-browser router or route server. */
  backend: 'client' | 'server'
  /** Ride mode key, e.g. 'kid-confident'. */
  mode: string
  /** Tile collection + elevation prefetch (client entries only). */
  tileLoadMs: number | null
  /** buildRoutingGraph (client entries only). */
  graphBuildMs: number | null
  /** routeOnGraph — snap + A* + segment build (client entries only). */
  astarMs: number | null
  /** Whole call: phases above for client, HTTP round-trip for server. */
  totalMs: number
  graphNodes: number | null
  graphEdges: number | null
  /** False when the call completed but found no route (null result). */
  found: boolean
}

export interface RouteTimingInput extends Omit<RouteTiming, 'at'> {
  /**
   * `performance.now()` timestamp at the start of the route call — anchors
   * the performance.measure entries on the trace timeline. Omitted (e.g.
   * by callers that only know durations), measures are anchored backwards
   * from "now".
   */
  startedAt?: number
}

const MAX_TIMINGS = 50

const timings: RouteTiming[] = []

function fmt(ms: number | null): string {
  return ms == null ? '—' : `${ms.toFixed(1)} ms`
}

function emitPerformanceMeasures(input: RouteTimingInput): void {
  if (typeof performance === 'undefined' || typeof performance.measure !== 'function') return
  try {
    const start = input.startedAt ?? Math.max(0, performance.now() - input.totalMs)
    let cursor = start
    if (input.tileLoadMs != null) {
      performance.measure('route:tile-load', { start: cursor, duration: input.tileLoadMs })
      cursor += input.tileLoadMs
    }
    if (input.graphBuildMs != null) {
      performance.measure('route:graph-build', { start: cursor, duration: input.graphBuildMs })
      cursor += input.graphBuildMs
    }
    if (input.astarMs != null) {
      performance.measure('route:astar', { start: cursor, duration: input.astarMs })
    }
    performance.measure('route:total', { start, duration: input.totalMs })
  } catch {
    // Older engines without measure-options support — instrumentation
    // must never break routing.
  }
}

/** Record one route computation. Returns the stored entry. */
export function recordRouteTiming(input: RouteTimingInput): RouteTiming {
  const { startedAt: _startedAt, ...rest } = input
  const entry: RouteTiming = { at: Date.now(), ...rest }
  timings.push(entry)
  if (timings.length > MAX_TIMINGS) timings.shift()

  emitPerformanceMeasures(input)

  const detail = entry.graphBuildMs != null
    ? ` (tiles ${fmt(entry.tileLoadMs)}, graph ${fmt(entry.graphBuildMs)}, A* ${fmt(entry.astarMs)};` +
      ` ${entry.graphNodes ?? '?'} nodes / ${entry.graphEdges ?? '?'} edges)`
    : ' (HTTP round-trip)'
  console.debug(
    `[route-timing] ${entry.backend}/${entry.mode}: total ${fmt(entry.totalMs)}${detail}` +
    (entry.found ? '' : ' — no route'),
  )
  return entry
}

/** Recent timings, newest first. Returns a copy. */
export function getRouteTimings(): RouteTiming[] {
  return [...timings].reverse()
}

/** Reset the ring buffer (tests, bench script isolation). */
export function clearRouteTimings(): void {
  timings.length = 0
}
