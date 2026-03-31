import { describe, it, expect } from 'vitest'
import { decode } from '../src/utils/polyline.js'

describe('decode (Valhalla precision-6 polyline)', () => {
  it('decodes a known short polyline (precision 5)', () => {
    // Classic Google encoded polyline (precision 5): represents (38.5, -120.2), (40.7, -120.95), (43.252, -126.453)
    const encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@'
    const result = decode(encoded, 5)
    expect(result).toHaveLength(3)
    expect(result[0][0]).toBeCloseTo(38.5, 3)
    expect(result[0][1]).toBeCloseTo(-120.2, 3)
    expect(result[1][0]).toBeCloseTo(40.7, 3)
    expect(result[1][1]).toBeCloseTo(-120.95, 3)
    expect(result[2][0]).toBeCloseTo(43.252, 3)
    expect(result[2][1]).toBeCloseTo(-126.453, 3)
  })

  it('returns an empty array for an empty string', () => {
    expect(decode('')).toEqual([])
  })

  it('decodes a single point (precision 6)', () => {
    // Encoding for Berlin center [52.52, 13.405] at precision 6.
    // Manually verified: lat_int=52520000 → dlat<<1=105040000 → '_cqdcB'
    //                    lng_int=13405000 → dlng<<1=26810000  → 'osdqX'
    const result = decode('_cqdcBosdqX', 6)
    expect(result).toHaveLength(1)
    expect(result[0][0]).toBeCloseTo(52.52, 3)
    expect(result[0][1]).toBeCloseTo(13.405, 3)
  })

  it('handles negative coordinates', () => {
    // San Francisco area at precision 5
    const encoded = '~|a}Fjykbh@?_ibE'
    const result = decode(encoded, 5)
    expect(result[0][1]).toBeLessThan(0) // negative longitude (west)
  })

  it('returns [lat, lng] order suitable for Leaflet', () => {
    const result = decode('_p~iF~ps|U', 5)
    expect(result[0]).toHaveLength(2)
    // First element should be latitude (positive, ~38-50 range)
    // Second should be longitude (negative for Americas)
    expect(result[0][0]).toBeGreaterThan(30) // lat
    expect(result[0][1]).toBeLessThan(0)     // lng (west of prime meridian)
  })
})
