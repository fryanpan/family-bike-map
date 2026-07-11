import { describe, it, expect } from 'bun:test'
import { classifyOverlayWay } from '../src/components/BikeMapOverlay'
import type { OsmWay } from '../src/utils/types'
import type { ClassificationRule } from '../src/services/rules'

function way(tags: Record<string, string>): OsmWay {
  return { itemName: null, osmId: 1, tags, coordinates: [[37.77, -122.43], [37.771, -122.431]] }
}

describe('classifyOverlayWay', () => {
  const profile = 'kid-confident'

  it('classifies a cycleway as a paintable candidate', () => {
    const cls = classifyOverlayWay(way({ highway: 'cycleway' }), profile)
    expect(cls.kind).toBe('candidate')
    if (cls.kind === 'candidate') {
      expect(cls.itemName).not.toBeNull()
      expect(cls.pathLevel).not.toBe('4')
    }
  })

  it('skips LTS 4 (trunk / primary) ways', () => {
    expect(classifyOverlayWay(way({ highway: 'trunk' }), profile).kind).toBe('skip')
    expect(classifyOverlayWay(way({ highway: 'primary' }), profile).kind).toBe('skip')
  })

  it('skips crossing / traffic-island stubs', () => {
    expect(classifyOverlayWay(way({ footway: 'crossing' }), profile).kind).toBe('skip')
    expect(classifyOverlayWay(way({ cycleway: 'crossing' }), profile).kind).toBe('skip')
    expect(classifyOverlayWay(way({ highway: 'crossing' }), profile).kind).toBe('skip')
  })

  it('routes a rough (cobblestone) surface to the hiddenSurface/cobble pass', () => {
    const cls = classifyOverlayWay(way({ highway: 'cycleway', surface: 'cobblestone' }), profile)
    expect(cls.kind).toBe('hiddenSurface')
    if (cls.kind === 'hiddenSurface') expect(cls.rough).toBe(true)
  })

  it('is a pure function of tags + profile (same input → same output)', () => {
    const tags = { highway: 'residential' }
    const a = classifyOverlayWay(way(tags), profile)
    const b = classifyOverlayWay(way(tags), profile)
    expect(a).toEqual(b)
  })

  it('honours a region rule override before the hardcoded path', () => {
    const rules: ClassificationRule[] = [
      { match: { name: 'Some Bike Blvd' }, classification: 'Fahrradstraße', travelModes: {} },
    ]
    const cls = classifyOverlayWay(
      way({ highway: 'residential', name: 'Some Bike Blvd' }),
      profile,
      rules,
    )
    // Assert candidate FIRST so a regression that drops the way to
    // skip/hiddenSurface fails loudly instead of passing vacuously.
    expect(cls.kind).toBe('candidate')
    // The itemName must come from the rule, proving regionRules is threaded
    // through (whatever the profile's display level for that item).
    if (cls.kind === 'candidate') expect(cls.itemName).toBe('Fahrradstraße')
  })
})
