import { describe, it, expect } from 'bun:test'
import { classifyEdge, computeLts, computeLtsBreakdown, familySafetyScore } from '../src/utils/lts'
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

// ── High-stress PBL demote (Joanna 2026-04-29, #3) ──────────────────────────
//
// Separated cycleways alongside busy arterials get classified 1a "car-free"
// at the segment level — but Joanna's family mental model treats the
// frequent intersection conflicts (turn mixing, right hooks) as
// equivalent to a painted lane on a quiet street. Test the demote rule
// fires for the targeted Berlin (Kotbusser Damm, Hasenheide) and SF
// (Valencia) shapes and stays off when it shouldn't.

describe('classifyEdge — high-stress PBL demote', () => {
  it('cycleway:right=track on secondary @50 km/h → 2a (Kotbusser Damm)', () => {
    const c = classifyEdge({ highway: 'secondary', 'cycleway:right': 'track', maxspeed: '50' })
    expect(c.lts).toBe(1)        // segment-level Furth still 1
    expect(c.pathLevel).toBe('2a') // but display-tier demoted
  })

  it('cycleway:left=track on tertiary, no maxspeed → 2a (defaults to >30)', () => {
    const c = classifyEdge({ highway: 'tertiary', 'cycleway:left': 'track' })
    expect(c.pathLevel).toBe('2a')
  })

  it('cycleway:both=track on primary @60 → 2a', () => {
    const c = classifyEdge({ highway: 'primary', 'cycleway:both': 'track', maxspeed: '60' })
    expect(c.pathLevel).toBe('2a')
  })

  it('inline cycleway=track on secondary @50 → 2a', () => {
    const c = classifyEdge({ highway: 'secondary', cycleway: 'track', maxspeed: '50' })
    expect(c.pathLevel).toBe('2a')
  })

  it('is_sidepath=yes on a standalone cycleway → 2a', () => {
    // SF Valencia mid-block PBL is a separate highway=cycleway way with
    // is_sidepath=yes referencing Valencia (highway=secondary).
    const c = classifyEdge({ highway: 'cycleway', is_sidepath: 'yes' })
    expect(c.pathLevel).toBe('2a')
  })

  it('is_sidepath:of=valencia on a standalone cycleway → 2a', () => {
    const c = classifyEdge({ highway: 'cycleway', 'is_sidepath:of': 'Valencia Street' })
    expect(c.pathLevel).toBe('2a')
  })

  it('does NOT demote a standalone canal-side cycleway (no parent road)', () => {
    const c = classifyEdge({ highway: 'cycleway' })
    expect(c.pathLevel).toBe('1a')
  })

  it('does NOT demote a cycleway=track on a 30 km/h residential street', () => {
    // Quiet residential with a separated track stays 1a — no high-stress
    // intersections on the parent road.
    const c = classifyEdge({ highway: 'residential', cycleway: 'track', maxspeed: '30' })
    expect(c.pathLevel).toBe('1a')
  })

  it('does NOT demote a separated track on a low-speed secondary (≤30 km/h)', () => {
    // Tagging `secondary maxspeed=30` is rare but possible (school zones).
    // The intersection-stress argument doesn't apply at low speed.
    const c = classifyEdge({ highway: 'secondary', cycleway: 'track', maxspeed: '30' })
    expect(c.pathLevel).toBe('1a')
  })

  it('does NOT demote a painted lane (only separated tracks)', () => {
    // A painted lane on a busy road is already 2a/3 via the segment rules.
    // The demote rule shouldn't double-fire on it.
    const c = classifyEdge({ highway: 'secondary', cycleway: 'lane', maxspeed: '50' })
    // painted-lane-on-50 demotes to 3 via derivePathLevel; we don't want
    // the new rule reclassifying that to 2a.
    expect(c.pathLevel).not.toBe('2a')
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
