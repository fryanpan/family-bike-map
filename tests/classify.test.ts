import { describe, it, expect } from 'bun:test'
import {
  classifyEdgeToItem,
  getDefaultPreferredItems,
  computeRouteQuality,
} from '../src/utils/classify'
import type { ValhallaEdge, RouteSegment } from '../src/utils/types'

// NOTE: Valhalla's trace_attributes API returns STRING values for use, cycle_lane,
// and road_class (not the numeric codes in older docs). All test fixtures below
// use the string form that the actual API returns.

// ── Fahrradstrasse (bicycle_road=yes) ─────────────────────────────────────────

describe('classifyEdgeToItem — Fahrradstrasse', () => {
  it('classifies bicycle_road=yes as Fahrradstrasse for all profiles', () => {
    const edge: ValhallaEdge = { bicycle_road: true, road_class: 'residential' }
    expect(classifyEdgeToItem(edge, 'toddler')).toBe('Fahrradstrasse')
    expect(classifyEdgeToItem(edge, 'trailer')).toBe('Fahrradstrasse')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Fahrradstrasse')
  })
})

// ── Car-free paths and cycleways ──────────────────────────────────────────────

describe('classifyEdgeToItem — car-free paths (use="cycleway", "path", "mountain_bike")', () => {
  it('classifies use=cycleway as Car-free path / Radweg', () => {
    const edge: ValhallaEdge = { use: 'cycleway' }
    expect(classifyEdgeToItem(edge, 'toddler')).toBe('Car-free path / Radweg')
    expect(classifyEdgeToItem(edge, 'trailer')).toBe('Car-free path / Radweg')
  })

  it('classifies use=path (trail e.g. Engeldam) as Car-free path / Radweg', () => {
    const edge: ValhallaEdge = { use: 'path' }
    expect(classifyEdgeToItem(edge, 'toddler')).toBe('Car-free path / Radweg')
    expect(classifyEdgeToItem(edge, 'trailer')).toBe('Car-free path / Radweg')
  })

  it('classifies use=mountain_bike path as Car-free path / Radweg', () => {
    const edge: ValhallaEdge = { use: 'mountain_bike' }
    expect(classifyEdgeToItem(edge, 'toddler')).toBe('Car-free path / Radweg')
  })

  it('classifies dirt path (use=path, surface=dirt) as Car-free path — dirt is NOT a bad surface', () => {
    const edge: ValhallaEdge = { use: 'path', surface: 'dirt' }
    expect(classifyEdgeToItem(edge, 'toddler')).toBe('Car-free path / Radweg')
    expect(classifyEdgeToItem(edge, 'trailer')).toBe('Car-free path / Radweg')
  })
})

// ── Shared footway / pedestrian paths (park paths, Tiergarten trails) ────────

describe('classifyEdgeToItem — shared footway/pedestrian paths', () => {
  it('classifies use=footway as Shared footway (park path) for all profiles', () => {
    const edge: ValhallaEdge = { use: 'footway' }
    expect(classifyEdgeToItem(edge, 'toddler')).toBe('Shared footway (park path)')
    expect(classifyEdgeToItem(edge, 'trailer')).toBe('Shared footway (park path)')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Shared footway (park path)')
  })

  it('classifies use=pedestrian as Shared footway (park path) for all profiles', () => {
    const edge: ValhallaEdge = { use: 'pedestrian' }
    expect(classifyEdgeToItem(edge, 'toddler')).toBe('Shared footway (park path)')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Shared footway (park path)')
  })
})

// ── Separated bike track alongside road (cycleway=track) ─────────────────────

describe('classifyEdgeToItem — separated track (cycle_lane="separated")', () => {
  it('classifies separated track as profile-specific item name', () => {
    const edge: ValhallaEdge = { cycle_lane: 'separated' }
    expect(classifyEdgeToItem(edge, 'toddler')).toBe('Separated bike track')
    expect(classifyEdgeToItem(edge, 'trailer')).toBe('Separated bike track (narrow)')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Separated bike track (slow)')
  })
})

// ── Painted road bike lane (cycleway=lane) ────────────────────────────────────

describe('classifyEdgeToItem — painted road lane (cycle_lane="dedicated")', () => {
  it('classifies painted lane as Painted bike lane for all profiles', () => {
    const edge: ValhallaEdge = { cycle_lane: 'dedicated' }
    expect(classifyEdgeToItem(edge, 'toddler')).toBe('Painted bike lane')
    expect(classifyEdgeToItem(edge, 'trailer')).toBe('Painted bike lane')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Painted bike lane')
  })
})

// ── Living street ─────────────────────────────────────────────────────────────

describe('classifyEdgeToItem — living street (use="living_street")', () => {
  it('classifies living street as Living street for all profiles', () => {
    const edge: ValhallaEdge = { use: 'living_street' }
    expect(classifyEdgeToItem(edge, 'toddler')).toBe('Living street')
    expect(classifyEdgeToItem(edge, 'trailer')).toBe('Living street')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Living street')
  })
})

// ── Shared bus lane (cycleway=share_busway) ───────────────────────────────────

describe('classifyEdgeToItem — shared bus lane (cycle_lane="share_busway")', () => {
  it('classifies bus lane as Shared bus lane for all profiles', () => {
    const edge: ValhallaEdge = { cycle_lane: 'share_busway' }
    expect(classifyEdgeToItem(edge, 'toddler')).toBe('Shared bus lane')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Shared bus lane')
    expect(classifyEdgeToItem(edge, 'trailer')).toBe('Shared bus lane')
  })
})

// ── Residential road ──────────────────────────────────────────────────────────

