import { describe, it, expect } from 'bun:test'
import { computeLts, computeLtsBreakdown, familySafetyScore, classifyEdge, parseMaxspeedKmh } from '../src/utils/lts'
import type { LtsBreakdown } from '../src/utils/lts'

// ── computeLts ──────────────────────────────────────────────────────────────

describe('computeLts', () => {
  describe('LTS 1 — car-free infrastructure', () => {
    it('cycleway → LTS 1', () => {
      expect(computeLts({ highway: 'cycleway' })).toBe(1)
    })

    it('path → LTS 1', () => {
      expect(computeLts({ highway: 'path' })).toBe(1)
    })

    it('track → LTS 1', () => {
      expect(computeLts({ highway: 'track' })).toBe(1)
    })

    it('pedestrian → LTS 1', () => {
      expect(computeLts({ highway: 'pedestrian' })).toBe(1)
    })

    it('footway with bicycle=yes → LTS 1', () => {
      expect(computeLts({ highway: 'footway', bicycle: 'yes' })).toBe(1)
    })

    it('footway with bicycle=designated → LTS 1', () => {
      expect(computeLts({ highway: 'footway', bicycle: 'designated' })).toBe(1)
    })

    it('footway without bicycle tag → not LTS 1', () => {
      expect(computeLts({ highway: 'footway' })).not.toBe(1)
    })

    it('living_street → LTS 1', () => {
      expect(computeLts({ highway: 'living_street' })).toBe(1)
    })

    it('bicycle_road=yes → LTS 1', () => {
      expect(computeLts({ highway: 'residential', bicycle_road: 'yes' })).toBe(1)
    })

    it('cyclestreet=yes → LTS 1', () => {
      expect(computeLts({ highway: 'residential', cyclestreet: 'yes' })).toBe(1)
    })
  })

  describe('separated cycle track', () => {
    it('cycleway=track, speed ≤50 → LTS 1', () => {
      expect(computeLts({ highway: 'secondary', cycleway: 'track', maxspeed: '50' })).toBe(1)
    })

    it('cycleway=track, speed >50 → LTS 2', () => {
      expect(computeLts({ highway: 'secondary', cycleway: 'track', maxspeed: '60' })).toBe(2)
    })

    it('cycleway=opposite_track → LTS 1', () => {
      expect(computeLts({ highway: 'tertiary', cycleway: 'opposite_track' })).toBe(1)
    })
  })

  describe('residential with low speed', () => {
    it('residential, no maxspeed, ≤2 lanes → LTS 1', () => {
      expect(computeLts({ highway: 'residential' })).toBe(1)
    })

    it('residential, 30 km/h, 2 lanes → LTS 1', () => {
      expect(computeLts({ highway: 'residential', maxspeed: '30', lanes: '2' })).toBe(1)
    })

    it('residential, 50 km/h → LTS 2 (no bike facility fallback)', () => {
      expect(computeLts({ highway: 'residential', maxspeed: '50' })).toBe(2)
    })

    it('residential, 50 km/h, 4 lanes → LTS 3', () => {
      expect(computeLts({ highway: 'residential', maxspeed: '50', lanes: '4' })).toBe(3)
    })
  })

  describe('bike lane', () => {
    it('lane, 30 km/h, 2 lanes → LTS 2', () => {
      expect(computeLts({ highway: 'secondary', cycleway: 'lane', maxspeed: '30', lanes: '2' })).toBe(2)
    })

    it('lane, 50 km/h, 3 lanes → LTS 2', () => {
      expect(computeLts({ highway: 'primary', cycleway: 'lane', maxspeed: '50', lanes: '3' })).toBe(2)
    })

    it('lane, 60 km/h → LTS 3', () => {
      expect(computeLts({ highway: 'primary', cycleway: 'lane', maxspeed: '60', lanes: '4' })).toBe(3)
    })

    it('opposite_lane, 30 km/h → LTS 2', () => {
      expect(computeLts({ highway: 'tertiary', cycleway: 'opposite_lane', maxspeed: '30', lanes: '2' })).toBe(2)
    })
  })

  describe('shared bus lane', () => {
    it('share_busway → LTS 2', () => {
      expect(computeLts({ highway: 'secondary', cycleway: 'share_busway' })).toBe(2)
    })
  })

  describe('no bike facility', () => {
    it('tertiary, 30 km/h → LTS 2', () => {
      expect(computeLts({ highway: 'tertiary', maxspeed: '30' })).toBe(2)
    })

    it('tertiary, 50 km/h → LTS 3', () => {
      expect(computeLts({ highway: 'tertiary', maxspeed: '50' })).toBe(3)
    })

    it('tertiary, 60 km/h → LTS 4', () => {
      expect(computeLts({ highway: 'tertiary', maxspeed: '60' })).toBe(4)
    })

    it('unclassified, 30 km/h → LTS 2', () => {
      expect(computeLts({ highway: 'unclassified', maxspeed: '30' })).toBe(2)
    })

    it('unclassified, 50 km/h → LTS 3', () => {
      expect(computeLts({ highway: 'unclassified', maxspeed: '50' })).toBe(3)
    })

    it('secondary → LTS 4', () => {
      expect(computeLts({ highway: 'secondary' })).toBe(4)
    })

    it('primary → LTS 4', () => {
      expect(computeLts({ highway: 'primary' })).toBe(4)
    })

    it('trunk → LTS 4', () => {
      expect(computeLts({ highway: 'trunk' })).toBe(4)
    })
  })

  describe('cycleway:right and cycleway:both fallback', () => {
    it('cycleway:right=track → LTS 1', () => {
      expect(computeLts({ highway: 'secondary', 'cycleway:right': 'track' })).toBe(1)
    })

    it('cycleway:both=lane, 30 km/h, 2 lanes → LTS 2', () => {
      expect(computeLts({ highway: 'secondary', 'cycleway:both': 'lane', maxspeed: '30', lanes: '2' })).toBe(2)
    })
  })

  it('unknown highway defaults to LTS 3', () => {
    expect(computeLts({ highway: 'motorway_link' })).toBe(3)
  })
})

