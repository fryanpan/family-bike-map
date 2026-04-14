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
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Fahrradstrasse')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Fahrradstrasse')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Fahrradstrasse')
  })
})

// ── Car-free paths and cycleways ──────────────────────────────────────────────

describe('classifyEdgeToItem — car-free paths (use="cycleway", "path", "mountain_bike")', () => {
  it('classifies use=cycleway as Bike path', () => {
    const edge: ValhallaEdge = { use: 'cycleway' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Bike path')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Bike path')
  })

  it('classifies use=path (trail e.g. Engeldam) as Bike path', () => {
    const edge: ValhallaEdge = { use: 'path' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Bike path')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Bike path')
  })

  it('classifies use=mountain_bike path as Bike path', () => {
    const edge: ValhallaEdge = { use: 'mountain_bike' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Bike path')
  })

  it('classifies dirt path as Rough road — dirt is a bad surface for all modes', () => {
    const edge: ValhallaEdge = { use: 'path', surface: 'dirt' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Rough surface')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Rough surface')
  })
})

// ── Shared footway / pedestrian paths (park paths, Tiergarten trails) ────────

describe('classifyEdgeToItem — shared footway/pedestrian paths', () => {
  it('classifies use=footway as Shared foot path for all profiles', () => {
    const edge: ValhallaEdge = { use: 'footway' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Shared foot path')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Shared foot path')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Shared foot path')
  })

  it('classifies use=pedestrian as Shared foot path for all profiles', () => {
    const edge: ValhallaEdge = { use: 'pedestrian' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Shared foot path')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Shared foot path')
  })
})

// ── Elevated sidewalk path alongside road (cycleway=track) ─────────────────────

describe('classifyEdgeToItem — separated track (cycle_lane="separated")', () => {
  it('classifies separated track as profile-specific item name', () => {
    const edge: ValhallaEdge = { cycle_lane: 'separated' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Elevated sidewalk path')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Elevated sidewalk path')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Elevated sidewalk path')
  })
})

// ── Painted road bike lane (cycleway=lane) ────────────────────────────────────

describe('classifyEdgeToItem — painted road lane (cycle_lane="dedicated")', () => {
  it('classifies painted lane as Painted bike lane for all profiles', () => {
    const edge: ValhallaEdge = { cycle_lane: 'dedicated' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Painted bike lane')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Painted bike lane')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Painted bike lane')
  })
})

// ── Living street ─────────────────────────────────────────────────────────────

describe('classifyEdgeToItem — living street (use="living_street")', () => {
  it('classifies living street as Living street for all profiles', () => {
    const edge: ValhallaEdge = { use: 'living_street' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Living street')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Living street')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Living street')
  })
})

// ── Shared bus lane (cycleway=share_busway) ───────────────────────────────────

describe('classifyEdgeToItem — shared bus lane (cycle_lane="share_busway")', () => {
  it('classifies bus lane as Shared bus lane for all profiles', () => {
    const edge: ValhallaEdge = { cycle_lane: 'share_busway' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Shared bus lane')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Shared bus lane')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Shared bus lane')
  })
})

// ── Residential road ──────────────────────────────────────────────────────────

describe('classifyEdgeToItem — residential road', () => {
  it('classifies residential road_class as Residential road', () => {
    const edge: ValhallaEdge = { road_class: 'residential' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Residential/local road')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Residential/local road')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Residential/local road')
  })
})

// ── Bad surfaces (cobblestones) → 'Rough surface' ────────────

describe('classifyEdgeToItem — bad surfaces return rough road', () => {
  const ROUGH = 'Rough surface'

  it('returns rough road for cobblestone surface regardless of infra type', () => {
    const edge: ValhallaEdge = { cycle_lane: 'separated', surface: 'cobblestone' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe(ROUGH)
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe(ROUGH)
    expect(classifyEdgeToItem(edge, 'training')).toBe(ROUGH)
  })

  it('returns rough road for sett (Kopfsteinpflaster)', () => {
    const edge: ValhallaEdge = { use: 'cycleway', surface: 'sett' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe(ROUGH)
    expect(classifyEdgeToItem(edge, 'training')).toBe(ROUGH)
  })

  it('treats dirt as rough road but compacted as OK for all modes', () => {
    const dirt: ValhallaEdge = { cycle_lane: 'separated', surface: 'dirt' }
    const compacted: ValhallaEdge = { cycle_lane: 'separated', surface: 'compacted' }
    expect(classifyEdgeToItem(dirt, 'kid-starting-out')).toBe('Rough surface')
    expect(classifyEdgeToItem(compacted, 'kid-starting-out')).toBe('Elevated sidewalk path')
    expect(classifyEdgeToItem(compacted, 'carrying-kid')).toBe('Elevated sidewalk path')
    expect(classifyEdgeToItem(compacted, 'training')).toBe('Elevated sidewalk path')
  })

  it('paving_stones is OK for toddler but rough for trailer/training', () => {
    const edge: ValhallaEdge = { use: 'cycleway', surface: 'paving_stones' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Bike path')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Rough surface')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Rough surface')
  })

  it('returns rough road for gravel and unpaved', () => {
    const gravel: ValhallaEdge = { cycle_lane: 'separated', surface: 'gravel' }
    const unpaved: ValhallaEdge = { cycle_lane: 'separated', surface: 'unpaved' }
    expect(classifyEdgeToItem(gravel, 'kid-starting-out')).toBe(ROUGH)
    expect(classifyEdgeToItem(unpaved, 'kid-starting-out')).toBe(ROUGH)
  })
})

// ── Arterial roads → null ─────────────────────────────────────────────────────

describe('classifyEdgeToItem — arterial roads return null', () => {
  it('returns null for primary and secondary roads', () => {
    expect(classifyEdgeToItem({ road_class: 'primary' }, 'kid-starting-out')).toBeNull()
    expect(classifyEdgeToItem({ road_class: 'secondary' }, 'kid-starting-out')).toBeNull()
  })

  it('returns Residential/local road for tertiary and unclassified', () => {
    expect(classifyEdgeToItem({ road_class: 'tertiary' }, 'kid-starting-out')).toBe('Residential/local road')
    expect(classifyEdgeToItem({ road_class: 'unclassified' }, 'kid-starting-out')).toBe('Residential/local road')
  })

  it('returns null for null/undefined edge', () => {
    expect(classifyEdgeToItem(null, 'kid-starting-out')).toBeNull()
    expect(classifyEdgeToItem(undefined, 'kid-starting-out')).toBeNull()
  })
})

// ── getDefaultPreferredItems ──────────────────────────────────────────────────

describe('getDefaultPreferredItems', () => {
  it('returns physically car-separated infra for kid-starting-out', () => {
    const items = getDefaultPreferredItems('kid-starting-out')
    expect(items.has('Bike path')).toBe(true)
    expect(items.has('Fahrradstrasse')).toBe(true)
    expect(items.has('Shared foot path')).toBe(true)
    expect(items.has('Elevated sidewalk path')).toBe(true)
    // Living streets, painted lanes, residential are NOT preferred for the
    // strictest mode — kid is just starting out and needs separation from cars.
    expect(items.has('Living street')).toBe(false)
    expect(items.has('Painted bike lane')).toBe(false)
    expect(items.has('Residential/local road')).toBe(false)
  })

  it('adds living streets and elevated tracks for kid-confident', () => {
    const items = getDefaultPreferredItems('kid-confident')
    expect(items.has('Bike path')).toBe(true)
    expect(items.has('Fahrradstrasse')).toBe(true)
    expect(items.has('Elevated sidewalk path')).toBe(true)
    expect(items.has('Living street')).toBe(true)
    // Painted lanes still not trusted at this level.
    expect(items.has('Painted bike lane')).toBe(false)
    expect(items.has('Residential/local road')).toBe(false)
  })

  it('adds painted lanes and residential for kid-traffic-savvy', () => {
    const items = getDefaultPreferredItems('kid-traffic-savvy')
    expect(items.has('Painted bike lane')).toBe(true)
    expect(items.has('Residential/local road')).toBe(true)
    expect(items.has('Living street')).toBe(true)
  })

  it('returns defaultPreferred items for training profile', () => {
    const items = getDefaultPreferredItems('training')
    expect(items.has('Bike path')).toBe(true)
    expect(items.has('Painted bike lane')).toBe(true)
    expect(items.has('Living street')).toBe(true)
    expect(items.has('Elevated sidewalk path')).toBe(false)
  })

  it('returns empty set for unknown profile', () => {
    expect(getDefaultPreferredItems('unknown').size).toBe(0)
  })
})

// ── computeRouteQuality ───────────────────────────────────────────────────────

describe('computeRouteQuality — preferred/other/walking model', () => {
  const seg = (itemName: string | null, len: number, isWalking?: boolean): RouteSegment => ({
    itemName,
    coordinates: Array.from({ length: len + 1 }, (_, i) => [i, 0] as [number, number]),
    ...(isWalking ? { isWalking: true } : {}),
  })

  it('splits preferred vs other by item name', () => {
    const segments: RouteSegment[] = [
      seg('Bike path', 3),
      seg('Painted bike lane', 1),
      seg(null, 1),
    ]
    const preferred = new Set(['Bike path'])
    const q = computeRouteQuality(segments, preferred)
    expect(q.preferred).toBeCloseTo(3 / 5)
    expect(q.other).toBeCloseTo(2 / 5)
    expect(q.walking).toBe(0)
  })

  it('returns all preferred when every item is in preferredItemNames', () => {
    const segments: RouteSegment[] = [
      seg('Bike path', 4),
      seg('Fahrradstrasse', 1),
    ]
    const preferred = new Set(['Bike path', 'Fahrradstrasse'])
    const q = computeRouteQuality(segments, preferred)
    expect(q.preferred).toBe(1)
    expect(q.other).toBe(0)
    expect(q.walking).toBe(0)
  })

  it('null itemName always counts as other', () => {
    const segments: RouteSegment[] = [seg(null, 2)]
    const q = computeRouteQuality(segments, new Set(['Bike path']))
    expect(q.preferred).toBe(0)
    expect(q.other).toBe(1)
    expect(q.walking).toBe(0)
  })

  it('returns 0/0/0 fractions for empty segments', () => {
    const q = computeRouteQuality([], new Set())
    expect(q.preferred).toBe(0)
    expect(q.other).toBe(0)
    expect(q.walking).toBe(0)
  })

  it('counts walking segments separately from preferred and other', () => {
    const segments: RouteSegment[] = [
      seg('Bike path', 3),
      seg(null, 1, true),  // walking segment
      seg(null, 1),
    ]
    const preferred = new Set(['Bike path'])
    const q = computeRouteQuality(segments, preferred)
    expect(q.preferred).toBeCloseTo(3 / 5)
    expect(q.walking).toBeCloseTo(1 / 5)
    expect(q.other).toBeCloseTo(1 / 5)
  })
})

