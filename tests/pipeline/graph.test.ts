import { describe, expect, test } from 'bun:test'

import {
  MAINLAND_SEED_CEILING_PCT,
  computeAccessGradientPct,
  computeComponentPaintedLenM,
  isPaintedCandidate,
  wayLengthM,
} from '../../scripts/pipeline/lib/graph'
import type { PipelineWay } from '../../scripts/pipeline/lib/tiles'

// Geometry conventions match tests/overlayReachability.test.ts (the runtime
// implementation this bake supersedes): fixtures near lat 52.55 / lng 13.45,
// 0.001° of latitude ≈ 111 m.

function way(
  osmId: number,
  coordinates: [number, number][],
  tags: Record<string, string> = { highway: 'residential' },
): PipelineWay {
  return { osmId, tags, coordinates, isControlNode: false }
}

/** gradientPct keyed by osmId; missing entries are null (unknown). */
function gradients(byId: Record<number, number | null>): (osmId: number) => number | null {
  return (osmId) => byId[osmId] ?? null
}

// The canonical moat: a flat mainland street (~555 m), a steep ramp
// (~111 m, 20%), and a flat island trail (~111 m) reachable only via the
// ramp — same shape as the computeMoatIsolation fixtures.
const MAINLAND = way(1, [
  [52.5500, 13.4500],
  [52.5510, 13.4500],
  [52.5520, 13.4500],
  [52.5530, 13.4500],
  [52.5540, 13.4500],
  [52.5550, 13.4500],
])
const RAMP = way(2, [
  [52.5550, 13.4500],
  [52.5560, 13.4500],
], { highway: 'path' })
const ISLAND = way(3, [
  [52.5560, 13.4500],
  [52.5570, 13.4500],
], { highway: 'cycleway' })
const MOAT_GRADIENTS = { 1: 0, 2: 20, 3: 0 }

