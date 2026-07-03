import { describe, expect, test } from 'bun:test'

import { computeMoatIsolation, type MoatOptions } from '../src/services/overlayReachability'
import type { OsmWay } from '../src/utils/types'

// Fixtures live well inside OSM tile (row 525, col 134) — lat ~52.55,
// lng ~13.45 — so tile derivation isn't sitting on a 0.1° boundary.
// 0.001° of latitude ≈ 111 m.

function way(
  osmId: number,
  coordinates: [number, number][],
  tags: Record<string, string> = { highway: 'residential' },
): OsmWay {
  return { osmId, itemName: null, coordinates, tags }
}

/** gradientPct keyed by osmId; missing entries are null (unknown). */
function gradients(byId: Record<number, number | null>): MoatOptions['gradientPct'] {
  return (w) => byId[w.osmId as number] ?? null
}

/** Every tile loaded → no tile has an unloaded 4-neighbor → no edge fail-soft. */
const allTilesLoaded = () => true

function opts(overrides: Partial<MoatOptions> & Pick<MoatOptions, 'gradientPct'>): MoatOptions {
  return {
    maxGradientPct: 10,
    pushBudgetM: 0,
    isTileLoaded: allTilesLoaded,
    ...overrides,
  }
}

// The canonical moat: a flat mainland street (~555 m), a steep ramp
// (~111 m, 20%), and a flat island trail (~111 m) reachable only via the ramp.
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

