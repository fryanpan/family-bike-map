import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  DEFAULT_MIN_LENGTH_M,
  DEFAULT_TOLERANCE_DEG,
  bucketIntoOverviewCells,
  isOverviewCandidate,
  latLngToOverviewCell,
  readDetailWays,
  reduceWay,
} from '../../scripts/pipeline/bake-overview'
import type { EnrichedWay } from '../../scripts/pipeline/lib/tiles'
import { classifyEdge } from '../../src/utils/lts'

const OPTS = { toleranceDeg: DEFAULT_TOLERANCE_DEG, minLengthM: DEFAULT_MIN_LENGTH_M }

/** A straight west-east way of roughly `meters` length starting at (lat, lng). */
function straightWay(
  osmId: number,
  tags: Record<string, string>,
  lat: number,
  lng: number,
  meters: number,
  points = 2,
): EnrichedWay {
  // ~88 km per lng degree at 37.8°N.
  const spanLng = meters / 88_000
  const coordinates: [number, number][] = []
  for (let i = 0; i < points; i++) {
    coordinates.push([lat, lng + (spanLng * i) / (points - 1)])
  }
  return {
    osmId, itemName: null, tags, coordinates,
    gradientPct: 3.3, accessGradientPct: 1.1, componentPaintedLenM: 4000,
  }
}

describe('isOverviewCandidate — the bike-infra network filter', () => {
  test('keeps carFree infrastructure (cycleway, path, track)', () => {
    const cases: Record<string, string>[] = [
      { highway: 'cycleway' },
      { highway: 'path', bicycle: 'designated' },
      { highway: 'footway', bicycle: 'designated' },
      { highway: 'track' },
    ]
    for (const tags of cases) {
      expect(classifyEdge(tags).carFree).toBe(true)
      expect(isOverviewCandidate(tags)).toBe(true)
    }
  })

  test('keeps bikePriority streets (Fahrradstrasse, living street, SF slow street)', () => {
    const cases: Record<string, string>[] = [
      { highway: 'residential', bicycle_road: 'yes' },
      { highway: 'living_street' },
      { highway: 'residential', motor_vehicle: 'destination' },
    ]
    for (const tags of cases) {
      expect(classifyEdge(tags).bikePriority).toBe(true)
      expect(isOverviewCandidate(tags)).toBe(true)
    }
  })

  test('keeps roads carrying bike infrastructure (painted lane / track on a street)', () => {
    const tags = { highway: 'tertiary', cycleway: 'lane' }
    expect(classifyEdge(tags).bikeInfra).toBe(true)
    expect(isOverviewCandidate(tags)).toBe(true)
  })

  test('DROPS plain quiet residential — the deliberate overview reduction', () => {
    const tags = { highway: 'residential' }
    const c = classifyEdge(tags)
    expect(c.carFree).toBe(false)
    expect(c.bikePriority).toBe(false)
    expect(c.bikeInfra).toBe(false)
    expect(isOverviewCandidate(tags)).toBe(false)
  })

  test('DROPS bare arterials with no bike infrastructure', () => {
    expect(isOverviewCandidate({ highway: 'secondary' })).toBe(false)
    expect(isOverviewCandidate({ highway: 'motorway' })).toBe(false)
  })
})

describe('reduceWay', () => {
  test('drops non-candidates (plain residential) whatever their length', () => {
    expect(reduceWay(straightWay(1, { highway: 'residential' }, 37.8, -122.4, 5000), OPTS)).toBeNull()
  })

  test('drops control-node pseudo-ways (router input, never painted)', () => {
    const node: EnrichedWay = {
      osmId: 9, itemName: null, tags: { highway: 'traffic_signals' },
      coordinates: [[37.8, -122.4]],
      gradientPct: null, accessGradientPct: null, componentPaintedLenM: null,
    }
    expect(reduceWay(node, OPTS)).toBeNull()
  })

  test('drops candidate ways shorter than the 200 m floor (sub-pixel at z10)', () => {
    expect(reduceWay(straightWay(2, { highway: 'cycleway' }, 37.8, -122.4, 150), OPTS)).toBeNull()
    expect(reduceWay(straightWay(3, { highway: 'cycleway' }, 37.8, -122.4, 400), OPTS)).not.toBeNull()
  })

  test('applies the length floor AFTER simplification', () => {
    // A zig-zag whose vertices span only ~120 m of true extent but whose raw
    // polyline length is >200 m: simplification collapses it, and the floor
    // then drops it — that ordering is what keeps sub-pixel confetti out.
    const coordinates: [number, number][] = []
    for (let i = 0; i < 40; i++) {
      coordinates.push([37.8 + (i % 2) * 0.00002, -122.4 + (i * 0.0000015)])
    }
    const zig: EnrichedWay = {
      osmId: 4, itemName: null, tags: { highway: 'cycleway' }, coordinates,
      gradientPct: null, accessGradientPct: null, componentPaintedLenM: null,
    }
    expect(reduceWay(zig, OPTS)).toBeNull()
  })

  test('simplifies geometry at the ~110 m tolerance, dropping collinear-ish vertices', () => {
    const way = straightWay(5, { highway: 'cycleway' }, 37.8, -122.4, 4000, 50)
    const reduced = reduceWay(way, OPTS)!
    expect(reduced.coordinates.length).toBeLessThan(way.coordinates.length)
    expect(reduced.coordinates.length).toBe(2) // a straight line collapses to its endpoints
    // Endpoints are preserved exactly — Douglas-Peucker never moves them.
    expect(reduced.coordinates[0]).toEqual(way.coordinates[0])
    expect(reduced.coordinates[reduced.coordinates.length - 1])
      .toEqual(way.coordinates[way.coordinates.length - 1])
  })

  test('keeps the FULL tags and enriched fields (client runs the same classifier + gates)', () => {
    const way = straightWay(6, { highway: 'cycleway', surface: 'asphalt', name: 'Bay Trail' }, 37.8, -122.4, 3000, 12)
    const reduced = reduceWay(way, OPTS)!
    expect(reduced.tags).toEqual(way.tags)
    expect(reduced.osmId).toBe(6)
    expect(reduced.gradientPct).toBe(3.3)
    expect(reduced.accessGradientPct).toBe(1.1)
    expect(reduced.componentPaintedLenM).toBe(4000)
    expect(reduced.itemName).toBeNull()
  })

  test('a tighter tolerance keeps more vertices (the size-budget lever)', () => {
    // A gentle curve — DP keeps more of it as the tolerance shrinks.
    const coordinates: [number, number][] = []
    for (let i = 0; i < 60; i++) {
      coordinates.push([37.8 + Math.sin(i / 10) * 0.01, -122.4 + i * 0.001])
    }
    const way: EnrichedWay = {
      osmId: 7, itemName: null, tags: { highway: 'cycleway' }, coordinates,
      gradientPct: null, accessGradientPct: null, componentPaintedLenM: null,
    }
    const coarse = reduceWay(way, { toleranceDeg: 0.005, minLengthM: 200 })!
    const fine = reduceWay(way, { toleranceDeg: 0.0002, minLengthM: 200 })!
    expect(fine.coordinates.length).toBeGreaterThan(coarse.coordinates.length)
  })
})

