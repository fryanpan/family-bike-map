/**
 * Enriched-tile client consumption (chunk B3 of the enriched-tiles plan):
 * the overlay's per-way visibility verdict as pure arithmetic over baked
 * fields, with the runtime moat/gradient path reserved for non-enriched
 * ways.
 *
 *  - isEnrichedWay: field-presence detection (null counts, undefined doesn't)
 *  - enrichedWayVerdict: gradient ceiling, minimax access gate (+push-budget
 *    disable rule), baked fragment floor; null fields fail-soft SHOWN;
 *    never 'unknown'
 *  - monotonicity: shown set grows with the mode ceiling (kid-skill
 *    invariant from learnings.md)
 *  - overlayWayVerdict dispatch: enriched ways NEVER touch the runtime
 *    inputs (no gradient lookups, no moat set); non-enriched ways keep the
 *    exact pre-enrichment truth table (regression: zero enriched ways =
 *    behaviour identical to today)
 */
import { describe, test, expect } from 'bun:test'
import {
  enrichedWayVerdict,
  overlayWayVerdict,
  FRAGMENT_MIN_LEN_M,
  type EnrichedGateOptions,
} from '../src/components/BikeMapOverlay'
import { isEnrichedWay, type OsmWay } from '../src/utils/types'
import { getOverlayMaxGradientPct } from '../src/utils/classify'

function way(overrides: Partial<OsmWay> = {}): OsmWay {
  return {
    osmId: 1,
    itemName: null,
    tags: { highway: 'cycleway' },
    coordinates: [
      [52.5, 13.4],
      [52.501, 13.4],
    ],
    ...overrides,
  }
}

function gateOpts(overrides: Partial<EnrichedGateOptions> = {}): EnrichedGateOptions {
  return {
    maxGradientPct: 8,
    steepApproachPushM: 0,
    fragmentFloorActive: true,
    ...overrides,
  }
}

// ── isEnrichedWay ───────────────────────────────────────────────────────────

describe('isEnrichedWay', () => {
  test('false for a raw Overpass way (no baked fields at all)', () => {
    expect(isEnrichedWay(way())).toBe(false)
  })

  test('true when any baked field is present with a value', () => {
    expect(isEnrichedWay(way({ gradientPct: 4.2 }))).toBe(true)
    expect(isEnrichedWay(way({ accessGradientPct: 7.8 }))).toBe(true)
    expect(isEnrichedWay(way({ componentPaintedLenM: 5400 }))).toBe(true)
  })

  test('true when baked fields are present but null (enriched tile, DEM void)', () => {
    expect(isEnrichedWay(way({ gradientPct: null, accessGradientPct: null, componentPaintedLenM: null }))).toBe(true)
  })
})

// ── enrichedWayVerdict: arithmetic gate ─────────────────────────────────────