describe('computeMoatIsolation', () => {
  test('hides a flat island behind a steep moat; keeps the mainland', () => {
    const isolated = computeMoatIsolation(
      [MAINLAND, RAMP, ISLAND],
      opts({ gradientPct: gradients(MOAT_GRADIENTS) }),
    )
    expect(isolated.has(3)).toBe(true)   // island: unreachable without the 20% climb
    expect(isolated.has(1)).toBe(false)  // mainland
    // The ramp touches the mainland, so it's not moat-isolated — the
    // existing per-way local gradient gate is what hides it.
    expect(isolated.has(2)).toBe(false)
  })

  test('keeps an island connected to the mainland via a flat street — any FETCHED way connects, even unpainted LTS-4', () => {
    // Flat primary road WITH a painted bike lane as the alternate access —
    // an input the production Overpass query actually fetches (via the
    // cycleway-tag sub-query), unlike a bare untagged arterial. Physical
    // access, not pleasantness: the overlay never paints this for kid
    // modes, but it still connects.
    const flatAccess = way(4, [
      [52.5550, 13.4500],
      [52.5560, 13.4500],
    ], { highway: 'primary', cycleway: 'lane' })
    const isolated = computeMoatIsolation(
      [MAINLAND, RAMP, ISLAND, flatAccess],
      opts({ gradientPct: gradients({ ...MOAT_GRADIENTS, 4: 2 }) }),
    )
    expect(isolated.size).toBe(0)
  })

  test('pushBudgetM admits a short steep ramp and the island behind it', () => {
    // ~55 m ramp at 20% — walkable with the bike if the budget allows.
    const shortRamp = way(2, [
      [52.5550, 13.4500],
      [52.5555, 13.4500],
    ], { highway: 'path' })
    const island = way(3, [
      [52.5555, 13.4500],
      [52.5565, 13.4500],
    ], { highway: 'cycleway' })

    const strict = computeMoatIsolation(
      [MAINLAND, shortRamp, island],
      opts({ gradientPct: gradients(MOAT_GRADIENTS), pushBudgetM: 0 }),
    )
    expect(strict.has(3)).toBe(true)

    const withBudget = computeMoatIsolation(
      [MAINLAND, shortRamp, island],
      opts({ gradientPct: gradients(MOAT_GRADIENTS), pushBudgetM: 60 }),
    )
    expect(withBudget.size).toBe(0)
  })

  test('null gradient is passable (fail-soft)', () => {
    const isolated = computeMoatIsolation(
      [MAINLAND, RAMP, ISLAND],
      opts({ gradientPct: gradients({ 1: 0, 2: null, 3: 0 }) }),
    )
    expect(isolated.size).toBe(0)
  })

  test('gradient exactly at the ceiling is passable (inclusive bound)', () => {
    const isolated = computeMoatIsolation(
      [MAINLAND, RAMP, ISLAND],
      opts({ gradientPct: gradients({ 1: 0, 2: 10, 3: 0 }), maxGradientPct: 10 }),
    )
    expect(isolated.size).toBe(0)
  })

  test('treats a component at the edge of tile coverage as connected', () => {
    // Only the fixture's own tile is loaded → it has unloaded 4-neighbors →
    // it's an outermost tile, so the island's access road may simply not be
    // loaded yet. Same fixture as the moat test; only tile coverage differs.
    const onlyOwnTileLoaded = (row: number, col: number) => row === 525 && col === 134
    const isolated = computeMoatIsolation(
      [MAINLAND, RAMP, ISLAND],
      opts({ gradientPct: gradients(MOAT_GRADIENTS), isTileLoaded: onlyOwnTileLoaded }),
    )
    expect(isolated.size).toBe(0)
  })

  test('skips ways with fewer than 2 coords (traffic-control pseudo-ways)', () => {
    const pseudo = way(99, [[52.5500, 13.4500]], { highway: 'traffic_signals' })
    const isolated = computeMoatIsolation(
      [MAINLAND, RAMP, ISLAND, pseudo],
      opts({ gradientPct: gradients(MOAT_GRADIENTS) }),
    )
    expect(isolated.has(99)).toBe(false)
    expect(isolated.has(3)).toBe(true)
  })

  test('monotonicity: raising maxGradientPct never hides a previously-shown way', () => {
    // Mainland running west→east with three islands branching north, each
    // behind a ramp of a different steepness.
    const mainland = way(10, [
      [52.5500, 13.4500],
      [52.5500, 13.4510],
      [52.5500, 13.4520],
      [52.5500, 13.4530],
      [52.5500, 13.4540],
      [52.5500, 13.4550],
    ])
    const ramp5 = way(11, [[52.5500, 13.4510], [52.5510, 13.4510]])
    const island5 = way(12, [[52.5510, 13.4510], [52.5520, 13.4510]])
    const ramp12 = way(13, [[52.5500, 13.4520], [52.5510, 13.4520]])
    const island12 = way(14, [[52.5510, 13.4520], [52.5520, 13.4520]])
    const ramp18 = way(15, [[52.5500, 13.4530], [52.5510, 13.4530]])
    const island18 = way(16, [[52.5510, 13.4530], [52.5520, 13.4530]])
    const ways = [mainland, ramp5, island5, ramp12, island12, ramp18, island18]
    const g = gradients({ 10: 0, 11: 5, 12: 0, 13: 12, 14: 0, 15: 18, 16: 0 })

    let prevShown: Set<string | number> | null = null
    for (const ceiling of [4, 6, 10, 14, 20]) {
      const isolated = computeMoatIsolation(ways, opts({ gradientPct: g, maxGradientPct: ceiling }))
      const shown = new Set<string | number>(
        ways.map((w) => w.osmId).filter((id) => !isolated.has(id)),
      )
      if (prevShown) {
        for (const id of prevShown) expect(shown.has(id)).toBe(true)
      }
      prevShown = shown
    }
    // Sanity on the endpoints. At ceiling 4 (below the fixed mainland-seed
    // ceiling of 6 — no shipping mode goes that low) island5 stays shown:
    // it belongs to the baseline seed component, a documented fail-soft.
    // The 12% and 18% islands are hidden.
    const strictest = computeMoatIsolation(ways, opts({ gradientPct: g, maxGradientPct: 4 }))
    expect(strictest).toEqual(new Set<string | number>([14, 16]))
    const loosest = computeMoatIsolation(ways, opts({ gradientPct: g, maxGradientPct: 20 }))
    expect(loosest.size).toBe(0)
  })

  test('monotone across DISCONNECTED networks: raising the ceiling never flips which one is mainland', () => {
    // Regression: two networks with no fetched connection between them
    // (realistic — the Overpass query skips untagged arterials, learnings.md
    // documents these gaps fragmenting the SF graph).
    //   A = 666 m flat.
    //   B = 555 m flat + 333 m at 12%, so B's passable length OVERTAKES A's
    //       once the ceiling admits the steep way (888 m > 666 m).
    // With per-ceiling argmax mainland selection this flipped mainland from
    // A to B at high ceilings, hiding A — a way kid-starting-out could see
    // vanished for the more capable mode. The fixed baseline seed keeps A
    // mainland at every ceiling.
    const netA = way(20, [
      [52.5500, 13.4500],
      [52.5510, 13.4500],
      [52.5520, 13.4500],
      [52.5530, 13.4500],
      [52.5540, 13.4500],
      [52.5550, 13.4500],
      [52.5560, 13.4500],
    ])
    const netBFlat = way(21, [
      [52.5500, 13.4600],
      [52.5510, 13.4600],
      [52.5520, 13.4600],
      [52.5530, 13.4600],
      [52.5540, 13.4600],
      [52.5550, 13.4600],
    ])
    const netBSteep = way(22, [
      [52.5550, 13.4600],
      [52.5560, 13.4600],
      [52.5570, 13.4600],
      [52.5580, 13.4600],
    ], { highway: 'path' })
    const ways = [netA, netBFlat, netBSteep]
    const g = gradients({ 20: 0, 21: 0, 22: 12 })

    // Ceiling 6: A is mainland; B borders its own too-steep way (moat
    // evidence) and is disconnected → hidden.
    const low = computeMoatIsolation(ways, opts({ gradientPct: g, maxGradientPct: 6 }))
    expect(low).toEqual(new Set<string | number>([21, 22]))
    // Ceiling 15: B's steep way is now passable for this mode — B carries
    // no moat evidence any more, so it shows (fail-soft on the possibly
    // unfetched connector). A MUST stay shown (this was the flip bug).
    const high = computeMoatIsolation(ways, opts({ gradientPct: g, maxGradientPct: 15 }))
    expect(high.size).toBe(0)
  })

  test('fail-soft on data gaps: a disconnected component with NO steep border stays shown', () => {
    // Regression: a flat waterfront promenade whose only real links to the
    // grid are trailheads on an untagged arterial. The arterial is never
    // fetched (overpass.ts buildQuery), so the promenade is its own
    // component in the interior of loaded coverage — but nothing steep
    // touches it, so there is no evidence of a moat. Hiding it would be a
    // fail-HIDE on unfetched data; it must stay shown.
    const promenade = way(30, [
      [52.5500, 13.4600],
      [52.5510, 13.4600],
      [52.5520, 13.4600],
    ], { highway: 'footway', bicycle: 'designated' })
    const isolated = computeMoatIsolation(
      [MAINLAND, promenade],
      opts({ gradientPct: gradients({ 1: 0, 30: 1 }) }),
    )
    expect(isolated.size).toBe(0)
  })
})

