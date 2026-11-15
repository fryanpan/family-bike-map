#!/usr/bin/env bun
/**
 * One-time (re-)generator for the overlay-paint benchmark fixtures.
 *
 * `bench-overlay-paint.ts` needs a checked-in tile's worth of ways to
 * exercise the classify -> verdict -> geometry-prep pipeline at a size
 * that produces a stable, measurable wall-clock number (a real Overpass
 * tile is ~200-400 ways — see data/tiles/bayarea-core/*.json — so this
 * generates a metro-viewport-sized ~2-3 tile equivalent). Synthetic, not
 * real OSM data: real tiles aren't checked in (data/ is gitignored, and
 * OSM extracts are large), and a synthetic fixture lets us hit every
 * pipeline branch deliberately (LTS4 exclusion, crossings, rough
 * surfaces, control nodes, sub-noise-floor stubs, over-ceiling
 * gradients, sub-floor fragments) rather than hoping a real extract
 * happens to contain them.
 *
 * Writes two sibling files:
 *   overlay-bench-raw.json       - OsmWay[] with NO baked fields (the
 *                                   runtime moat/gradient-cache path)
 *   overlay-bench-enriched.json  - {meta, ways} with baked gradientPct /
 *                                   accessGradientPct / componentPaintedLenM
 *                                   (the arithmetic-gate path)
 *
 * Same tag distribution and geometry underlie both — only the baked
 * fields differ — so a raw-vs-enriched benchmark comparison isn't
 * confounded by different input shapes.
 *
 * Deterministic (mulberry32, same PRNG convention as
 * scripts/bench-route-latency.ts) so regenerating with the same --seed
 * produces byte-identical output. Re-run only if the benchmark needs a
 * different size/mix — the committed JSON is the artifact bench-overlay-
 * paint.ts actually reads; this script is provenance, not a build step.
 *
 * Usage: bun scripts/fixtures/gen-overlay-bench-fixtures.ts [--seed 1] [--count 1500]
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// SF-ish bbox — geometry only matters for realistic segment lengths /
// coordinate precision, not the actual city.
const BBOX = { south: 37.750, west: -122.450, north: 37.780, east: -122.400 }

interface RawWay {
  osmId: number
  itemName: null
  tags: Record<string, string>
  coordinates: [number, number][]
}

interface EnrichedWayOut extends RawWay {
  gradientPct: number | null
  accessGradientPct: number | null
  componentPaintedLenM: number | null
}

// Category weights mirror a plausible real-world tag mix (see
// data/tiles/bayarea-core/*.json for a real reference tile) while
// deliberately including every branch the overlay pipeline gates on.
type Category =
  | 'quiet_residential' | 'cycleway' | 'shared_path' | 'fahrradstrasse'
  | 'living_street' | 'painted_lane_quiet' | 'painted_lane_major'
  | 'major_road' | 'rough_surface' | 'short_stub' | 'crossing_stub' | 'control_node'

const WEIGHTS: Array<[Category, number]> = [
  ['quiet_residential', 34],
  ['cycleway', 10],
  ['shared_path', 8],
  ['fahrradstrasse', 5],
  ['living_street', 4],
  ['painted_lane_quiet', 8],
  ['painted_lane_major', 6],
  ['major_road', 10],
  ['rough_surface', 5],
  ['short_stub', 8],
  ['crossing_stub', 7],
  ['control_node', 5],
]
const TOTAL_WEIGHT = WEIGHTS.reduce((s, [, w]) => s + w, 0)

function pickCategory(rand: () => number): Category {
  let r = rand() * TOTAL_WEIGHT
  for (const [cat, w] of WEIGHTS) {
    if (r < w) return cat
    r -= w
  }
  return WEIGHTS[WEIGHTS.length - 1][0]
}

const STREET_NAMES = [
  'Elm', 'Oak', 'Maple', 'Cedar', 'Willow', 'Birch', 'Alder', 'Poplar',
  'Sunset', 'Ocean', 'Valley', 'Ridge', 'Harbor', 'Market', 'Mission', 'Church',
]

function randomName(rand: () => number, suffix: string): string {
  const n = STREET_NAMES[Math.floor(rand() * STREET_NAMES.length)]
  return `${n} ${suffix}`
}

/** A short random-walk path of `n` points, each step ~stepM metres. */
function randomWalk(rand: () => number, n: number, stepM: number): [number, number][] {
  let lat = BBOX.south + rand() * (BBOX.north - BBOX.south)
  let lng = BBOX.west + rand() * (BBOX.east - BBOX.west)
  const coords: [number, number][] = [[round(lat), round(lng)]]
  const headingRad = rand() * Math.PI * 2
  const dLatPerM = 1 / 111320
  const dLngPerM = 1 / (111320 * Math.cos((lat * Math.PI) / 180))
  for (let i = 1; i < n; i++) {
    // Mostly straight with small jitter — real streets aren't pure noise.
    const jitter = (rand() - 0.5) * 0.6
    const heading = headingRad + jitter
    lat += Math.cos(heading) * stepM * dLatPerM
    lng += Math.sin(heading) * stepM * dLngPerM
    coords.push([round(lat), round(lng)])
  }
  return coords
}

function round(v: number): number {
  return Math.round(v * 1e7) / 1e7
}

