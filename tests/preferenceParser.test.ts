import { describe, it, expect } from 'bun:test'
import { parsePreferenceText } from '../src/data/preferenceParser'
import { applyPreferenceAdjustments } from '../src/data/preferences'
import type { LtsClassification } from '../src/utils/lts'

describe('parsePreferenceText — surface tolerance', () => {
  it('"cobbles are fine" → ok for cobblestone', () => {
    const r = parsePreferenceText('cobbles are fine')
    expect(r.adjustments).toEqual([{ kind: 'surface', surface: 'cobblestone', tolerance: 'ok' }])
    expect(r.unparsed).toEqual([])
  })

  it('"cobblestones are ok" and "cobblestones no problem" both parse', () => {
    const a = parsePreferenceText('cobblestones are ok')
    const b = parsePreferenceText('cobblestones are no problem')
    expect(a.adjustments[0].kind).toBe('surface')
    expect((a.adjustments[0] as { surface: string }).surface).toBe('cobblestone')
    expect(b.adjustments[0].kind).toBe('surface')
  })

  it('"I don\'t mind paving stones" → ok for paving_stones', () => {
    const r = parsePreferenceText("I don't mind paving stones")
    expect(r.adjustments).toEqual([{ kind: 'surface', surface: 'paving_stones', tolerance: 'ok' }])
  })

  it('"hate cobbles" → rough for cobblestone', () => {
    const r = parsePreferenceText('hate cobbles')
    expect(r.adjustments).toEqual([{ kind: 'surface', surface: 'cobblestone', tolerance: 'rough' }])
  })

  it('"avoid gravel" → rough for gravel', () => {
    const r = parsePreferenceText('avoid gravel')
    expect(r.adjustments).toEqual([{ kind: 'surface', surface: 'gravel', tolerance: 'rough' }])
  })
})

describe('parsePreferenceText — path types', () => {
  it('"prefer Fahrradstraßen" → prefer Fahrradstrasse', () => {
    const r = parsePreferenceText('prefer Fahrradstraße')
    expect(r.adjustments).toEqual([{ kind: 'path-type', item: 'Fahrradstrasse', pref: 'prefer' }])
  })

  it('"love bike paths" → prefer Bike path', () => {
    const r = parsePreferenceText('love bike paths')
    expect(r.adjustments[0]).toEqual({ kind: 'path-type', item: 'Bike path', pref: 'prefer' })
  })

  it('"avoid painted bike lanes" → avoid Painted bike lane', () => {
    const r = parsePreferenceText('avoid painted bike lanes')
    expect(r.adjustments[0]).toEqual({ kind: 'path-type', item: 'Painted bike lane', pref: 'avoid' })
  })

  it('"skip bus lane" → avoid Shared bus lane', () => {
    const r = parsePreferenceText('skip bus lane')
    expect(r.adjustments[0]).toEqual({ kind: 'path-type', item: 'Shared bus lane', pref: 'avoid' })
  })
})

describe('parsePreferenceText — multi-line', () => {
  it('parses multiple sentences', () => {
    const r = parsePreferenceText("cobbles are fine. avoid painted bike lanes.\nprefer Fahrradstraße")
    expect(r.adjustments).toHaveLength(3)
    expect(r.unparsed).toEqual([])
  })

  it('captures unparsed fragments', () => {
    const r = parsePreferenceText('cobbles are fine. I hate potholes really much.')
    expect(r.adjustments).toHaveLength(1)
    expect(r.unparsed).toHaveLength(1)
    expect(r.unparsed[0]).toContain('potholes')
  })

  it('splits on and / but / also', () => {
    const r = parsePreferenceText('avoid gravel but love fine gravel')
    // Should produce exactly two adjustments, not merge them into one
    // rule matching both "gravel" and "fine" in the same fragment.
    expect(r.adjustments).toHaveLength(2)
    const kinds = r.adjustments.map((a) => (a as { surface: string }).surface)
    expect(kinds).toContain('gravel')
    expect(kinds).toContain('fine_gravel')
  })

  it('empty input yields empty result', () => {
    const r = parsePreferenceText('')
    expect(r.adjustments).toEqual([])
    expect(r.unparsed).toEqual([])
  })
})

describe('parsePreferenceText — negation safety', () => {
  it('"I don\'t hate cobbles" goes unparsed (not inverted to ok)', () => {
    const r = parsePreferenceText("I don't hate cobbles")
    expect(r.adjustments).toEqual([])
    expect(r.unparsed.length).toBeGreaterThan(0)
  })

  it('"do not avoid cobbles" goes unparsed', () => {
    const r = parsePreferenceText('do not avoid cobbles')
    expect(r.adjustments).toEqual([])
    expect(r.unparsed.length).toBeGreaterThan(0)
  })

  it('"don\'t mind cobbles" still parses as ok (idiomatic positive)', () => {
    const r = parsePreferenceText("I don't mind cobbles")
    expect(r.adjustments).toEqual([{ kind: 'surface', surface: 'cobblestone', tolerance: 'ok' }])
  })

  it('"never ride painted lanes" goes unparsed (negation)', () => {
    const r = parsePreferenceText('never ride painted lanes')
    expect(r.adjustments).toEqual([])
  })
})

describe('applyPreferenceAdjustments', () => {
  const base = (): LtsClassification => ({
    lts: 2,
    pathLevel: '2b',
    carFree: false,
    bikePriority: false,
    bikeInfra: false,
    speedKmh: 30,
    trafficDensity: 'low',
    surface: 'cobblestone',
    smoothness: null,
  })

  it('null preference is a pass-through', () => {
    const input = base()
    const out = applyPreferenceAdjustments(input, null)
    expect(out).toEqual(input)
  })

  it('preference with empty adjustments is a pass-through', () => {
    const pref = {
      name: 'Bryan', rawText: '', adjustments: [], unparsed: [],
      createdAt: 0, updatedAt: 0,
    }
    const input = base()
    const out = applyPreferenceAdjustments(input, pref)
    expect(out).toEqual(input)
  })

  it('"cobbles are fine" clears the surface field on a cobble edge', () => {
    const { adjustments, unparsed } = parsePreferenceText('cobbles are fine')
    const pref = {
      name: 'Joanna', rawText: 'cobbles are fine', adjustments, unparsed,
      createdAt: 0, updatedAt: 0,
    }
    const out = applyPreferenceAdjustments(base(), pref)
    expect(out.surface).toBeNull()
  })

  it('"cobbles are fine" leaves non-cobble edges unchanged', () => {
    const pref = parsePreferenceText('cobbles are fine')
    const input = { ...base(), surface: 'asphalt' }
    const out = applyPreferenceAdjustments(input, {
      name: '', rawText: '', adjustments: pref.adjustments, unparsed: pref.unparsed,
      createdAt: 0, updatedAt: 0,
    })
    expect(out.surface).toBe('asphalt')
  })

  it('does not mutate input', () => {
    const pref = parsePreferenceText('cobbles are fine')
    const input = base()
    const snapshot = { ...input }
    applyPreferenceAdjustments(input, {
      name: '', rawText: '', adjustments: pref.adjustments, unparsed: pref.unparsed,
      createdAt: 0, updatedAt: 0,
    })
    expect(input).toEqual(snapshot)
  })
})