// ── inheritStubVerdicts ─────────────────────────────────────────────────────
//
// Sub-noise-floor stubs (gradient null) inherit the verdict of their graded
// painted context instead of individually fail-softing to shown — the
// white-pill-confetti fix from the #208→#209 revert.

import { inheritStubVerdicts, type StubVerdict } from '../src/services/overlayReachability'

function verdicts(byId: Record<number, StubVerdict>): (w: OsmWay) => StubVerdict {
  return (w) => byId[w.osmId as number] ?? 'unknown'
}

// Shared geometry: a long way A [52.55,13.45]→[52.551,13.45], a stub S
// touching A's far end, and a long way B continuing from the stub's far end.
const LONG_A = way(10, [
  [52.5500, 13.4500],
  [52.5510, 13.4500],
])
const STUB = way(11, [
  [52.5510, 13.4500],
  [52.5512, 13.4500],
])
const LONG_B = way(12, [
  [52.5512, 13.4500],
  [52.5522, 13.4500],
])
// A second stub chained onto the first (shares only the stub's far end).
const STUB_2 = way(13, [
  [52.5512, 13.4500],
  [52.5514, 13.4500],
])

describe('inheritStubVerdicts', () => {
  test('stub adjacent only to hidden ways inherits hidden', () => {
    const hidden = inheritStubVerdicts(
      [LONG_A, STUB],
      verdicts({ 10: 'hidden', 11: 'unknown' }),
    )
    expect(hidden.has(11)).toBe(true)
  })

  test('stub touching any shown way stays shown', () => {
    const hidden = inheritStubVerdicts(
      [LONG_A, STUB, LONG_B],
      verdicts({ 10: 'hidden', 11: 'unknown', 12: 'shown' }),
    )
    expect(hidden.size).toBe(0)
  })

  test('standalone stub with no graded adjacency keeps the old fail-soft (shown)', () => {
    const hidden = inheritStubVerdicts([STUB], verdicts({ 11: 'unknown' }))
    expect(hidden.size).toBe(0)
  })

  test('a chain of stubs inherits as a unit', () => {
    // STUB touches hidden LONG_A; STUB_2 touches only STUB. Both hide.
    const hidden = inheritStubVerdicts(
      [LONG_A, STUB, STUB_2],
      verdicts({ 10: 'hidden', 11: 'unknown', 13: 'unknown' }),
    )
    expect(hidden.has(11)).toBe(true)
    expect(hidden.has(13)).toBe(true)
  })

  test('a chain rescued by one shown way at either end stays shown as a unit', () => {
    const hidden = inheritStubVerdicts(
      [LONG_A, STUB, STUB_2, LONG_B],
      verdicts({ 10: 'hidden', 11: 'unknown', 13: 'unknown', 12: 'shown' }),
    )
    expect(hidden.size).toBe(0)
  })

  test('graded ways never appear in the result', () => {
    const hidden = inheritStubVerdicts(
      [LONG_A, STUB],
      verdicts({ 10: 'hidden', 11: 'unknown' }),
    )
    expect(hidden.has(10)).toBe(false)
  })
})

