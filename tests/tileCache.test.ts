import { describe, test, expect } from 'bun:test'
import { detectRegion, estimateTiles, bboxFromCenter } from '../src/services/tileCache'

describe('detectRegion', () => {
  test('detects Berlin', () => {
    const result = detectRegion(52.52, 13.405)
    expect(result.name).toBe('berlin')
    expect(result.bbox.south).toBeLessThan(52.52)
    expect(result.bbox.north).toBeGreaterThan(52.52)
  })

  test('detects Copenhagen', () => {
    const result = detectRegion(55.676, 12.568)
    expect(result.name).toBe('copenhagen')
  })

  test('detects San Francisco', () => {
    const result = detectRegion(37.775, -122.419)
    expect(result.name).toBe('san francisco')
  })

  test('detects Hamburg', () => {
    const result = detectRegion(53.55, 10.0)
    expect(result.name).toBe('hamburg')
  })

  test('unknown location returns 15km radius bbox', () => {
    const result = detectRegion(48.856, 2.352) // Paris — not in presets
    expect(result.name).toContain('area-')
    // 15km radius ≈ 0.135° latitude
    const latSpan = result.bbox.north - result.bbox.south
    expect(latSpan).toBeGreaterThan(0.25) // ~2 * 15/111 ≈ 0.27
    expect(latSpan).toBeLessThan(0.30)
  })

  test('detects Oakland', () => {
    const result = detectRegion(37.80, -122.27)
    expect(result.name).toBe('oakland')
  })

  test('detects Berkeley', () => {
    const result = detectRegion(37.876, -122.26)
    expect(result.name).toBe('berkeley')
  })

  test('detects Marin', () => {
    const result = detectRegion(37.95, -122.50)
    expect(result.name).toBe('marin')
  })
})

describe('estimateTiles', () => {
  test('single tile bbox returns 1 tile', () => {
    const result = estimateTiles({ south: 52.5, west: 13.4, north: 52.55, east: 13.45 })
    expect(result.tileCount).toBe(1)
    expect(result.estimatedSeconds).toBeGreaterThan(0)
  })

  test('small area returns correct tile count', () => {
    // floor(52.4/0.1)=524 to floor(52.7/0.1)=527 → 4 rows
    // floor(13.3/0.1)=133 to floor(13.6/0.1)=136 → 4 cols → 16 tiles
    const result = estimateTiles({ south: 52.4, west: 13.3, north: 52.7, east: 13.6 })
    expect(result.tileCount).toBe(16)
  })

  test('estimated seconds scales with tile count', () => {
    const small = estimateTiles({ south: 52.5, west: 13.4, north: 52.55, east: 13.45 })
    const large = estimateTiles({ south: 52.4, west: 13.3, north: 52.7, east: 13.6 })
    expect(large.estimatedSeconds).toBeGreaterThan(small.estimatedSeconds)
  })
})

describe('bboxFromCenter', () => {
  test('returns symmetric bbox around center', () => {
    const bbox = bboxFromCenter(52.52, 13.405, 3)
    expect(bbox.south).toBeLessThan(52.52)
    expect(bbox.north).toBeGreaterThan(52.52)
    expect(bbox.west).toBeLessThan(13.405)
    expect(bbox.east).toBeGreaterThan(13.405)
  })

  test('3km radius gives ~0.054 degree lat span each side', () => {
    const bbox = bboxFromCenter(52.52, 13.405, 3)
    const latSpan = bbox.north - bbox.south
    // 3km each side = 6km total, 6/111 ≈ 0.054
    expect(latSpan).toBeGreaterThan(0.05)
    expect(latSpan).toBeLessThan(0.06)
  })

  test('longitude span is wider than latitude span at Berlin latitude', () => {
    const bbox = bboxFromCenter(52.52, 13.405, 3)
    const latSpan = bbox.north - bbox.south
    const lngSpan = bbox.east - bbox.west
    // At 52N, longitude degrees are smaller, so more degrees needed for same km
    expect(lngSpan).toBeGreaterThan(latSpan)
  })
})