// ── computeLtsBreakdown ─────────────────────────────────────────────────────

describe('computeLtsBreakdown', () => {
  it('returns zeroed breakdown for empty segments', () => {
    const bd = computeLtsBreakdown([])
    expect(bd.lts1Pct).toBe(0)
    expect(bd.familySafetyScore).toBe(0)
  })

  it('100% LTS 1 route → score 100', () => {
    const bd = computeLtsBreakdown([
      { tags: { highway: 'cycleway' }, lengthM: 500 },
      { tags: { highway: 'path' }, lengthM: 500 },
    ])
    expect(bd.lts1Pct).toBe(1)
    expect(bd.lts2Pct).toBe(0)
    expect(bd.worstLts).toBe(1)
    expect(bd.familySafetyScore).toBe(100)
  })

  it('mixed LTS 1/2 route → score reflects weighted average', () => {
    const bd = computeLtsBreakdown([
      { tags: { highway: 'cycleway' }, lengthM: 500 },
      { tags: { highway: 'tertiary', maxspeed: '30' }, lengthM: 500 },
    ])
    expect(bd.lts1Pct).toBeCloseTo(0.5)
    expect(bd.lts2Pct).toBeCloseTo(0.5)
    expect(bd.worstLts).toBe(2)
    expect(bd.familySafetyScore).toBe(85) // 0.5*100 + 0.5*70 = 85
  })

  it('route with LTS 4 → score capped at 40', () => {
    const bd = computeLtsBreakdown([
      { tags: { highway: 'cycleway' }, lengthM: 900 },
      { tags: { highway: 'primary' }, lengthM: 100 }, // LTS 4
    ])
    expect(bd.lts4Pct).toBeCloseTo(0.1)
    expect(bd.worstLts).toBe(4)
    expect(bd.familySafetyScore).toBeLessThanOrEqual(40)
  })

  it('route with >10% LTS 3 → score capped at 60', () => {
    const bd = computeLtsBreakdown([
      { tags: { highway: 'cycleway' }, lengthM: 800 },
      { tags: { highway: 'tertiary', maxspeed: '50' }, lengthM: 200 }, // LTS 3
    ])
    expect(bd.lts3Pct).toBeCloseTo(0.2)
    expect(bd.worstLts).toBe(3)
    expect(bd.familySafetyScore).toBeLessThanOrEqual(60)
  })

  it('distance-weights correctly', () => {
    const bd = computeLtsBreakdown([
      { tags: { highway: 'cycleway' }, lengthM: 900 },
      { tags: { highway: 'tertiary', maxspeed: '30' }, lengthM: 100 },
    ])
    expect(bd.lts1Pct).toBeCloseTo(0.9)
    expect(bd.lts2Pct).toBeCloseTo(0.1)
  })
})

// ── familySafetyScore ───────────────────────────────────────────────────────