// ── smallFragmentIds ────────────────────────────────────────────────────────
//
// Floating-fragment floor: surviving painted components shorter than the
// threshold (total length) are display-hidden at overview zooms.

import { smallFragmentIds } from '../src/services/overlayReachability'

// ~55 m stub, standalone.
const LONE_STUB = way(20, [
  [52.5600, 13.4500],
  [52.5605, 13.4500],
])
// Two ~55 m stubs sharing an endpoint → ~111 m component.
const CHAIN_A = way(21, [
  [52.5700, 13.4500],
  [52.5705, 13.4500],
])
const CHAIN_B = way(22, [
  [52.5705, 13.4500],
  [52.5710, 13.4500],
])
// ~555 m long way with a ~55 m spur attached.
const LONG_WAY = way(23, [
  [52.5800, 13.4500],
  [52.5850, 13.4500],
])
const SPUR = way(24, [
  [52.5850, 13.4500],
  [52.5855, 13.4500],
])

describe('smallFragmentIds', () => {
  test('standalone short fragment is flagged', () => {
    const small = smallFragmentIds([LONE_STUB], 100)
    expect(small.has(20)).toBe(true)
  })

  test('chained fragments summing over the floor are kept', () => {
    const small = smallFragmentIds([CHAIN_A, CHAIN_B], 100)
    expect(small.size).toBe(0)
  })

  test('short spur attached to a long way is kept (component length counts)', () => {
    const small = smallFragmentIds([LONG_WAY, SPUR], 100)
    expect(small.size).toBe(0)
  })

  test('threshold is strict less-than', () => {
    // CHAIN_A alone is ~55 m — under a 56 m floor, over a 55 m floor.
    expect(smallFragmentIds([CHAIN_A], 56).has(21)).toBe(true)
    expect(smallFragmentIds([CHAIN_A], 40).has(21)).toBe(false)
  })

  test('mixed input flags only the small component', () => {
    const small = smallFragmentIds([LONE_STUB, LONG_WAY, SPUR], 100)
    expect(small.has(20)).toBe(true)
    expect(small.has(23)).toBe(false)
    expect(small.has(24)).toBe(false)
  })
})
