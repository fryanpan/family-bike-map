#!/usr/bin/env bun
/**
 * Overlay-paint performance budget — CI counterpart of the manual DevTools
 * check mandated by the rendering-changes gate. Runs the production
 * classify -> verdict -> geometry-prep pipeline over a checked-in fixture
 * tile (raw + enriched variants) and asserts wall-time budgets.
 *
 * Exists because #208 (steep-moat filter) shipped tile-arrival jank with
 * no automated gate to catch it — union-find + per-vertex gradient lookups
 * ran synchronously over every fetched way on every tile arrival. This
 * script is deterministic (no browser, no network) so it runs in CI on
 * every PR; it complements, not replaces, scripts/render-checks/'s
 * PERF BUDGET check (which measures real browser long-tasks and needs a
 * live page).
 *
 * ONE implementation rule, same as bench-route-latency.ts: no
 * reimplemented classification logic here. Every gating decision goes
 * through the exact production functions (classifyEdge, classifyOsmTagsToItem,
 * overlayWayVerdict, inheritStubVerdicts, smallFragmentIds, simplifyPath).
 * The only thing this script owns is the *loop order* that calls them,
 * copied from the OverlayRenderer effect in BikeMapOverlay.tsx (passes
 * 0a/0b/0c) — if that loop order changes, update prepareOverlayPaint below
 * to match, or this benchmark stops measuring the real pipeline.
 *
 * Usage:
 *   bun scripts/bench-overlay-paint.ts               # run + assert budgets
 *   bun scripts/bench-overlay-paint.ts --print-only   # print, exit 0 always
 *
 * Recalibrating budgets: see scripts/render-checks/README.md.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { classifyEdge } from '../src/utils/lts'
import type { PathLevel } from '../src/utils/lts'
import {
  classifyOsmTagsToItem, isOverlayCrossing, isOverlayHiddenSurface, isRoughSurface,
} from '../src/services/overpass'
import { getDisplayPathLevel, getOverlayMaxGradientPct, getDefaultPreferredItems } from '../src/utils/classify'
import { overlayGradientPct } from '../src/services/elevation'
import { simplifyPath } from '../src/utils/simplifyPath'
import { colorForLevel, weightMultiplierForLevel } from '../src/components/SimpleLegend'
import {
  overlayWayVerdict, FRAGMENT_MIN_LEN_M, FRAGMENT_SHOW_MIN_ZOOM,
  type EnrichedGateOptions, type RuntimeGateInputs,
} from '../src/components/BikeMapOverlay'
import { inheritStubVerdicts, smallFragmentIds } from '../src/services/overlayReachability'
import { isEnrichedWay, type OsmWay } from '../src/utils/types'
import { MODE_RULES } from '../src/data/modes'

// ── Fixture loading ─────────────────────────────────────────────────────────

const FIXTURES_DIR = join(import.meta.dir, 'fixtures')

function loadRawFixture(): OsmWay[] {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, 'overlay-bench-raw.json'), 'utf8')) as OsmWay[]
  return raw
}

function loadEnrichedFixture(): OsmWay[] {
  const parsed = JSON.parse(readFileSync(join(FIXTURES_DIR, 'overlay-bench-enriched.json'), 'utf8')) as {
    ways: OsmWay[]
  }
  return parsed.ways
}

// ── Pipeline (mirrors BikeMapOverlay.tsx OverlayRenderer passes 0a-0c) ─────
//
// A pure-data version of the render effect, stopping before any engine
// (addPathLayer/addPolyline) calls — those are the DOM/WebGL cost this
// script deliberately does NOT measure (no browser here; that's
// scripts/render-checks/checks/perf-budget.ts's job). This measures the
// CPU-bound classify -> gate -> simplify cost that runs on every tile
// arrival and every mode switch, over EVERY fetched way — the part #208
// regressed.

export interface PrepResult {
  painted: number
  hidden: number
  roughStippled: number
  totalSimplifiedVerts: number
}

export function prepareOverlayPaint(
  ways: OsmWay[],
  profileKey: string,
  zoom: number,
): PrepResult {
  const preferredItemNames = getDefaultPreferredItems(profileKey)
  const maxGradientPct = getOverlayMaxGradientPct(profileKey)

  interface Candidate {
    way: OsmWay
    verdict: 'shown' | 'hidden' | 'unknown'
    pathLevel: PathLevel
    enriched: boolean
  }
  const gateOptions: EnrichedGateOptions & RuntimeGateInputs = {
    maxGradientPct,
    steepApproachPushM: 0,
    fragmentFloorActive: zoom < FRAGMENT_SHOW_MIN_ZOOM,
    // Real overlayGradientPct geometry pass (segMeters + wayAscentMeters
    // loops — the actual per-way CPU cost #208 regressed), fed a
    // no-elevation-cached lookup fn. A pure script has no terrain-RGB tiles
    // to consult (see learnings.md "Local dev can NEVER load terrain-RGB
    // tiles"), so this always resolves to null — the same fail-soft
    // "not yet known" state production is in immediately after tile
    // arrival, before elevReady fires. Exercises the real function's cost
    // without a network dependency.
    gradientPct: (w) => overlayGradientPct(w.coordinates, () => null),
    moatIsolated: new Set(),
  }

  const candidates: Candidate[] = []
  const roughWays: OsmWay[] = []
  for (const way of ways) {
    if (way.coordinates.length < 2) continue
    const { pathLevel: routingPathLevel } = classifyEdge(way.tags)
    if (routingPathLevel === '4') continue
    if (isOverlayCrossing(way.tags)) continue
    if (isOverlayHiddenSurface(way.tags)) {
      if (isRoughSurface(way.tags)) roughWays.push(way)
      continue
    }
    const itemName = classifyOsmTagsToItem(way.tags, profileKey)
    const pathLevel = getDisplayPathLevel(itemName, profileKey, routingPathLevel)
    const isPreferred = itemName !== null && preferredItemNames.has(itemName)
    if (!isPreferred) continue
    const verdict = overlayWayVerdict(way, gateOptions)
    candidates.push({ way, verdict, pathLevel, enriched: isEnrichedWay(way) })
  }

  const runtimeCandidates = candidates.filter((c) => !c.enriched)
  const verdictByOsmId = new Map<string | number, Candidate['verdict']>()
  for (const c of runtimeCandidates) verdictByOsmId.set(c.way.osmId, c.verdict)
  const stubHidden = inheritStubVerdicts(
    runtimeCandidates.map((c) => c.way),
    (way) => verdictByOsmId.get(way.osmId) ?? 'unknown',
  )

  const survivors = candidates.filter(
    (c) => c.verdict !== 'hidden' && !(c.verdict === 'unknown' && stubHidden.has(c.way.osmId)),
  )
  const runtimeSurvivors = survivors.filter((c) => !c.enriched)
  const smallFragments = zoom < FRAGMENT_SHOW_MIN_ZOOM
    ? smallFragmentIds(runtimeSurvivors.map((c) => c.way), FRAGMENT_MIN_LEN_M)
    : new Set<string | number>()

  let totalSimplifiedVerts = 0
  let painted = 0
  for (const { way, pathLevel } of survivors) {
    if (smallFragments.has(way.osmId)) continue
    // colorForLevel / weightMultiplierForLevel are cheap lookups but ARE
    // part of the real per-way styling pass — include them so the
    // benchmark's per-way cost matches production, not just the gates.
    void colorForLevel(pathLevel)
    void weightMultiplierForLevel(pathLevel)
    const coords = simplifyPath(way.coordinates, zoom)
    totalSimplifiedVerts += coords.length
    painted++
  }

  return {
    painted,
    hidden: candidates.length - survivors.length,
    roughStippled: zoom >= 16 ? roughWays.length : 0,
    totalSimplifiedVerts,
  }
}

// ── Benchmark scenarios ──────────────────────────────────────────────────

interface Timing { label: string; ms: number; result: PrepResult }

function timeOnce(label: string, ways: OsmWay[], profileKey: string, zoom: number): Timing {
  const t0 = performance.now()
  const result = prepareOverlayPaint(ways, profileKey, zoom)
  const ms = performance.now() - t0
  return { label, ms, result }
}

/** Median of N repeated runs — single-run wall time on a shared CI runner
 *  is noisy; median damps GC pauses / neighbor-VM jitter. */
