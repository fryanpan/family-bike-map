import { describe, it, expect } from 'bun:test'
import { prepareOverlayPaint } from '../scripts/bench-overlay-paint'
import type { OsmWay } from '../src/utils/types'

// These tests exercise prepareOverlayPaint's correctness (does it wire the
// real production gates together the way BikeMapOverlay.tsx does), not its
// performance — bench-overlay-paint.ts itself is the perf assertion,
// checked manually / in CI by running the script. A pipeline that's fast
// but silently classifies everything as hidden (or vice versa) would pass
// the perf budget while being a useless benchmark, so these guard the
// "measuring the real thing" property.

function way(overrides: Partial<OsmWay> & { osmId: number; coordinates: [number, number][] }): OsmWay {
  return { itemName: null, tags: {}, ...overrides }
}

describe('prepareOverlayPaint (bench-overlay-paint.ts pipeline)', () => {
  // zoom 16 (>= FRAGMENT_SHOW_MIN_ZOOM) so these single short-way cases
  // aren't confounded by the unrelated floating-fragment gate — that gate
  // has its own dedicated test below.
  it('paints a preferred item (cycleway -> "Bike path", preferred for kid-confident)', () => {
    const ways: OsmWay[] = [
      way({ osmId: 1, tags: { highway: 'cycleway' }, coordinates: [[37.76, -122.43], [37.7605, -122.4305]] }),
    ]
    const result = prepareOverlayPaint(ways, 'kid-confident', 16)
    expect(result.painted).toBe(1)
    expect(result.hidden).toBe(0)
  })

  it('does NOT paint a non-preferred item (quiet residential is off by default for every mode)', () => {
    const ways: OsmWay[] = [
      way({ osmId: 1, tags: { highway: 'residential' }, coordinates: [[37.76, -122.43], [37.7605, -122.4305]] }),
    ]
    const result = prepareOverlayPaint(ways, 'kid-confident', 16)
    expect(result.painted).toBe(0)
  })

  it('excludes LTS4 major roads from painting (never reach the gate at all)', () => {
    const ways: OsmWay[] = [
      way({ osmId: 1, tags: { highway: 'primary', maxspeed: '55' }, coordinates: [[37.76, -122.43], [37.7605, -122.4305]] }),
    ]
    const result = prepareOverlayPaint(ways, 'kid-confident', 14)
    expect(result.painted).toBe(0)
    expect(result.hidden).toBe(0) // never became a candidate, so not counted as gated-hidden either
  })

  it('excludes crossing stubs from painting', () => {
    const ways: OsmWay[] = [
      way({ osmId: 1, tags: { highway: 'footway', footway: 'crossing' }, coordinates: [[37.76, -122.43], [37.7601, -122.4301]] }),
    ]
    const result = prepareOverlayPaint(ways, 'kid-confident', 14)
    expect(result.painted).toBe(0)
  })

  it('routes rough-surface ways to the stipple pass only at street-detail zoom', () => {
    const ways: OsmWay[] = [
      way({ osmId: 1, tags: { highway: 'residential', surface: 'cobblestone' }, coordinates: [[37.76, -122.43], [37.7601, -122.4301]] }),
    ]
    const metro = prepareOverlayPaint(ways, 'kid-confident', 14)
    expect(metro.painted).toBe(0)
    expect(metro.roughStippled).toBe(0) // below COBBLE_MARKER_MIN_ZOOM (16)
    const street = prepareOverlayPaint(ways, 'kid-confident', 16)
    expect(street.roughStippled).toBe(1)
  })

  it('skips control-node pseudo-ways (single coordinate)', () => {
    const ways: OsmWay[] = [
      way({ osmId: 1, tags: { highway: 'traffic_signals' }, coordinates: [[37.76, -122.43]] }),
    ]
    const result = prepareOverlayPaint(ways, 'kid-confident', 14)
    expect(result.painted).toBe(0)
    expect(result.hidden).toBe(0)
  })

  it('hides an enriched way whose baked gradient exceeds the mode ceiling', () => {
    const steep: OsmWay = {
      itemName: null,
      osmId: 1,
      tags: { highway: 'cycleway' },
      coordinates: [[37.76, -122.43], [37.7605, -122.4305]],
      gradientPct: 20, // overlay ceiling for every mode is well under 20%
      accessGradientPct: null,
      componentPaintedLenM: 500,
    }
    const result = prepareOverlayPaint([steep], 'kid-confident', 14)
    expect(result.painted).toBe(0)
    expect(result.hidden).toBe(1)
  })

  it('applies the fragment floor to a short enriched component below zoom 15, not above', () => {
    const fragment: OsmWay = {
      itemName: null,
      osmId: 1,
      tags: { highway: 'cycleway' },
      coordinates: [[37.76, -122.43], [37.7601, -122.4301]],
      gradientPct: 1,
      accessGradientPct: 1,
      componentPaintedLenM: 20, // well under FRAGMENT_MIN_LEN_M (100)
    }
    const metro = prepareOverlayPaint([fragment], 'kid-confident', 14) // fragmentFloorActive
    expect(metro.painted).toBe(0)
    expect(metro.hidden).toBe(1)
    const streetDetail = prepareOverlayPaint([fragment], 'kid-confident', 16) // above FRAGMENT_SHOW_MIN_ZOOM
    expect(streetDetail.painted).toBe(1)
  })

  it('an ungradable raw stub with no graded neighbours fails soft to shown (no false hides)', () => {
    // A single short cycleway in complete isolation: gradientPct resolves
    // null (below MIN_GRADED_LEN_M) for every raw way in these tests since
    // overlayGradientPct is fed a no-elevation-cached lookup — there's no
    // graded context at all, so inheritStubVerdicts must leave it shown
    // per its own fail-soft contract. zoom 16 to isolate from the separate
    // floating-fragment gate (this way is well under FRAGMENT_MIN_LEN_M).
    const ways: OsmWay[] = [
      way({ osmId: 1, tags: { highway: 'cycleway' }, coordinates: [[37.76, -122.43], [37.76005, -122.43005]] }),
    ]
    const result = prepareOverlayPaint(ways, 'kid-confident', 16)
    expect(result.painted).toBe(1)
  })
})