describe('classifyEdgeToItem — residential road', () => {
  it('classifies residential road_class as Residential road', () => {
    const edge: ValhallaEdge = { road_class: 'residential' }
    expect(classifyEdgeToItem(edge, 'toddler')).toBe('Residential road')
    expect(classifyEdgeToItem(edge, 'trailer')).toBe('Residential road')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Residential road')
  })
})

// ── Bad surfaces (cobblestones) → null ───────────────────────────────────────

describe('classifyEdgeToItem — bad surfaces return null', () => {
  it('returns null for cobblestone surface regardless of infra type', () => {
    const edge: ValhallaEdge = { cycle_lane: 'separated', surface: 'cobblestone' }
    expect(classifyEdgeToItem(edge, 'toddler')).toBeNull()
    expect(classifyEdgeToItem(edge, 'trailer')).toBeNull()
    expect(classifyEdgeToItem(edge, 'training')).toBeNull()
  })

  it('returns null for sett (Kopfsteinpflaster)', () => {
    const edge: ValhallaEdge = { use: 'cycleway', surface: 'sett' }
    expect(classifyEdgeToItem(edge, 'toddler')).toBeNull()
    expect(classifyEdgeToItem(edge, 'training')).toBeNull()
  })

  it('does NOT treat dirt or compacted as bad surfaces', () => {
    const dirt: ValhallaEdge = { cycle_lane: 'separated', surface: 'dirt' }
    const compacted: ValhallaEdge = { cycle_lane: 'separated', surface: 'compacted' }
    expect(classifyEdgeToItem(dirt, 'toddler')).toBe('Separated bike track')
    expect(classifyEdgeToItem(compacted, 'toddler')).toBe('Separated bike track')
  })

  it('returns null for gravel and unpaved', () => {
    const gravel: ValhallaEdge = { cycle_lane: 'separated', surface: 'gravel' }
    const unpaved: ValhallaEdge = { cycle_lane: 'separated', surface: 'unpaved' }
    expect(classifyEdgeToItem(gravel, 'toddler')).toBeNull()
    expect(classifyEdgeToItem(unpaved, 'toddler')).toBeNull()
  })
})

// ── Arterial roads → null ─────────────────────────────────────────────────────

describe('classifyEdgeToItem — arterial roads return null', () => {
  it('returns null for primary, secondary, tertiary roads', () => {
    expect(classifyEdgeToItem({ road_class: 'primary' }, 'toddler')).toBeNull()
    expect(classifyEdgeToItem({ road_class: 'secondary' }, 'toddler')).toBeNull()
    expect(classifyEdgeToItem({ road_class: 'tertiary' }, 'toddler')).toBeNull()
  })

  it('returns null for null/undefined edge', () => {
    expect(classifyEdgeToItem(null, 'toddler')).toBeNull()
    expect(classifyEdgeToItem(undefined, 'toddler')).toBeNull()
  })
})

// ── getDefaultPreferredItems ──────────────────────────────────────────────────

describe('getDefaultPreferredItems', () => {
  it('returns defaultPreferred items for toddler profile', () => {
    const items = getDefaultPreferredItems('toddler')
    expect(items.has('Car-free path / Radweg')).toBe(true)
    expect(items.has('Fahrradstrasse')).toBe(true)
    expect(items.has('Shared footway (park path)')).toBe(true)
    expect(items.has('Separated bike track')).toBe(true)
    expect(items.has('Living street')).toBe(true)
    // non-default items should NOT be preferred by default
    expect(items.has('Painted bike lane')).toBe(false)
    expect(items.has('Residential road')).toBe(false)
  })

  it('returns defaultPreferred items for training profile', () => {
    const items = getDefaultPreferredItems('training')
    expect(items.has('Car-free path / Radweg')).toBe(true)
    expect(items.has('Painted bike lane')).toBe(true)
    expect(items.has('Living street')).toBe(true)
    expect(items.has('Separated bike track (slow)')).toBe(false)
  })

  it('returns empty set for unknown profile', () => {
    expect(getDefaultPreferredItems('unknown').size).toBe(0)
  })
})

// ── computeRouteQuality ───────────────────────────────────────────────────────

describe('computeRouteQuality — binary preferred/other model', () => {
  const seg = (itemName: string | null, len: number): RouteSegment => ({
    itemName,
    coordinates: Array.from({ length: len + 1 }, (_, i) => [i, 0] as [number, number]),
  })

  it('splits preferred vs other by item name', () => {
    const segments: RouteSegment[] = [
      seg('Car-free path / Radweg', 3),
      seg('Painted bike lane', 1),
      seg(null, 1),
    ]
    const preferred = new Set(['Car-free path / Radweg'])
    const q = computeRouteQuality(segments, preferred)
    expect(q.preferred).toBeCloseTo(3 / 5)
    expect(q.other).toBeCloseTo(2 / 5)
  })

  it('returns all preferred when every item is in preferredItemNames', () => {
    const segments: RouteSegment[] = [
      seg('Car-free path / Radweg', 4),
      seg('Fahrradstrasse', 1),
    ]
    const preferred = new Set(['Car-free path / Radweg', 'Fahrradstrasse'])
    const q = computeRouteQuality(segments, preferred)
    expect(q.preferred).toBe(1)
    expect(q.other).toBe(0)
  })

  it('null itemName always counts as other', () => {
    const segments: RouteSegment[] = [seg(null, 2)]
    const q = computeRouteQuality(segments, new Set(['Car-free path / Radweg']))
    expect(q.preferred).toBe(0)
    expect(q.other).toBe(1)
  })

  it('returns 0/0 fractions for empty segments', () => {
    const q = computeRouteQuality([], new Set())
    expect(q.preferred).toBe(0)
    expect(q.other).toBe(0)
  })
})