function medianMs(fn: () => void, runs: number): number {
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  return samples[Math.floor(samples.length / 2)]
}

// Budgets are ~3x a measured baseline (see README for the recalibration
// procedure and the raw numbers this was calibrated from). Deliberately
// generous: this is a regression tripwire for "someone added an O(n^2)
// pass," not a tight perf target — a CI runner slower than the dev
// machine this was calibrated on should still comfortably clear it.
//
// Calibrated 2026-07-11 on an M-series Mac (bun 1.3.10), 8 runs, 5x
// median each: raw single-tile pass 2.7-3.9ms, all-modes reclassify
// 19-29ms. Budgets below are ~3x the worst observed run of each,
// rounded up.
const BUDGETS_MS = {
  // One tile-arrival-equivalent classify+gate+simplify pass at metro zoom.
  singleTilePass: 15,
  // A mode switch re-runs the full pass for every mode without re-fetch —
  // this is the "reclassify everything the user has loaded" cost.
  allModesSwitch: 100,
}

function main(): void {
  const { values } = parseArgs({ options: { 'print-only': { type: 'boolean' } } })
  const printOnly = values['print-only'] ?? false

  const rawWays = loadRawFixture()
  const enrichedWays = loadEnrichedFixture()
  console.log(`fixtures: ${rawWays.length} raw ways, ${enrichedWays.length} enriched ways`)

  const ZOOM = 14 // metro zoom — the tile-arrival hot path #208 regressed
  const modes = Object.keys(MODE_RULES)

  // Warm up (JIT) — unrecorded, same convention as bench-route-latency.ts.
  prepareOverlayPaint(rawWays, modes[0], ZOOM)
  prepareOverlayPaint(enrichedWays, modes[0], ZOOM)

  const singleRaw = timeOnce('raw/single-tile-pass', rawWays, modes[0], ZOOM)
  const singleEnriched = timeOnce('enriched/single-tile-pass', enrichedWays, modes[0], ZOOM)
  const singleRawMedian = medianMs(() => prepareOverlayPaint(rawWays, modes[0], ZOOM), 5)
  const singleEnrichedMedian = medianMs(() => prepareOverlayPaint(enrichedWays, modes[0], ZOOM), 5)

  const allModesMs = medianMs(() => {
    for (const mode of modes) prepareOverlayPaint(rawWays, mode, ZOOM)
  }, 5)

  console.log('\n| scenario | painted | hidden | median ms |')
  console.log('|---|---|---|---|')
  console.log(`| raw single-tile pass (${modes[0]}) | ${singleRaw.result.painted} | ${singleRaw.result.hidden} | ${singleRawMedian.toFixed(2)} |`)
  console.log(`| enriched single-tile pass (${modes[0]}) | ${singleEnriched.result.painted} | ${singleEnriched.result.hidden} | ${singleEnrichedMedian.toFixed(2)} |`)
  console.log(`| all-modes reclassify (raw, ${modes.length} modes) | - | - | ${allModesMs.toFixed(2)} |`)

  const failures: string[] = []
  if (singleRawMedian > BUDGETS_MS.singleTilePass) {
    failures.push(`raw single-tile pass ${singleRawMedian.toFixed(2)}ms exceeds budget ${BUDGETS_MS.singleTilePass}ms`)
  }
  if (singleEnrichedMedian > BUDGETS_MS.singleTilePass) {
    failures.push(`enriched single-tile pass ${singleEnrichedMedian.toFixed(2)}ms exceeds budget ${BUDGETS_MS.singleTilePass}ms`)
  }
  if (allModesMs > BUDGETS_MS.allModesSwitch) {
    failures.push(`all-modes reclassify ${allModesMs.toFixed(2)}ms exceeds budget ${BUDGETS_MS.allModesSwitch}ms`)
  }

  if (failures.length > 0) {
    console.error('\n[bench-overlay-paint] BUDGET EXCEEDED:')
    for (const f of failures) console.error(`  - ${f}`)
    console.error('\nIf this is an expected cost increase (deliberate new pipeline stage), recalibrate')
    console.error('BUDGETS_MS in this file per scripts/render-checks/README.md — do not just raise the')
    console.error('number without checking WHY it grew first (see docs/process/learnings.md, "Overlay')
    console.error('rendering" section, for the class of bug this budget exists to catch).')
    if (!printOnly) process.exit(1)
  } else {
    console.log('\n[bench-overlay-paint] within budget.')
  }
}

if (import.meta.main) main()
