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

describe('classifyEdgeToItem — car-free paths', () => {
  it('classifies use=cycleway as Bike path', () => {
    const edge: ValhallaEdge = { use: 'cycleway' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Bike path')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Bike path')
  })

  it('classifies use=path as Bike path', () => {
    const edge: ValhallaEdge = { use: 'path' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Bike path')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Bike path')
  })

  it('classifies use=mountain_bike as Bike path', () => {
    const edge: ValhallaEdge = { use: 'mountain_bike' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Bike path')
  })

  it('returns the underlying infra type regardless of surface (rough is orthogonal)', () => {
    // Surface roughness is carried by a separate flag (isRoughSurface) for
    // the overlay-hide + 5× routing penalty. The item name stays true to
    // the infrastructure type so the distribution plot and legend tier
    // coloring remain consistent.
    const edge: ValhallaEdge = { use: 'path', surface: 'dirt' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Bike path')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Bike path')
  })
})

// ── Shared use paths (footway / pedestrian) ──────────────────────────────────

describe('classifyEdgeToItem — shared use paths', () => {
  it('classifies use=footway as Shared use path for all profiles', () => {
    const edge: ValhallaEdge = { use: 'footway' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Shared use path')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Shared use path')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Shared use path')
  })

  it('classifies use=pedestrian as Shared use path for all profiles', () => {
    const edge: ValhallaEdge = { use: 'pedestrian' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Shared use path')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Shared use path')
  })
})

// ── Elevated sidewalk path alongside road (cycle_lane=separated) ─────────────

describe('classifyEdgeToItem — separated track', () => {
  it('classifies separated track as Elevated sidewalk path on residential / unknown host', () => {
    const edge: ValhallaEdge = { cycle_lane: 'separated' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Elevated sidewalk path')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Elevated sidewalk path')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Elevated sidewalk path')
    const residential: ValhallaEdge = { cycle_lane: 'separated', road_class: 'residential' }
    expect(classifyEdgeToItem(residential, 'kid-starting-out')).toBe('Elevated sidewalk path')
  })

  it('classifies separated track on tertiary+ host as Protected bike lane on major road', () => {
    // Mirrors the OSM-side trafficDensity branch — the Valhalla path
    // must agree so the external-router benchmark exercises the same
    // item name as the client router.
    const tertiary: ValhallaEdge = { cycle_lane: 'separated', road_class: 'tertiary' }
    const secondary: ValhallaEdge = { cycle_lane: 'separated', road_class: 'secondary' }
    const primary: ValhallaEdge = { cycle_lane: 'separated', road_class: 'primary' }
    expect(classifyEdgeToItem(tertiary, 'kid-traffic-savvy')).toBe('Protected bike lane on major road')
    expect(classifyEdgeToItem(secondary, 'kid-traffic-savvy')).toBe('Protected bike lane on major road')
    expect(classifyEdgeToItem(primary, 'kid-traffic-savvy')).toBe('Protected bike lane on major road')
  })
})

// ── Painted bike lane on quiet street (cycle_lane=dedicated) ─────────────────

describe('classifyEdgeToItem — painted road lane', () => {
  it('classifies painted lane as Painted bike lane on quiet street', () => {
    const edge: ValhallaEdge = { cycle_lane: 'dedicated' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Painted bike lane on quiet street')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Painted bike lane on quiet street')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Painted bike lane on quiet street')
  })
})

// ── Living street ─────────────────────────────────────────────────────────────

describe('classifyEdgeToItem — living street', () => {
  it('classifies living_street as Living street for all profiles', () => {
    const edge: ValhallaEdge = { use: 'living_street' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Living street')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Living street')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Living street')
  })
})

// ── Shared bus lane ──────────────────────────────────────────────────────────

describe('classifyEdgeToItem — shared bus lane', () => {
  it('classifies bus lane as Shared bus lane on quiet street', () => {
    const edge: ValhallaEdge = { cycle_lane: 'share_busway' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Shared bus lane on quiet street')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Shared bus lane on quiet street')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Shared bus lane on quiet street')
  })
})

// ── Residential road ─────────────────────────────────────────────────────────

describe('classifyEdgeToItem — residential road', () => {
  it('classifies residential road_class as Quiet street', () => {
    const edge: ValhallaEdge = { road_class: 'residential' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Quiet street')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Quiet street')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Quiet street')
  })
})

// ── Surface roughness is carried separately ──────────────────────────────────

describe('classifyEdgeToItem — surface does NOT change the item name', () => {
  it('cobblestone bike path still classifies as Bike path (rough flag is orthogonal)', () => {
    const edge: ValhallaEdge = { cycle_lane: 'separated', surface: 'cobblestone' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Elevated sidewalk path')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Elevated sidewalk path')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Elevated sidewalk path')
  })

  it('paving_stones cycleway stays Bike path for every mode', () => {
    const edge: ValhallaEdge = { use: 'cycleway', surface: 'paving_stones' }
    expect(classifyEdgeToItem(edge, 'kid-starting-out')).toBe('Bike path')
    expect(classifyEdgeToItem(edge, 'carrying-kid')).toBe('Bike path')
    expect(classifyEdgeToItem(edge, 'training')).toBe('Bike path')
  })

  it('gravel and unpaved still classify as their underlying infra type', () => {
    const gravel: ValhallaEdge = { cycle_lane: 'separated', surface: 'gravel' }
    const unpaved: ValhallaEdge = { cycle_lane: 'separated', surface: 'unpaved' }
    expect(classifyEdgeToItem(gravel, 'kid-starting-out')).toBe('Elevated sidewalk path')
    expect(classifyEdgeToItem(unpaved, 'kid-starting-out')).toBe('Elevated sidewalk path')
  })
})

// ── Arterial roads → null; tertiary/unclassified → Major road ────────────────

describe('classifyEdgeToItem — arterial roads', () => {
  it('returns null for primary and secondary roads', () => {
    expect(classifyEdgeToItem({ road_class: 'primary' }, 'kid-starting-out')).toBeNull()
    expect(classifyEdgeToItem({ road_class: 'secondary' }, 'kid-starting-out')).toBeNull()
  })

  it('returns Major road for tertiary and unclassified', () => {
    expect(classifyEdgeToItem({ road_class: 'tertiary' }, 'kid-starting-out')).toBe('Major road')
    expect(classifyEdgeToItem({ road_class: 'unclassified' }, 'kid-starting-out')).toBe('Major road')
  })

  it('returns null for null/undefined edge', () => {
    expect(classifyEdgeToItem(null, 'kid-starting-out')).toBeNull()
    expect(classifyEdgeToItem(undefined, 'kid-starting-out')).toBeNull()
  })
})

// ── getDefaultPreferredItems ─────────────────────────────────────────────────

describe('getDefaultPreferredItems', () => {
  it('returns physically car-separated infra for kid-starting-out', () => {
    const items = getDefaultPreferredItems('kid-starting-out')
    expect(items.has('Bike path')).toBe(true)
    expect(items.has('Shared use path')).toBe(true)
    expect(items.has('Elevated sidewalk path')).toBe(true)
    expect(items.has('Fahrradstrasse')).toBe(false)
    expect(items.has('Living street')).toBe(false)
    expect(items.has('Painted bike lane on quiet street')).toBe(false)
    expect(items.has('Quiet street')).toBe(false)
  })

  it('adds living streets and Fahrradstrassen for kid-confident', () => {
    const items = getDefaultPreferredItems('kid-confident')
    expect(items.has('Bike path')).toBe(true)
    expect(items.has('Fahrradstrasse')).toBe(true)
    expect(items.has('Elevated sidewalk path')).toBe(true)
    expect(items.has('Living street')).toBe(true)
    expect(items.has('Painted bike lane on quiet street')).toBe(false)
    expect(items.has('Quiet street')).toBe(false)
  })

  it('kid-traffic-savvy: 1a/1b/2a preferred in legend; 2b accepted for routing but NOT preferred', () => {
    const items = getDefaultPreferredItems('kid-traffic-savvy')
    expect(items.has('Painted bike lane on quiet street')).toBe(true)
    expect(items.has('Shared bus lane on quiet street')).toBe(true)
    expect(items.has('Bike boulevard')).toBe(true)
    expect(items.has('Living street')).toBe(true)
    expect(items.has('Quiet street')).toBe(false) // 2b accepted for routing, not preferred in legend
    expect(items.has('Major road')).toBe(false)
  })

  it('kid-traffic-savvy: opt-in flips 2b into preferred legend', () => {
    const items = getDefaultPreferredItems('kid-traffic-savvy', true)
    expect(items.has('Quiet street')).toBe(true)
  })

  it('carrying-kid: 1a/1b/2a preferred; 2b accepted for routing but not preferred; LTS 3 off', () => {
    const items = getDefaultPreferredItems('carrying-kid')
    expect(items.has('Bike path')).toBe(true)
    expect(items.has('Painted bike lane on quiet street')).toBe(true)
    expect(items.has('Quiet street')).toBe(false) // 2b accepted, not preferred
    expect(items.has('Painted bike lane on major road')).toBe(false) // LTS 3 rejected
    expect(items.has('Major road')).toBe(false)
    expect(items.has('Elevated sidewalk path')).toBe(false)
  })

  it('training: 1a/1b/2a preferred in legend; 2b + 3 accepted for routing but not preferred', () => {
    const items = getDefaultPreferredItems('training')
    expect(items.has('Bike path')).toBe(true)
    expect(items.has('Painted bike lane on quiet street')).toBe(true)
    expect(items.has('Living street')).toBe(true)
    expect(items.has('Quiet street')).toBe(false)
    expect(items.has('Major road')).toBe(false)
    expect(items.has('Elevated sidewalk path')).toBe(false)
  })

  it('returns empty set for unknown profile', () => {
    expect(getDefaultPreferredItems('unknown').size).toBe(0)
  })

  it('Protected bike lane on major road: non-preferred for the kid-piloted slower modes', () => {
    // Folsom-style separated track on a busy road: physically car-free (LTS 1)
    // but adjacent traffic is loud / stressful for younger riders. The legend
    // mirrors Bryan's framing: not preferred for kid-starting-out / kid-
    // confident; preferred for kid-traffic-savvy and adult-piloted modes.
    expect(getDefaultPreferredItems('kid-starting-out').has('Protected bike lane on major road')).toBe(false)
    expect(getDefaultPreferredItems('kid-confident').has('Protected bike lane on major road')).toBe(false)
    expect(getDefaultPreferredItems('kid-traffic-savvy').has('Protected bike lane on major road')).toBe(true)
    expect(getDefaultPreferredItems('carrying-kid').has('Protected bike lane on major road')).toBe(true)
    expect(getDefaultPreferredItems('training').has('Protected bike lane on major road')).toBe(true)
  })

  it('Elevated sidewalk path: per-mode preference pinned (paired with Protected-on-major)', () => {
    // After the 2026-05-25 split, "Elevated sidewalk path" only covers quiet
    // residential hosts. The per-mode preferred-ness for the surviving item
    // must NOT silently drift — a future PROFILE_LEGEND edit that changes
    // carrying-kid's or training's stance on this item should fail loudly.
    expect(getDefaultPreferredItems('kid-starting-out').has('Elevated sidewalk path')).toBe(true)
    expect(getDefaultPreferredItems('kid-confident').has('Elevated sidewalk path')).toBe(true)
    expect(getDefaultPreferredItems('kid-traffic-savvy').has('Elevated sidewalk path')).toBe(true)
    expect(getDefaultPreferredItems('carrying-kid').has('Elevated sidewalk path')).toBe(false)
    expect(getDefaultPreferredItems('training').has('Elevated sidewalk path')).toBe(false)
  })
})

// ── computeRouteQuality ──────────────────────────────────────────────────────

describe('computeRouteQuality — preferred/other/walking model', () => {
  const seg = (itemName: string | null, len: number, isWalking?: boolean): RouteSegment => ({
    itemName,
    coordinates: Array.from({ length: len + 1 }, (_, i) => [i, 0] as [number, number]),
    ...(isWalking ? { isWalking: true } : {}),
  })

  it('splits preferred vs other by item name', () => {
    const segments: RouteSegment[] = [
      seg('Bike path', 3),
      seg('Painted bike lane on quiet street', 1),
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
      seg(null, 1, true),
      seg(null, 1),
    ]
    const preferred = new Set(['Bike path'])
    const q = computeRouteQuality(segments, preferred)
    expect(q.preferred).toBeCloseTo(3 / 5)
    expect(q.walking).toBeCloseTo(1 / 5)
    expect(q.other).toBeCloseTo(1 / 5)
  })
})
