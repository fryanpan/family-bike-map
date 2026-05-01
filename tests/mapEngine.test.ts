import { describe, it, expect } from 'bun:test'
import { resolveEngine } from '../src/services/mapEngine/resolve'

describe('resolveEngine', () => {
  it('returns leaflet-osm with osm-carto when requested', () => {
    const r = resolveEngine('leaflet-osm', {})
    expect(r.kind).toBe('leaflet-osm')
    expect(r.baseStyle).toBe('osm-carto')
    expect(r.fellBack).toBe(false)
  })

  it('returns leaflet-maptiler with maptiler key present', () => {
    const r = resolveEngine('leaflet-maptiler', { maptilerKey: 'abc' })
    expect(r.kind).toBe('leaflet-maptiler')
    expect(r.baseStyle).toBe('maptiler-streets-light')
    expect(r.fellBack).toBe(false)
  })

  it('falls back to leaflet-osm when maptiler key missing', () => {
    const r = resolveEngine('leaflet-maptiler', {})
    expect(r.kind).toBe('leaflet-osm')
    expect(r.baseStyle).toBe('osm-carto')
    expect(r.fellBack).toBe(true)
    expect(r.fallbackReason).toContain('VITE_MAPTILER_KEY')
  })

  it('returns google-maps when google key present', () => {
    const r = resolveEngine('google-maps', { googleMapsKey: 'xyz' })
    expect(r.kind).toBe('google-maps')
    expect(r.baseStyle).toBe('google-roadmap')
    expect(r.fellBack).toBe(false)
  })

  it('falls back to leaflet-osm when google key missing', () => {
    const r = resolveEngine('google-maps', {})
    expect(r.kind).toBe('leaflet-osm')
    expect(r.fellBack).toBe(true)
    expect(r.fallbackReason).toContain('VITE_GOOGLE_MAPS_KEY')
  })

  it('honours requested style when supported by the engine', () => {
    const r = resolveEngine('google-maps', { googleMapsKey: 'xyz' }, 'google-satellite')
    expect(r.kind).toBe('google-maps')
    expect(r.baseStyle).toBe('google-satellite')
  })

  it('clamps incompatible style to engine default', () => {
    // 'google-satellite' isn't valid on leaflet-osm — falls back to osm-carto
    const r = resolveEngine('leaflet-osm', {}, 'google-satellite')
    expect(r.kind).toBe('leaflet-osm')
    expect(r.baseStyle).toBe('osm-carto')
  })

  it('clamps style when key missing forces engine fallback', () => {
    const r = resolveEngine('google-maps', {}, 'osm-carto')
    expect(r.kind).toBe('leaflet-osm')
    expect(r.baseStyle).toBe('osm-carto')
  })
})