describe('enrichedWayVerdict', () => {
  test('shown when every baked value is within limits', () => {
    const w = way({ gradientPct: 3, accessGradientPct: 5, componentPaintedLenM: 5400 })
    expect(enrichedWayVerdict(w, gateOpts())).toBe('shown')
  })

  test('hidden when own gradient exceeds the ceiling', () => {
    const w = way({ gradientPct: 8.1, accessGradientPct: 2, componentPaintedLenM: 5400 })
    expect(enrichedWayVerdict(w, gateOpts({ maxGradientPct: 8 }))).toBe('hidden')
  })

  test('shown when own gradient equals the ceiling exactly (gate is strictly greater-than)', () => {
    const w = way({ gradientPct: 8, accessGradientPct: 8, componentPaintedLenM: 5400 })
    expect(enrichedWayVerdict(w, gateOpts({ maxGradientPct: 8 }))).toBe('shown')
  })

  test('hidden when access gradient exceeds the ceiling (strict push budget 0)', () => {
    const w = way({ gradientPct: 2, accessGradientPct: 12, componentPaintedLenM: 5400 })
    expect(enrichedWayVerdict(w, gateOpts({ steepApproachPushM: 0 }))).toBe('hidden')
  })

  test('positive push budget disables the baked access gate (fail-soft shown)', () => {
    // The baked minimax is computed at budget 0 and carries no bottleneck
    // length, so a positive budget cannot be applied per approach way —
    // the gate switches off rather than over-hiding.
    const w = way({ gradientPct: 2, accessGradientPct: 12, componentPaintedLenM: 5400 })
    expect(enrichedWayVerdict(w, gateOpts({ steepApproachPushM: 50 }))).toBe('shown')
  })

  test('push budget does NOT excuse the way\'s own gradient (matches runtime local gate)', () => {
    const w = way({ gradientPct: 12, accessGradientPct: 2, componentPaintedLenM: 5400 })
    expect(enrichedWayVerdict(w, gateOpts({ steepApproachPushM: 50 }))).toBe('hidden')
  })

  test('fragment floor: baked component length below the floor hides at overview zooms', () => {
    const w = way({ gradientPct: 2, accessGradientPct: 2, componentPaintedLenM: FRAGMENT_MIN_LEN_M - 1 })
    expect(enrichedWayVerdict(w, gateOpts({ fragmentFloorActive: true }))).toBe('hidden')
  })

  test('fragment floor: component length exactly at the floor stays shown', () => {
    const w = way({ gradientPct: 2, accessGradientPct: 2, componentPaintedLenM: FRAGMENT_MIN_LEN_M })
    expect(enrichedWayVerdict(w, gateOpts({ fragmentFloorActive: true }))).toBe('shown')
  })

  test('fragment floor is zoom-gated: inactive at street-detail zooms', () => {
    const w = way({ gradientPct: 2, accessGradientPct: 2, componentPaintedLenM: 10 })
    expect(enrichedWayVerdict(w, gateOpts({ fragmentFloorActive: false }))).toBe('shown')
  })

  test('null baked fields fail soft to shown (DEM void / stage not yet baked)', () => {
    const w = way({ gradientPct: null, accessGradientPct: null, componentPaintedLenM: null })
    expect(enrichedWayVerdict(w, gateOpts())).toBe('shown')
  })

  test('never returns unknown — the verdict ships with the geometry', () => {
    const samples = [
      way({ gradientPct: null, accessGradientPct: null, componentPaintedLenM: null }),
      way({ gradientPct: 20, accessGradientPct: null, componentPaintedLenM: null }),
      way({ gradientPct: null, accessGradientPct: 20, componentPaintedLenM: null }),
      way({ gradientPct: null, accessGradientPct: null, componentPaintedLenM: 5 }),
      way({ gradientPct: 1, accessGradientPct: 1, componentPaintedLenM: 9999 }),
    ]
    for (const w of samples) {
      expect(['shown', 'hidden']).toContain(enrichedWayVerdict(w, gateOpts()))
    }
  })
})

// ── Monotonicity across mode ceilings ───────────────────────────────────────

describe('enrichedWayVerdict monotonicity across mode ceilings', () => {
  // Kid-skill invariant (learnings.md, Mode rules): as skill increases the
  // shown set grows monotonically. The gate is monotone in maxGradientPct
  // by construction; verify over the REAL per-mode ceilings and a grid of
  // baked values.
  const modesByCeiling = ['kid-starting-out', 'kid-confident', 'kid-traffic-savvy', 'training']

  test('mode ceilings are non-decreasing in the order tested', () => {
    const ceilings = modesByCeiling.map(getOverlayMaxGradientPct)
    for (let i = 1; i < ceilings.length; i++) {
      expect(ceilings[i]).toBeGreaterThanOrEqual(ceilings[i - 1])
    }
  })

  test('shown set grows (never shrinks) as the ceiling rises', () => {
    const grid: OsmWay[] = []
    let id = 1
    const pcts = [null, 0, 3, 5.9, 6, 6.1, 7.9, 8, 8.1, 9.9, 10, 10.1, 14.9, 15, 15.1, 22]
    for (const g of pcts) {
      for (const a of pcts) {
        grid.push(way({ osmId: id++, gradientPct: g, accessGradientPct: a, componentPaintedLenM: 5400 }))
      }
    }
    for (const pushM of [0, 50]) {
      let prevShown: Set<number> | null = null
      for (const mode of modesByCeiling) {
        const opts = gateOpts({ maxGradientPct: getOverlayMaxGradientPct(mode), steepApproachPushM: pushM })
        const shown = new Set<number>(
          grid.filter((w) => enrichedWayVerdict(w, opts) === 'shown').map((w) => w.osmId as number),
        )
        if (prevShown) {
          for (const osmId of prevShown) expect(shown.has(osmId)).toBe(true)
        }
        prevShown = shown
      }
    }
  })

  test('raising the push budget only ever shows more (monotone in the admin knob)', () => {
    const w = way({ gradientPct: 2, accessGradientPct: 12, componentPaintedLenM: 5400 })
    const strict = enrichedWayVerdict(w, gateOpts({ steepApproachPushM: 0 }))
    const pushy = enrichedWayVerdict(w, gateOpts({ steepApproachPushM: 30 }))
    expect(strict).toBe('hidden')
    expect(pushy).toBe('shown')
  })
})

