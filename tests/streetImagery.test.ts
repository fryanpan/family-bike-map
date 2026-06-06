import { describe, it, expect } from 'bun:test'
import { resolveStreetImagery, type ResolveImageryDeps } from '../src/services/streetImagery'

function deps(over: Partial<ResolveImageryDeps>): ResolveImageryDeps {
  return {
    coverage: async () => 'none',
    mapillary: async () => null,
    streetViewUrl: (lat, lng) => `/api/streetview?lat=${lat}&lng=${lng}`,
    ...over,
  }
}

describe('resolveStreetImagery', () => {
  it('uses Street View when Google has coverage (no Mapillary call needed)', async () => {
    let mapillaryCalled = false
    const r = await resolveStreetImagery(52.52, 13.405, deps({
      coverage: async () => 'ok',
      mapillary: async () => { mapillaryCalled = true; return null },
    }))
    expect(r.kind).toBe('streetview')
    expect(r.url).toContain('/api/streetview')
    expect(r.credit).toBeUndefined() // Street View has its own baked-in watermark
    expect(mapillaryCalled).toBe(false)
  })

  it('falls back to Mapillary when Street View has no coverage', async () => {
    const r = await resolveStreetImagery(37.76, -122.45, deps({
      coverage: async () => 'none',
      mapillary: async () => ({ thumbUrl: 'https://mapillary.example/thumb.jpg' }),
    }))
    expect(r.kind).toBe('mapillary')
    expect(r.url).toBe('https://mapillary.example/thumb.jpg')
    expect(r.credit).toBe('Mapillary')
  })

  it("returns 'none' when neither source has imagery", async () => {
    const r = await resolveStreetImagery(0, 0, deps({
      coverage: async () => 'none',
      mapillary: async () => null,
    }))
    expect(r.kind).toBe('none')
    expect(r.url).toBeUndefined()
  })
})