describe('computeAccessGradientPct', () => {
  test('island behind a steep ramp: access = the ramp gradient; mainland = 0', () => {
    const access = computeAccessGradientPct([MAINLAND, RAMP, ISLAND], gradients(MOAT_GRADIENTS))
    expect(access.get(1)).toBe(0)
    // The ramp touches the mainland — access 0; its OWN gradient gate is
    // what hides it (computeMoatIsolation convention).
    expect(access.get(2)).toBe(0)
    expect(access.get(3)).toBe(20)
  })

  test('minimax: the gentler of two ramps sets the island access', () => {
    const gentleRamp = way(4, [
      [52.5550, 13.4510],
      [52.5560, 13.4500],
    ], { highway: 'path' })
    // gentleRamp shares the island's entry node but starts one node east —
    // connect it to the mainland with a flat spur.
    const spur = way(5, [
      [52.5550, 13.4500],
      [52.5550, 13.4510],
    ])
    const access = computeAccessGradientPct(
      [MAINLAND, RAMP, ISLAND, gentleRamp, spur],
      gradients({ ...MOAT_GRADIENTS, 4: 8, 5: 0 }),
    )
    expect(access.get(3)).toBe(8)
  })

  test('bottleneck chains: a second island takes the max gradient along its best path', () => {
    const ramp2 = way(4, [
      [52.5570, 13.4500],
      [52.5580, 13.4500],
    ], { highway: 'path' })
    const island2 = way(5, [
      [52.5580, 13.4500],
      [52.5590, 13.4500],
    ], { highway: 'cycleway' })
    const g = { ...MOAT_GRADIENTS, 4: 12, 5: 0 }
    const access = computeAccessGradientPct([MAINLAND, RAMP, ISLAND, ramp2, island2], gradients(g))
    // Only path: mainland -20%-> island -12%-> island2 ⇒ bottleneck 20.
    expect(access.get(5)).toBe(20)

    // A gentle (8%) bypass of the FIRST ramp lowers island to 8 and
    // island2 to max(8, 12) = 12 — minimax, not additive.
    const bypass = way(6, [
      [52.5550, 13.4500],
      [52.5560, 13.4500],
    ], { highway: 'path' })
    const access2 = computeAccessGradientPct(
      [MAINLAND, RAMP, ISLAND, ramp2, island2, bypass],
      gradients({ ...g, 6: 8 }),
    )
    expect(access2.get(3)).toBe(8)
    expect(access2.get(5)).toBe(12)
  })

  test('null gradient is fail-soft: an ungraded ramp contributes 0 to the bottleneck', () => {
    const access = computeAccessGradientPct(
      [MAINLAND, RAMP, ISLAND],
      gradients({ 1: 0, 2: null, 3: 0 }),
    )
    expect(access.get(3)).toBe(0)
  })

  test('topologically disconnected component: null (may be an unfetched-connector data gap)', () => {
    const farIsland = way(7, [
      [52.5500, 13.4700],
      [52.5510, 13.4700],
    ], { highway: 'cycleway' })
    const access = computeAccessGradientPct(
      [MAINLAND, RAMP, ISLAND, farIsland],
      gradients({ ...MOAT_GRADIENTS, 7: 0 }),
    )
    expect(access.get(7)).toBeNull()
  })

  test('mainland seed = largest component by BASELINE-passable length, not raw length', () => {
    // Rival network: 666 m total, but every way is steeper than the 6%
    // baseline — its baseline-passable length is 0, so it can never be
    // the seed no matter how long it is.
    const steepA = way(8, [
      [52.5600, 13.4600],
      [52.5630, 13.4600],
    ])
    const steepB = way(9, [
      [52.5630, 13.4600],
      [52.5660, 13.4600],
    ])
    const access = computeAccessGradientPct(
      [MAINLAND, steepA, steepB],
      gradients({ 1: 0, 8: 9, 9: 9 }),
    )
    expect(access.get(1)).toBe(0) // 555 m flat mainland wins
    expect(access.get(8)).toBeNull() // disconnected from the seed
    expect(access.get(9)).toBeNull()
  })

  test('baseline ceiling is inclusive: a component of exactly-6% ways can seed', () => {
    expect(MAINLAND_SEED_CEILING_PCT).toBe(6)
    // 666 m of 6.0% ways vs the 555 m flat mainland — the 6% component is
    // baseline-passable (inclusive bound) and longer, so IT seeds and the
    // old mainland becomes the disconnected one.
    const sixA = way(8, [
      [52.5600, 13.4600],
      [52.5630, 13.4600],
    ])
    const sixB = way(9, [
      [52.5630, 13.4600],
      [52.5660, 13.4600],
    ])
    const access = computeAccessGradientPct(
      [MAINLAND, sixA, sixB],
      gradients({ 1: 0, 8: 6, 9: 6 }),
    )
    expect(access.get(8)).toBe(0)
    expect(access.get(9)).toBe(0)
    expect(access.get(1)).toBeNull()
  })

  test('a steep spur inside the mainland: spur 0 (touches seed), the way beyond it inherits the spur gradient', () => {
    const spur = way(10, [
      [52.5500, 13.4500],
      [52.5500, 13.4510],
    ])
    const beyond = way(11, [
      [52.5500, 13.4510],
      [52.5500, 13.4520],
    ], { highway: 'cycleway' })
    const access = computeAccessGradientPct(
      [MAINLAND, spur, beyond],
      gradients({ 1: 0, 10: 15, 11: 0 }),
    )
    expect(access.get(10)).toBe(0)
    expect(access.get(11)).toBe(15)
  })

  test('control-node pseudo-ways and single-coordinate ways are skipped', () => {
    const signal: PipelineWay = {
      osmId: 301,
      tags: { highway: 'traffic_signals' },
      coordinates: [[52.5500, 13.4500]],
      isControlNode: true,
    }
    const access = computeAccessGradientPct([MAINLAND, signal], gradients({ 1: 0 }))
    expect(access.has(301)).toBe(false)
    expect(access.get(1)).toBe(0)
  })
})

