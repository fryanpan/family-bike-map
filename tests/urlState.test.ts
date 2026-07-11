import { describe, it, expect } from 'bun:test'
import {
  serializeMapState,
  parseMapState,
  mergeManagedParams,
  emptyMapUrlState,
  type MapUrlState,
} from '../src/utils/urlState'

// A fully-populated state used across round-trip tests. All coords are already
// at 5-dp precision so serialize→parse→serialize is lossless.
const FULL: MapUrlState = {
  center: { lat: 52.52, lng: 13.405 },
  zoom: 14,
  travelMode: 'kid-confident',
  search: { lat: 52.5001, lng: 13.4002, label: 'Kreuzberg, Berlin' },
  start: { lat: 52.51, lng: 13.4 },
  end: { lat: 52.53, lng: 13.42 },
  waypoints: [
    { lat: 52.515, lng: 13.41 },
    { lat: 52.525, lng: 13.415 },
  ],
}

describe('serializeMapState', () => {
  it('emits keys in canonical order with 5-dp coords', () => {
    expect(serializeMapState(FULL)).toBe(
      'travelMode=kid-confident' +
      '&center=52.52000,13.40500' +
      '&zoom=14' +
      '&place=52.50010,13.40020' +
      '&placeLabel=Kreuzberg%2C%20Berlin' +
      '&start=52.51000,13.40000' +
      '&end=52.53000,13.42000' +
      '&via=52.51500,13.41000;52.52500,13.41500',
    )
  })

  it('returns empty string for empty state', () => {
    expect(serializeMapState(emptyMapUrlState())).toBe('')
  })

  it('omits absent fields', () => {
    const s: MapUrlState = { ...emptyMapUrlState(), zoom: 13, travelMode: 'kid-starting-out' }
    expect(serializeMapState(s)).toBe('travelMode=kid-starting-out&zoom=13')
  })

  it('normalizes integer zoom without trailing zeros and rounds to 2dp', () => {
    expect(serializeMapState({ ...emptyMapUrlState(), zoom: 13 })).toBe('zoom=13')
    expect(serializeMapState({ ...emptyMapUrlState(), zoom: 13.5 })).toBe('zoom=13.5')
    expect(serializeMapState({ ...emptyMapUrlState(), zoom: 13.456 })).toBe('zoom=13.46')
  })

  it('is stable regardless of the object key order (same canonical string)', () => {
    const reordered: MapUrlState = {
      waypoints: FULL.waypoints,
      end: FULL.end,
      start: FULL.start,
      search: FULL.search,
      travelMode: FULL.travelMode,
      zoom: FULL.zoom,
      center: FULL.center,
    }
    expect(serializeMapState(reordered)).toBe(serializeMapState(FULL))
  })

  it('drops a search label but keeps the coords when label is null', () => {
    const s: MapUrlState = {
      ...emptyMapUrlState(),
      search: { lat: 52.5, lng: 13.4, label: null },
    }
    expect(serializeMapState(s)).toBe('place=52.50000,13.40000')
  })

  it('skips coordinates that are out of range', () => {
    const s: MapUrlState = {
      ...emptyMapUrlState(),
      center: { lat: 999, lng: 13.4 },
      zoom: 12,
    }
    expect(serializeMapState(s)).toBe('zoom=12')
  })
})

describe('parseMapState', () => {
  it('round-trips a fully-populated state', () => {
    expect(parseMapState(serializeMapState(FULL))).toEqual(FULL)
  })

  it('accepts a leading ? in the query string', () => {
    expect(parseMapState('?zoom=15&travelMode=training').zoom).toBe(15)
    expect(parseMapState('?zoom=15&travelMode=training').travelMode).toBe('training')
  })

  it('returns empty state for an empty/garbage query', () => {
    expect(parseMapState('')).toEqual(emptyMapUrlState())
    expect(parseMapState('foo=bar&baz')).toEqual(emptyMapUrlState())
  })

  it('fails soft on individual malformed params without dropping valid ones', () => {
    const s = parseMapState('center=notacoord&zoom=abc&start=52.5,13.4&end=51.0')
    expect(s.center).toBeNull()
    expect(s.zoom).toBeNull()
    expect(s.start).toEqual({ lat: 52.5, lng: 13.4 })
    expect(s.end).toBeNull() // only one component
  })

  it('rejects out-of-range coordinates', () => {
    expect(parseMapState('center=91,13.4').center).toBeNull()
    expect(parseMapState('center=52.5,181').center).toBeNull()
    expect(parseMapState('start=-90,-180').start).toEqual({ lat: -90, lng: -180 })
  })

  it('rejects out-of-range zoom', () => {
    expect(parseMapState('zoom=-1').zoom).toBeNull()
    expect(parseMapState('zoom=99').zoom).toBeNull()
    expect(parseMapState('zoom=0').zoom).toBe(0)
    expect(parseMapState('zoom=22').zoom).toBe(22)
  })

  it('parses a waypoint list and skips malformed entries', () => {
    const s = parseMapState('via=52.5,13.4;garbage;52.6,13.5;999,0')
    expect(s.waypoints).toEqual([
      { lat: 52.5, lng: 13.4 },
      { lat: 52.6, lng: 13.5 },
    ])
  })

  it('decodes a percent-encoded search label (including commas and spaces)', () => {
    const s = parseMapState('place=52.5,13.4&placeLabel=Kreuzberg%2C%20Berlin')
    expect(s.search).toEqual({ lat: 52.5, lng: 13.4, label: 'Kreuzberg, Berlin' })
  })

  it('treats a placeLabel without place coords as no search', () => {
    expect(parseMapState('placeLabel=Nowhere').search).toBeNull()
  })

  it('handles a search place with no label', () => {
    expect(parseMapState('place=52.5,13.4').search).toEqual({
      lat: 52.5, lng: 13.4, label: null,
    })
  })

  it('serialize→parse→serialize is idempotent for arbitrary precision input', () => {
    // Precision beyond 5dp is lossy on the first serialize but stable after.
    const messy: MapUrlState = {
      ...emptyMapUrlState(),
      center: { lat: 52.523456789, lng: 13.405111 },
      zoom: 13.999,
    }
    const once = serializeMapState(messy)
    const twice = serializeMapState(parseMapState(once))
    expect(twice).toBe(once)
  })
})

describe('mergeManagedParams', () => {
  it('preserves non-managed params and appends the canonical managed block', () => {
    const merged = mergeManagedParams('admin=samples&mobile=1', {
      ...emptyMapUrlState(),
      travelMode: 'kid-confident',
      zoom: 14,
    })
    expect(merged).toBe('admin=samples&mobile=1&travelMode=kid-confident&zoom=14')
  })

  it('drops legacy params and stale managed params from the existing URL', () => {
    const merged = mergeManagedParams(
      'preferred=Radweg&showOther=1&travelMode=old&zoom=9&admin=samples',
      { ...emptyMapUrlState(), travelMode: 'training', zoom: 16 },
    )
    // preferred/showOther dropped; old travelMode/zoom replaced by fresh block;
    // admin preserved.
    expect(merged).toBe('admin=samples&travelMode=training&zoom=16')
  })

  it('returns just the managed block when there are no other params', () => {
    expect(mergeManagedParams('', { ...emptyMapUrlState(), zoom: 12 })).toBe('zoom=12')
  })

  it('returns empty string when nothing is present', () => {
    expect(mergeManagedParams('', emptyMapUrlState())).toBe('')
  })
})