describe('familySafetyScore', () => {
  it('pure LTS 1 → 100', () => {
    const bd: LtsBreakdown = {
      lts1Pct: 1, lts2Pct: 0, lts3Pct: 0, lts4Pct: 0,
      worstLts: 1, familySafetyScore: 0,
    }
    expect(familySafetyScore(bd)).toBe(100)
  })

  it('pure LTS 2 → 70', () => {
    const bd: LtsBreakdown = {
      lts1Pct: 0, lts2Pct: 1, lts3Pct: 0, lts4Pct: 0,
      worstLts: 2, familySafetyScore: 0,
    }
    expect(familySafetyScore(bd)).toBe(70)
  })

  it('pure LTS 3 → capped at 30 (which is ≤60)', () => {
    const bd: LtsBreakdown = {
      lts1Pct: 0, lts2Pct: 0, lts3Pct: 1, lts4Pct: 0,
      worstLts: 3, familySafetyScore: 0,
    }
    expect(familySafetyScore(bd)).toBe(30)
  })

  it('any LTS 4 caps at 40', () => {
    const bd: LtsBreakdown = {
      lts1Pct: 0.9, lts2Pct: 0, lts3Pct: 0, lts4Pct: 0.1,
      worstLts: 4, familySafetyScore: 0,
    }
    expect(familySafetyScore(bd)).toBeLessThanOrEqual(40)
  })
})

// ── maxspeed unit parsing ───────────────────────────────────────────────────
// Regression cover for the SF "missing Folsom and 17th" bug (2026-08-22):
// `parseInt('25 mph')` silently read mph values as km/h, so a 30 mph (48 km/h)
// arterial classified as a quiet street while untagged connectors fell back to
// a 50 km/h road-class guess and dropped off the overlay entirely.

describe('parseMaxspeedKmh', () => {
  it('reads a bare number as km/h', () => {
    expect(parseMaxspeedKmh('50')).toBe(50)
    expect(parseMaxspeedKmh('30')).toBe(30)
  })

  it('converts mph to km/h instead of dropping the unit', () => {
    expect(parseMaxspeedKmh('25 mph')).toBe(40)
    expect(parseMaxspeedKmh('30 mph')).toBe(48)
    expect(parseMaxspeedKmh('20mph')).toBe(32)
  })

  it('accepts explicit km/h suffixes', () => {
    expect(parseMaxspeedKmh('50 km/h')).toBe(50)
    expect(parseMaxspeedKmh('50 kph')).toBe(50)
  })

  it('maps walking pace and derestricted values', () => {
    expect(parseMaxspeedKmh('walk')).toBe(7)
    expect(parseMaxspeedKmh('none')).toBe(130)
  })

  it('returns null for absent or unparseable values', () => {
    expect(parseMaxspeedKmh(undefined)).toBeNull()
    expect(parseMaxspeedKmh('')).toBeNull()
    expect(parseMaxspeedKmh('signals')).toBeNull()
    expect(parseMaxspeedKmh('DE:urban')).toBeNull()
  })
})

// ── pathLevel 2a: "bike infra on a calmed street" ───────────────────────────

describe('pathLevel 2a — calmed-street ceiling', () => {
  it('admits a US 25 mph street with a painted lane', () => {
    expect(classifyEdge({ highway: 'tertiary', cycleway: 'lane', maxspeed: '25 mph', lanes: '3' }).pathLevel).toBe('2a')
  })

  it('admits a US 20 mph slow street with a painted lane', () => {
    expect(classifyEdge({ highway: 'residential', cycleway: 'lane', maxspeed: '20 mph' }).pathLevel).toBe('2a')
  })

  it('admits a European Tempo-30 street with a painted lane', () => {
    expect(classifyEdge({ highway: 'tertiary', cycleway: 'lane', maxspeed: '30', lanes: '2' }).pathLevel).toBe('2a')
  })

  it('rejects a US 30 mph arterial — 48 km/h is not a quiet street', () => {
    expect(classifyEdge({ highway: 'secondary', cycleway: 'lane', maxspeed: '30 mph', lanes: '2' }).pathLevel).toBe('3')
  })

  it('rejects a European 50 km/h Hauptstraße with a painted lane', () => {
    expect(classifyEdge({ highway: 'secondary', cycleway: 'lane', maxspeed: '50', lanes: '2' }).pathLevel).toBe('3')
  })

  it('admits an UNTAGGED tertiary with a painted lane (Folsom St, 17th St)', () => {
    // Neither carries a maxspeed tag in OSM; the old tertiary default of
    // 50 km/h put them above the ceiling and they painted nothing.
    expect(classifyEdge({ highway: 'tertiary', cycleway: 'lane', lanes: '2' }).pathLevel).toBe('2a')
    expect(classifyEdge({ highway: 'tertiary', cycleway: 'lane', lanes: '3' }).pathLevel).toBe('2a')
  })

  it('still rejects an untagged secondary — arterials keep the 50 km/h guess', () => {
    expect(classifyEdge({ highway: 'secondary', cycleway: 'lane' }).pathLevel).toBe('3')
  })
})