function buildWay(rand: () => number, category: Category): { tags: Record<string, string>; coordinates: [number, number][] } {
  switch (category) {
    case 'quiet_residential': {
      const tags: Record<string, string> = { highway: 'residential', name: randomName(rand, 'St') }
      if (rand() < 0.5) tags.maxspeed = '25'
      return { tags, coordinates: randomWalk(rand, 6 + Math.floor(rand() * 12), 25) }
    }
    case 'cycleway':
      return {
        tags: { highway: 'cycleway', surface: 'asphalt', name: randomName(rand, 'Bike Path') },
        coordinates: randomWalk(rand, 6 + Math.floor(rand() * 15), 20),
      }
    case 'shared_path':
      return {
        tags: { highway: 'footway', bicycle: 'designated', surface: 'asphalt' },
        coordinates: randomWalk(rand, 5 + Math.floor(rand() * 10), 20),
      }
    case 'fahrradstrasse':
      return {
        tags: { highway: 'residential', bicycle_road: 'yes', name: randomName(rand, 'Strasse') },
        coordinates: randomWalk(rand, 8 + Math.floor(rand() * 10), 25),
      }
    case 'living_street':
      return {
        tags: { highway: 'living_street', name: randomName(rand, 'Way') },
        coordinates: randomWalk(rand, 4 + Math.floor(rand() * 6), 20),
      }
    case 'painted_lane_quiet':
      return {
        tags: { highway: 'residential', cycleway: 'lane', maxspeed: '30', name: randomName(rand, 'Ave') },
        coordinates: randomWalk(rand, 6 + Math.floor(rand() * 10), 25),
      }
    case 'painted_lane_major':
      return {
        tags: { highway: 'tertiary', cycleway: 'lane', maxspeed: '50', lanes: '4', name: randomName(rand, 'Blvd') },
        coordinates: randomWalk(rand, 8 + Math.floor(rand() * 14), 30),
      }
    case 'major_road':
      return {
        tags: {
          highway: rand() < 0.5 ? 'secondary' : 'primary',
          maxspeed: '55',
          name: randomName(rand, 'Highway'),
        },
        coordinates: randomWalk(rand, 8 + Math.floor(rand() * 14), 30),
      }
    case 'rough_surface':
      return {
        tags: { highway: rand() < 0.5 ? 'footway' : 'residential', surface: 'cobblestone', name: randomName(rand, 'Lane') },
        coordinates: randomWalk(rand, 4 + Math.floor(rand() * 6), 18),
      }
    case 'short_stub':
      // Below the runtime gradient noise floor / a plausible fragment.
      return {
        tags: { highway: 'residential', name: randomName(rand, 'Ct') },
        coordinates: randomWalk(rand, 2, 8),
      }
    case 'crossing_stub':
      return {
        tags: { highway: 'footway', footway: 'crossing' },
        coordinates: randomWalk(rand, 2, 5),
      }
    case 'control_node':
      return {
        tags: { highway: 'traffic_signals' },
        coordinates: randomWalk(rand, 1, 0),
      }
  }
}

function genWays(rand: () => number, count: number): Array<{ tags: Record<string, string>; coordinates: [number, number][] }> {
  return Array.from({ length: count }, () => buildWay(rand, pickCategory(rand)))
}

/** Bake plausible enrichment fields onto an already-built way. */
function bake(rand: () => number, w: { tags: Record<string, string>; coordinates: [number, number][] }): {
  gradientPct: number | null
  accessGradientPct: number | null
  componentPaintedLenM: number | null
} {
  // ~8% DEM-void (null) — matches the "bake couldn't grade it" fail-soft path.
  if (rand() < 0.08) return { gradientPct: null, accessGradientPct: null, componentPaintedLenM: null }
  // Mostly gentle grades; a deliberate tail past the 6-10% overlay ceilings
  // so the arithmetic gate actually has ways to hide.
  const gradientPct = rand() < 0.12 ? 10 + rand() * 15 : rand() * 6
  const accessGradientPct = rand() < 0.08 ? 10 + rand() * 15 : gradientPct * (0.8 + rand() * 0.4)
  // Mostly well above the FRAGMENT_MIN_LEN_M=100 floor; a deliberate tail
  // below it so the fragment gate has candidates too.
  const componentPaintedLenM = rand() < 0.1 ? rand() * 90 : 100 + rand() * 3000
  return {
    gradientPct: round2(gradientPct),
    accessGradientPct: round2(accessGradientPct),
    componentPaintedLenM: round2(componentPaintedLenM),
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

function main(): void {
  const { values } = parseArgs({
    options: {
      seed: { type: 'string' },
      count: { type: 'string' },
    },
  })
  const seed = Number(values.seed ?? '1')
  const count = Number(values.count ?? '1500')

  // Two independent streams (same seed) so raw and enriched share
  // identical geometry/tags — only the baked fields are additive.
  const structureRand = mulberry32(seed)
  const built = genWays(structureRand, count)

  let nextOsmId = 1
  const rawWays: RawWay[] = built.map((w) => ({
    osmId: nextOsmId++,
    itemName: null,
    tags: w.tags,
    coordinates: w.coordinates,
  }))

  nextOsmId = 1
  const bakeRand = mulberry32(seed + 1)
  const enrichedWays: EnrichedWayOut[] = built.map((w) => ({
    osmId: nextOsmId++,
    itemName: null,
    tags: w.tags,
    coordinates: w.coordinates,
    ...bake(bakeRand, w),
  }))

  const outDir = import.meta.dir
  const rawPath = join(outDir, 'overlay-bench-raw.json')
  const enrichedPath = join(outDir, 'overlay-bench-enriched.json')

  writeFileSync(rawPath, JSON.stringify(rawWays, null, 1) + '\n')
  writeFileSync(enrichedPath, JSON.stringify({
    meta: { builtFromSeq: 999999, builtAt: '2026-07-11T00:00:00Z', pipelineVersion: '1', demSource: 'terrarium-v1' },
    ways: enrichedWays,
  }, null, 1) + '\n')

  console.log(`wrote ${rawWays.length} ways -> ${rawPath}`)
  console.log(`wrote ${enrichedWays.length} ways -> ${enrichedPath}`)
}

if (import.meta.main) main()
