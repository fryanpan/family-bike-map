import { describe, it, expect, beforeEach } from 'bun:test'
import {
  resolveGeocoder,
  __resetGeocoderCacheForTests,
} from '../../src/services/geocoder/resolve'

describe('resolveGeocoder', () => {
  beforeEach(() => {
    __resetGeocoderCacheForTests()
  })

  it('returns the Nominatim engine when nominatim is requested', () => {
    const r = resolveGeocoder('nominatim', {})
    expect(r.kind).toBe('nominatim')
    expect(r.fellBack).toBe(false)
    expect(r.engine.kind).toBe('nominatim')
  })

  it('returns the Google engine when google is requested with a key', () => {
    const r = resolveGeocoder('google', { googleMapsKey: 'pk_test' })
    expect(r.kind).toBe('google')
    expect(r.fellBack).toBe(false)
    expect(r.engine.kind).toBe('google')
  })

  it('falls back to Nominatim when google is requested without a key', () => {
    const r = resolveGeocoder('google', {})
    expect(r.kind).toBe('nominatim')
    expect(r.fellBack).toBe(true)
    expect(r.fallbackReason).toContain('VITE_GOOGLE_MAPS_KEY')
    expect(r.engine.kind).toBe('nominatim')
  })

  it('caches the engine instance across calls', () => {
    const a = resolveGeocoder('nominatim', {})
    const b = resolveGeocoder('nominatim', {})
    expect(a.engine).toBe(b.engine)
  })

  it('caches the Google engine instance across calls when key is present', () => {
    const a = resolveGeocoder('google', { googleMapsKey: 'pk_test' })
    const b = resolveGeocoder('google', { googleMapsKey: 'pk_test' })
    expect(a.engine).toBe(b.engine)
  })
})
