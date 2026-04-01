import { describe, it, expect } from 'bun:test'
import { classifyEdge, worsen } from '../src/utils/classify'
import type { ValhallaEdge } from '../src/utils/types'

// NOTE: Valhalla's trace_attributes API returns STRING values for use, cycle_lane,
// and road_class (not the numeric codes in older docs). All test fixtures below
// use the string form that the actual API returns.

// ── Fahrradstrasse (bicycle_road=yes) ─────────────────────────────────────────

describe('classifyEdge — Fahrradstrasse', () => {
  it('classifies bicycle_road=yes as great for all profiles', () => {
    const edge: ValhallaEdge = { bicycle_road: true, road_class: 'residential' }
    expect(classifyEdge(edge, 'toddler')).toBe('great')
    expect(classifyEdge(edge, 'trailer')).toBe('great')
    expect(classifyEdge(edge, 'training')).toBe('great')
  })
})

// ── Car-free paths and cycleways ──────────────────────────────────────────────

describe('classifyEdge — car-free paths (use="cycleway", "path", "mountain_bike")', () => {
  it('classifies use=cycleway as great', () => {
    const edge: ValhallaEdge = { use: 'cycleway' }
    expect(classifyEdge(edge, 'toddler')).toBe('great')
    expect(classifyEdge(edge, 'trailer')).toBe('great')
  })

  it('classifies use=path (trail e.g. Engeldam) as great', () => {
    const edge: ValhallaEdge = { use: 'path' }
    expect(classifyEdge(edge, 'toddler')).toBe('great')
    expect(classifyEdge(edge, 'trailer')).toBe('great')
  })

  it('classifies use=mountain_bike path as great', () => {
    const edge: ValhallaEdge = { use: 'mountain_bike' }
    expect(classifyEdge(edge, 'toddler')).toBe('great')
  })

  it('classifies dirt path (use=path, surface=dirt) as great — dirt is NOT a bad surface', () => {
    // surface=dirt is NOT in the BAD_SURFACES set; it is a rideable park trail.
    const edge: ValhallaEdge = { use: 'path', surface: 'dirt' }
    expect(classifyEdge(edge, 'toddler')).toBe('great')
    expect(classifyEdge(edge, 'trailer')).toBe('great')
  })
})

// ── Shared footway / pedestrian paths (park paths, Tiergarten trails) ────────

describe('classifyEdge — shared footway/pedestrian paths', () => {
  it('classifies use=footway as good for all profiles', () => {
    // Footways shared with cyclists (e.g. Tiergarten park trails) are car-free
    // and pleasant — treat as good, not great (shared with pedestrians).
    const edge: ValhallaEdge = { use: 'footway' }
    expect(classifyEdge(edge, 'toddler')).toBe('good')
    expect(classifyEdge(edge, 'trailer')).toBe('good')
    expect(classifyEdge(edge, 'training')).toBe('good')
  })

  it('classifies use=pedestrian as good for all profiles', () => {
    const edge: ValhallaEdge = { use: 'pedestrian' }
    expect(classifyEdge(edge, 'toddler')).toBe('good')
    expect(classifyEdge(edge, 'training')).toBe('good')
  })
})

// ── Separated bike track alongside road (cycleway=track) ─────────────────────

describe('classifyEdge — separated track (cycle_lane="separated")', () => {
  it('classifies elevated separated path as good for all profiles', () => {
    const edge: ValhallaEdge = { cycle_lane: 'separated' }
    expect(classifyEdge(edge, 'toddler')).toBe('good')
    expect(classifyEdge(edge, 'trailer')).toBe('good')
    expect(classifyEdge(edge, 'training')).toBe('good')
  })
})

// ── Painted road bike lane (cycleway=lane) ────────────────────────────────────

describe('classifyEdge — painted road lane (cycle_lane="dedicated")', () => {
  it('classifies painted lane as avoid for toddler', () => {
    const edge: ValhallaEdge = { cycle_lane: 'dedicated' }
    expect(classifyEdge(edge, 'toddler')).toBe('avoid')
  })

  it('classifies painted lane as ok for trailer and training', () => {
    const edge: ValhallaEdge = { cycle_lane: 'dedicated' }
    expect(classifyEdge(edge, 'trailer')).toBe('ok')
    expect(classifyEdge(edge, 'training')).toBe('ok')
  })
})

// ── Shared bus lane (cycleway=share_busway) ───────────────────────────────────

describe('classifyEdge — shared bus lane (cycle_lane="share_busway")', () => {
  it('classifies bus lane as caution for toddler (not safe with small child)', () => {
    const edge: ValhallaEdge = { cycle_lane: 'share_busway' }
    expect(classifyEdge(edge, 'toddler')).toBe('caution')
  })

  it('classifies bus lane as good for training (bus lanes good for fast riding)', () => {
    // Fixed: was returning "acceptable" — bus lanes are positive infrastructure for training.
    const edge: ValhallaEdge = { cycle_lane: 'share_busway' }
    expect(classifyEdge(edge, 'training')).toBe('good')
  })

  it('classifies bus lane as acceptable for trailer', () => {
    const edge: ValhallaEdge = { cycle_lane: 'share_busway' }
    expect(classifyEdge(edge, 'trailer')).toBe('acceptable')
  })
})

