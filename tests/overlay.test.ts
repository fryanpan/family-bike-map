import { describe, it, expect } from 'bun:test'
import { applyRegionOverlay } from '../src/data/cityProfiles/overlay'
import { BERLIN_PROFILE } from '../src/data/cityProfiles/berlin'
import type { LtsClassification } from '../src/utils/lts'

function baseClassification(overrides: Partial<LtsClassification> = {}): LtsClassification {
  return {
    lts: 2,
    carFree: false,
    bikePriority: false,
    bikeInfra: false,
    speedKmh: 50,
    trafficDensity: 'moderate',
    surface: null,
    ...overrides,
  }
}

describe('applyRegionOverlay', () => {
  it('returns input unchanged when profile is null', () => {
    const input = baseClassification({ lts: 3 })
    const out = applyRegionOverlay(input, { highway: 'secondary' }, null)
    expect(out).toEqual(input)
  })

  it('returns input unchanged when no rule matches', () => {
    const input = baseClassification({ lts: 3 })
    const out = applyRegionOverlay(input, { highway: 'secondary', name: 'Some Random Street' }, BERLIN_PROFILE)
    expect(out).toEqual(input)
  })

  // ── promote ───────────────────────────────────────────────────────

  it('promotes Landwehrkanal path to LTS 1 + carFree regardless of highway tag', () => {
    const input = baseClassification({ lts: 3, carFree: false })
    const out = applyRegionOverlay(
      input,
      { highway: 'footway', name: 'Landwehrkanal' },
      BERLIN_PROFILE,
    )
    expect(out.lts).toBe(1)
    expect(out.carFree).toBe(true)
  })

  it('promotes Berliner Mauerweg via name substring', () => {
    const input = baseClassification({ lts: 2 })
    const out = applyRegionOverlay(
      input,
      { highway: 'path', name: 'Berliner Mauerweg' },
      BERLIN_PROFILE,
    )
    expect(out.lts).toBe(1)
    expect(out.carFree).toBe(true)
  })

  it('promote rule keeps lts when already at or below target', () => {
    const input = baseClassification({ lts: 1 })
    const out = applyRegionOverlay(
      input,
      { highway: 'path', name: 'Landwehrkanal' },
      BERLIN_PROFILE,
    )
    expect(out.lts).toBe(1) // Math.min(1, 1) === 1
  })

  // ── demote ────────────────────────────────────────────────────────

  it('demotes Oranienstraße tertiary painted lane to LTS 3 and clears bikePriority', () => {
    const input = baseClassification({ lts: 2, bikePriority: true })
    const out = applyRegionOverlay(
      input,
      { highway: 'tertiary', name: 'Oranienstraße', cycleway: 'lane' },
      BERLIN_PROFILE,
    )
    expect(out.lts).toBe(3)
    expect(out.bikePriority).toBe(false)
  })

  it('does NOT demote a side street also named Oranienstraße (no tertiary match)', () => {
    // match.tags requires highway=tertiary; a side-street residential with
    // the same name shouldn't trip the rule.
    const input = baseClassification({ lts: 1, bikePriority: false })
    const out = applyRegionOverlay(
      input,
      { highway: 'residential', name: 'Oranienstraße' },
      BERLIN_PROFILE,
    )
    expect(out.lts).toBe(1)
  })

  // ── zone surface ──────────────────────────────────────────────────

  it('applies cobblestone surface inside the Altstadt bbox', () => {
    const input = baseClassification({ surface: 'asphalt' })
    // Point in Museumsinsel area — inside bbox [52.5160, 13.3950, 52.5260, 13.4200]
    const out = applyRegionOverlay(
      input,
      { highway: 'residential' },
      BERLIN_PROFILE,
      52.5190,
      13.4050,
    )
    expect(out.surface).toBe('cobblestone')
  })

  it('does NOT apply cobblestone surface outside the Altstadt bbox', () => {
    const input = baseClassification({ surface: 'asphalt' })
    // Point in Neukölln — well outside the zone
    const out = applyRegionOverlay(
      input,
      { highway: 'residential' },
      BERLIN_PROFILE,
      52.4800,
      13.4300,
    )
    expect(out.surface).toBe('asphalt')
  })

  it('zone rule does nothing when centerLat/centerLng are omitted', () => {
    const input = baseClassification({ surface: 'asphalt' })
    const out = applyRegionOverlay(
      input,
      { highway: 'residential' },
      BERLIN_PROFILE,
    )
    expect(out.surface).toBe('asphalt')
  })

  // ── no cross-contamination ────────────────────────────────────────

  it('does not mutate the input classification', () => {
    const input = baseClassification({ lts: 3, carFree: false })
    const snapshot = { ...input }
    applyRegionOverlay(
      input,
      { highway: 'footway', name: 'Landwehrkanal' },
      BERLIN_PROFILE,
    )
    expect(input).toEqual(snapshot)
  })
})
