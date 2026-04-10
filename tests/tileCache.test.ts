import { describe, test, expect } from 'bun:test'
import { detectRegion } from '../src/services/tileCache'

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