// ── Bad surfaces (cobblestones) ───────────────────────────────────────────────

describe('classifyEdge — bad surfaces', () => {
  it('worsens classification on cobblestone for toddler and trailer', () => {
    // A separated track on cobblestones should drop from good → ok
    const edge: ValhallaEdge = { cycle_lane: 'separated', surface: 'cobblestone' }
    expect(classifyEdge(edge, 'toddler')).toBe('ok')
    expect(classifyEdge(edge, 'trailer')).toBe('ok')
  })

  it('does NOT worsen classification on cobblestone for training profile', () => {
    const edge: ValhallaEdge = { cycle_lane: 'separated', surface: 'cobblestone' }
    expect(classifyEdge(edge, 'training')).toBe('good')
  })

  it('worsens sett (Kopfsteinpflaster) for toddler', () => {
    // Great path on sett → good (one level worse)
    const edge: ValhallaEdge = { use: 'cycleway', surface: 'sett' }
    expect(classifyEdge(edge, 'toddler')).toBe('good')
  })

  it('does NOT treat dirt or compacted as bad surfaces', () => {
    // dirt / compacted are rideable park surfaces — should not be penalised
    const dirt: ValhallaEdge = { cycle_lane: 'separated', surface: 'dirt' }
    const compacted: ValhallaEdge = { cycle_lane: 'separated', surface: 'compacted' }
    expect(classifyEdge(dirt, 'toddler')).toBe('good')
    expect(classifyEdge(compacted, 'toddler')).toBe('good')
  })

  it('worsens gravel and unpaved for toddler and trailer', () => {
    // gravel and unpaved are in BAD_SURFACES — separated track on gravel drops to ok
    const gravel: ValhallaEdge = { cycle_lane: 'separated', surface: 'gravel' }
    const unpaved: ValhallaEdge = { cycle_lane: 'separated', surface: 'unpaved' }
    expect(classifyEdge(gravel, 'toddler')).toBe('ok')
    expect(classifyEdge(gravel, 'trailer')).toBe('ok')
    expect(classifyEdge(unpaved, 'toddler')).toBe('ok')
  })

  it('does NOT worsen gravel for training profile', () => {
    const edge: ValhallaEdge = { cycle_lane: 'separated', surface: 'gravel' }
    expect(classifyEdge(edge, 'training')).toBe('good')
  })
})

// ── Road class fallback ───────────────────────────────────────────────────────

describe('classifyEdge — road class fallback', () => {
  it('classifies residential (road_class=residential) as acceptable', () => {
    const edge: ValhallaEdge = { road_class: 'residential' }
    expect(classifyEdge(edge, 'toddler')).toBe('acceptable')
  })

  it('classifies service road as acceptable', () => {
    const edge: ValhallaEdge = { road_class: 'service_other' }
    expect(classifyEdge(edge, 'toddler')).toBe('acceptable')
  })

  it('classifies tertiary as caution', () => {
    const edge: ValhallaEdge = { road_class: 'tertiary' }
    expect(classifyEdge(edge, 'toddler')).toBe('caution')
  })

  it('classifies unclassified as caution (rank 5, falls to caution bucket)', () => {
    const edge: ValhallaEdge = { road_class: 'unclassified' }
    expect(classifyEdge(edge, 'toddler')).toBe('caution')
  })

  it('classifies primary as avoid', () => {
    const edge: ValhallaEdge = { road_class: 'primary' }
    expect(classifyEdge(edge, 'toddler')).toBe('avoid')
  })

  it('classifies secondary as avoid', () => {
    const edge: ValhallaEdge = { road_class: 'secondary' }
    expect(classifyEdge(edge, 'toddler')).toBe('avoid')
  })
})

// ── null / undefined edge ─────────────────────────────────────────────────────

describe('classifyEdge — null edge', () => {
  it('returns acceptable for null edge', () => {
    expect(classifyEdge(null)).toBe('acceptable')
    expect(classifyEdge(undefined)).toBe('acceptable')
  })
})

// ── worsen helper ─────────────────────────────────────────────────────────────

describe('worsen', () => {
  it('degrades each class by one level', () => {
    expect(worsen('great')).toBe('good')
    expect(worsen('good')).toBe('ok')
    expect(worsen('ok')).toBe('acceptable')
    expect(worsen('acceptable')).toBe('caution')
    expect(worsen('caution')).toBe('avoid')
  })

  it('cannot degrade below avoid', () => {
    expect(worsen('avoid')).toBe('avoid')
  })
})