// ── overlayWayVerdict dispatch ──────────────────────────────────────────────

describe('overlayWayVerdict dispatch', () => {
  function dispatchOpts(overrides: {
    gradient?: number | null
    moat?: Set<string | number>
    onGradientCall?: () => void
  } = {}) {
    return {
      ...gateOpts(),
      gradientPct: (_w: OsmWay) => {
        overrides.onGradientCall?.()
        return overrides.gradient ?? null
      },
      moatIsolated: overrides.moat ?? new Set<string | number>(),
    }
  }

  test('enriched ways never call the runtime gradient accessor', () => {
    let calls = 0
    const w = way({ gradientPct: 3, accessGradientPct: 3, componentPaintedLenM: 5400 })
    const verdict = overlayWayVerdict(w, dispatchOpts({ gradient: 99, onGradientCall: () => { calls++ } }))
    expect(verdict).toBe('shown')
    expect(calls).toBe(0)
  })

  test('enriched ways ignore the runtime moat set entirely', () => {
    const w = way({ osmId: 7, gradientPct: 3, accessGradientPct: 3, componentPaintedLenM: 5400 })
    const verdict = overlayWayVerdict(w, dispatchOpts({ moat: new Set([7]) }))
    expect(verdict).toBe('shown')
  })

  test('enriched way with only null baked fields still takes the arithmetic path', () => {
    // Enriched-but-unbaked (B1 stage pending): present-null fields mean the
    // way is enriched — fail-soft shown, no runtime lookups.
    let calls = 0
    const w = way({ gradientPct: null, accessGradientPct: null, componentPaintedLenM: null })
    const verdict = overlayWayVerdict(w, dispatchOpts({ gradient: 99, onGradientCall: () => { calls++ } }))
    expect(verdict).toBe('shown')
    expect(calls).toBe(0)
  })

  // Regression: with zero enriched ways the dispatcher reproduces the
  // pre-enrichment runtime truth table exactly.
  test('raw way: null gradient → unknown (terrain not loaded / below noise floor)', () => {
    expect(overlayWayVerdict(way(), dispatchOpts({ gradient: null }))).toBe('unknown')
  })

  test('raw way: gradient within ceiling → shown', () => {
    expect(overlayWayVerdict(way(), dispatchOpts({ gradient: 5 }))).toBe('shown')
  })

  test('raw way: gradient over ceiling → hidden', () => {
    expect(overlayWayVerdict(way(), dispatchOpts({ gradient: 9 }))).toBe('hidden')
  })

  test('raw way: moat-isolated → hidden even with a fine gradient', () => {
    const w = way({ osmId: 42 })
    expect(overlayWayVerdict(w, dispatchOpts({ gradient: 2, moat: new Set([42]) }))).toBe('hidden')
  })

  test('raw way: moat-isolated with null gradient → hidden (moat wins over unknown)', () => {
    const w = way({ osmId: 42 })
    expect(overlayWayVerdict(w, dispatchOpts({ gradient: null, moat: new Set([42]) }))).toBe('hidden')
  })

  test('raw ways ignore baked-only gates (no fragment floor without componentPaintedLenM)', () => {
    // A raw way has no componentPaintedLenM: the dispatcher must not hide
    // it via the enriched fragment floor — the runtime smallFragmentIds
    // pass owns that decision for raw ways.
    const verdict = overlayWayVerdict(way(), { ...dispatchOpts({ gradient: 2 }), fragmentFloorActive: true })
    expect(verdict).toBe('shown')
  })
})
