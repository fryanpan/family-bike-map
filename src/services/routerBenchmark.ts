/**
 * Routing benchmark: compares client-side router against Valhalla
 * for a set of Berlin test cases.
 *
 * Can be called from the browser console or the eval admin tab.
 */

import {
  prefetchTiles,
  buildRoutingGraph,
  routeOnGraph,
} from './clientRouter'
import { getRoute, DEFAULT_PROFILES, formatDistance, formatDuration } from './routing'
import { getCostingFromPreferences, computeRouteQuality } from '../utils/classify'
import type { OsmWay, Route } from '../utils/types'
import type { ClassificationRule } from './rules'

// ── Test locations ─────────────────────────────────────────────────────────

const HOME = { lat: 52.5016, lng: 13.4103, label: 'Home (Dresdener Str)' }
const SCHOOL = { lat: 52.5105, lng: 13.4247, label: 'School (Wilhelmine-Gemberg-Weg)' }

const DESTINATIONS = [
  { lat: 52.5079, lng: 13.3376, label: 'Berlin Zoo' },
  { lat: 52.5284, lng: 13.3727, label: 'Hamburger Bahnhof' },
  { lat: 52.5219, lng: 13.4133, label: 'Alexanderplatz' },
  { lat: 52.5130, lng: 13.4070, label: 'Fischerinsel Swimming' },
  { lat: 52.5169, lng: 13.4019, label: 'Humboldt Forum' },
  { lat: 52.4910, lng: 13.4220, label: 'Nonne und Zwerg' },
  { lat: 52.4750, lng: 13.4340, label: 'Stadtbad Neukoelln' },
  { lat: 52.5410, lng: 13.5790, label: 'Garten der Welt' },
]

const ORIGINS = [HOME, SCHOOL]

// ── Benchmark result type ──────────────────────────────────────────────────

export interface BenchmarkRow {
  origin: string
  destination: string
  // Client router
  clientGraphBuildMs: number
  clientRouteMs: number
  clientDistanceKm: number | null
  clientDurationS: number | null
  clientPreferredPct: number | null
  clientNodes: number
  clientEdges: number
  // Valhalla
  valhallaDistanceKm: number | null
  valhallaDurationS: number | null
  valhallaError?: string
}

export interface BenchmarkSummary {
  tileFetchMs: number
  totalWays: number
  rows: BenchmarkRow[]
}

// ── Main benchmark runner ──────────────────────────────────────────────────

/**
 * Run the routing benchmark across all origin x destination pairs.
 * Pre-fetches all Berlin tiles first, then times graph build + route for each pair.
 */
export async function runRoutingBenchmark(
  profileKey: string,
  preferredItemNames: Set<string>,
  regionRules?: ClassificationRule[],
  onProgress?: (msg: string) => void,
): Promise<BenchmarkSummary> {
  // Step 1: Pre-fetch all Berlin tiles
  onProgress?.('Fetching Berlin tiles...')
  const tileFetchStart = performance.now()
  const allWays = await prefetchTiles({ south: 52.34, west: 13.08, north: 52.68, east: 13.76 }, (pct) => {
    onProgress?.(`Fetching tiles... ${pct}%`)
  })
  const tileFetchMs = performance.now() - tileFetchStart
  onProgress?.(`Tiles fetched: ${allWays.length} ways in ${Math.round(tileFetchMs)}ms`)

  const rows: BenchmarkRow[] = []

  // Step 2: For each origin x destination, build graph and route
  for (const origin of ORIGINS) {
    for (const dest of DESTINATIONS) {
      onProgress?.(`Routing: ${origin.label} -> ${dest.label}`)

      const row: BenchmarkRow = {
        origin: origin.label,
        destination: dest.label,
        clientGraphBuildMs: 0,
        clientRouteMs: 0,
        clientDistanceKm: null,
        clientDurationS: null,
        clientPreferredPct: null,
        clientNodes: 0,
        clientEdges: 0,
        valhallaDistanceKm: null,
        valhallaDurationS: null,
      }

      // Client-side route
      const buildStart = performance.now()
      const graph = buildRoutingGraph(allWays, profileKey, preferredItemNames, regionRules)
      row.clientGraphBuildMs = performance.now() - buildStart

      const routeStart = performance.now()
      const clientResult = routeOnGraph(
        graph, origin.lat, origin.lng, dest.lat, dest.lng,
        profileKey, preferredItemNames, regionRules,
      )
      row.clientRouteMs = performance.now() - routeStart

      if (clientResult) {
        row.clientDistanceKm = clientResult.distanceKm
        row.clientDurationS = clientResult.durationS
        row.clientNodes = clientResult.graphNodes
        row.clientEdges = clientResult.graphEdges
        if (clientResult.segments.length > 0) {
          const quality = computeRouteQuality(clientResult.segments, preferredItemNames)
          row.clientPreferredPct = Math.round(quality.preferred * 100)
        }
      }

      // Valhalla route (for comparison)
      try {
        const profile = DEFAULT_PROFILES[profileKey]
        if (profile) {
          const costingOptions = getCostingFromPreferences(preferredItemNames, profileKey, profile)
          const valhallaRoutes = await getRoute(
            { ...origin, shortLabel: origin.label },
            { ...dest, shortLabel: dest.label },
            { ...profile, costingOptions },
            [],
            0,
          )
          const vRoute = valhallaRoutes[0]
          if (vRoute) {
            row.valhallaDistanceKm = vRoute.summary.distance
            row.valhallaDurationS = vRoute.summary.duration
          }
        }
      } catch (e) {
        row.valhallaError = e instanceof Error ? e.message : String(e)
      }

      rows.push(row)
    }
  }

  return { tileFetchMs, totalWays: allWays.length, rows }
}

/**
 * Format benchmark results as a console-friendly table string.
 */
export function formatBenchmarkTable(summary: BenchmarkSummary): string {
  const lines: string[] = [
    `=== Routing Benchmark ===`,
    `Tile fetch: ${Math.round(summary.tileFetchMs)}ms | ${summary.totalWays} ways`,
    '',
    padRow(['Origin', 'Destination', 'Build ms', 'Route ms', 'Client km', 'Client min', 'Pref%', 'Valhalla km', 'Valhalla min', 'Nodes', 'Edges']),
    '-'.repeat(140),
  ]

  for (const r of summary.rows) {
    lines.push(padRow([
      r.origin.slice(0, 16),
      r.destination.slice(0, 20),
      Math.round(r.clientGraphBuildMs).toString(),
      Math.round(r.clientRouteMs).toString(),
      r.clientDistanceKm !== null ? r.clientDistanceKm.toFixed(1) : '-',
      r.clientDurationS !== null ? Math.round(r.clientDurationS / 60).toString() : '-',
      r.clientPreferredPct !== null ? `${r.clientPreferredPct}%` : '-',
      r.valhallaDistanceKm !== null ? r.valhallaDistanceKm.toFixed(1) : r.valhallaError?.slice(0, 15) ?? '-',
      r.valhallaDurationS !== null ? Math.round(r.valhallaDurationS / 60).toString() : '-',
      r.clientNodes.toString(),
      r.clientEdges.toString(),
    ]))
  }

  return lines.join('\n')
}

function padRow(cols: string[]): string {
  const widths = [18, 22, 10, 10, 12, 12, 8, 13, 13, 8, 8]
  return cols.map((c, i) => c.padEnd(widths[i] ?? 10)).join('')
}