describe('bucketIntoOverviewCells', () => {
  test('assigns a way to the 1° cell containing its vertices', () => {
    const way = straightWay(10, { highway: 'cycleway' }, 37.77, -122.42, 3000)
    const cells = bucketIntoOverviewCells([way])
    expect([...cells.keys()]).toEqual(['37:-123'])
    expect(latLngToOverviewCell(37.77, -122.42)).toEqual({ row: 37, col: -123 })
  })

  test('a way crossing a cell seam lands in BOTH cells with full geometry (no clipped paint)', () => {
    const crossing: EnrichedWay = {
      osmId: 11, itemName: null, tags: { highway: 'cycleway' },
      coordinates: [[37.99, -122.5], [38.01, -122.5]],
      gradientPct: null, accessGradientPct: null, componentPaintedLenM: null,
    }
    const cells = bucketIntoOverviewCells([crossing])
    expect(new Set(cells.keys())).toEqual(new Set(['37:-123', '38:-123']))
    for (const cell of cells.values()) {
      expect(cell.ways[0].coordinates).toHaveLength(2) // full geometry, not clipped
    }
  })

  test('orders ways deterministically by osmId', () => {
    const ways = [30, 10, 20].map((id) => straightWay(id, { highway: 'cycleway' }, 37.5, -122.5, 500))
    const cell = bucketIntoOverviewCells(ways).get('37:-123')!
    expect(cell.ways.map((w) => w.osmId)).toEqual([10, 20, 30])
  })
})

describe('readDetailWays', () => {
  let dir: string
  const meta = { builtFromSeq: 2776, builtAt: 'x', pipelineVersion: '1', demSource: 'terrarium-v1' }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bake-overview-test-'))
    // The same way (osmId 1) is stored in both tiles it spans — bucketIntoTiles
    // semantics. The overview bake must de-duplicate it.
    const shared = straightWay(1, { highway: 'cycleway' }, 37.79, -122.41, 3000)
    const only377 = straightWay(2, { highway: 'living_street' }, 37.75, -122.45, 900)
    const only378 = straightWay(3, { highway: 'residential' }, 37.85, -122.45, 900)
    fs.writeFileSync(path.join(dir, '377_-1225.json'), JSON.stringify({ meta, ways: [shared, only377] }))
    fs.writeFileSync(path.join(dir, '378_-1225.json'), JSON.stringify({ meta, ways: [shared, only378] }))
    fs.writeFileSync(path.join(dir, 'region-state.json'), JSON.stringify({ seq: 2776 }))
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  test('de-duplicates ways stored in more than one detail tile', () => {
    const { ways, meta: readMeta } = readDetailWays(dir)
    expect(ways.map((w) => w.osmId)).toEqual([1, 2, 3])
    expect(readMeta.builtFromSeq).toBe(2776)
  })

  test('end-to-end: the residential way is filtered out, infra ways survive', () => {
    const { ways } = readDetailWays(dir)
    const reduced = ways.map((w) => reduceWay(w, OPTS)).filter((w) => w != null)
    expect(reduced.map((w) => w!.osmId)).toEqual([1, 2]) // 3 = plain residential, dropped
  })

  test('throws on a directory with no tiles (a mistyped path must not bake an empty level)', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bake-overview-empty-'))
    expect(() => readDetailWays(empty)).toThrow(/no tile files/)
    fs.rmSync(empty, { recursive: true, force: true })
  })
})