describe('isPaintedCandidate (pass-0a mode-independent gates via production classifiers)', () => {
  test('paintable classes are candidates', () => {
    expect(isPaintedCandidate({ highway: 'cycleway' })).toBe(true)
    expect(isPaintedCandidate({ highway: 'residential' })).toBe(true)
    expect(isPaintedCandidate({ highway: 'living_street' })).toBe(true)
  })

  test('pathLevel 4, crossings, and rough surfaces are not', () => {
    expect(isPaintedCandidate({ highway: 'secondary' })).toBe(false) // LTS 4
    expect(isPaintedCandidate({ highway: 'footway', footway: 'crossing', bicycle: 'yes' })).toBe(false)
    expect(isPaintedCandidate({ highway: 'cycleway', surface: 'gravel' })).toBe(false)
  })
})

describe('computeComponentPaintedLenM', () => {
  const LONG_CYCLEWAY = way(20, [
    [52.5500, 13.4500],
    [52.5510, 13.4500],
    [52.5520, 13.4500],
    [52.5530, 13.4500],
    [52.5540, 13.4500],
    [52.5550, 13.4500],
  ], { highway: 'cycleway' })
  // ~11 m stub sharing the cycleway's north endpoint — the sub-noise-floor
  // fragment class the baked field exists to give context to.
  const STUB = way(21, [
    [52.5550, 13.4500],
    [52.5551, 13.4500],
  ], { highway: 'cycleway' })

  test('a stub attached to a long network reports the whole component length', () => {
    const total = wayLengthM(LONG_CYCLEWAY.coordinates) + wayLengthM(STUB.coordinates)
    const lens = computeComponentPaintedLenM([LONG_CYCLEWAY, STUB])
    expect(lens.get(21)).toBeCloseTo(total, 6)
    expect(lens.get(20)).toBeCloseTo(total, 6)
  })

  test('an isolated stub reports only its own length', () => {
    const lone = way(22, [
      [52.5600, 13.4600],
      [52.5601, 13.4600],
    ], { highway: 'cycleway' })
    const lens = computeComponentPaintedLenM([LONG_CYCLEWAY, lone])
    expect(lens.get(22)).toBeCloseTo(wayLengthM(lone.coordinates), 6)
  })

  test('non-candidates are excluded AND do not bridge components (mirrors runtime survivors-only union)', () => {
    const cycleA = way(30, [
      [52.5500, 13.4500],
      [52.5510, 13.4500],
    ], { highway: 'cycleway' })
    const crossing = way(31, [
      [52.5510, 13.4500],
      [52.5511, 13.4500],
    ], { highway: 'footway', footway: 'crossing', bicycle: 'yes' })
    const cycleB = way(32, [
      [52.5511, 13.4500],
      [52.5521, 13.4500],
    ], { highway: 'cycleway' })
    const lens = computeComponentPaintedLenM([cycleA, crossing, cycleB])
    expect(lens.has(31)).toBe(false) // never painted → no baked length
    expect(lens.get(30)).toBeCloseTo(wayLengthM(cycleA.coordinates), 6)
    expect(lens.get(32)).toBeCloseTo(wayLengthM(cycleB.coordinates), 6)
  })

  test('rough-surface and LTS-4 ways are excluded', () => {
    const gravel = way(33, [
      [52.5500, 13.4500],
      [52.5510, 13.4500],
    ], { highway: 'cycleway', surface: 'gravel' })
    const major = way(34, [
      [52.5510, 13.4500],
      [52.5520, 13.4500],
    ], { highway: 'secondary' })
    const lens = computeComponentPaintedLenM([gravel, major])
    expect(lens.size).toBe(0)
  })

  test('painted candidates of different classes union across shared nodes', () => {
    const residential = way(35, [
      [52.5550, 13.4500],
      [52.5550, 13.4510],
    ])
    const total =
      wayLengthM(LONG_CYCLEWAY.coordinates) + wayLengthM(residential.coordinates)
    const lens = computeComponentPaintedLenM([LONG_CYCLEWAY, residential])
    expect(lens.get(35)).toBeCloseTo(total, 6)
  })

  test('control nodes are skipped', () => {
    const signal: PipelineWay = {
      osmId: 301,
      tags: { highway: 'traffic_signals' },
      coordinates: [[52.5500, 13.4500]],
      isControlNode: true,
    }
    const lens = computeComponentPaintedLenM([LONG_CYCLEWAY, signal])
    expect(lens.has(301)).toBe(false)
  })
})
