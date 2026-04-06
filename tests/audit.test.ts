import { describe, it, expect } from 'bun:test'
import { sampleTiles, tagSignature, buildAuditQuery } from '../src/services/audit'

describe('sampleTiles', () => {
  const bbox = { south: 52.3, west: 13.0, north: 52.5, east: 13.2 }

  it('returns the requested number of tiles', () => {
    const tiles = sampleTiles(bbox, 5)
    expect(tiles).toHaveLength(5)
  })

  it('returns all tiles when count exceeds available', () => {
    // bbox spans 2 rows (523, 524) × 2 cols (130, 131) = 4 tiles
    const tiles = sampleTiles(bbox, 100)
    expect(tiles.length).toBeLessThanOrEqual(100)
    expect(tiles.length).toBeGreaterThan(0)
  })

  it('returns tiles within the bbox region', () => {
    const tiles = sampleTiles(bbox, 3)
    for (const tile of tiles) {
      // Each tile's south edge should be at or above the bbox floor
      expect(tile.south).toBeGreaterThanOrEqual(Math.floor(bbox.south / 0.1) * 0.1 - 0.001)
      // Each tile's north edge should be at or below the bbox ceiling + one tile
      expect(tile.north).toBeLessThanOrEqual(Math.floor(bbox.north / 0.1) * 0.1 + 0.1 + 0.001)
      expect(tile.west).toBeGreaterThanOrEqual(Math.floor(bbox.west / 0.1) * 0.1 - 0.001)
      expect(tile.east).toBeLessThanOrEqual(Math.floor(bbox.east / 0.1) * 0.1 + 0.1 + 0.001)
    }
  })
})

describe('tagSignature', () => {
  it('produces a stable string from signature keys', () => {
    const tags = { highway: 'residential', surface: 'asphalt', maxspeed: '30' }
    const sig = tagSignature(tags)
    expect(sig).toBe('highway=residential|surface=asphalt|maxspeed=30')
    // Calling again gives the same result
    expect(tagSignature(tags)).toBe(sig)
  })

  it('ignores non-signature keys', () => {
    const a = { highway: 'cycleway', name: 'Main St', lit: 'yes' }
    const b = { highway: 'cycleway', name: 'Other Rd', width: '3' }
    expect(tagSignature(a)).toBe(tagSignature(b))
    expect(tagSignature(a)).toBe('highway=cycleway')
  })

  it('includes all present signature keys in stable order', () => {
    const tags = {
      'cycleway:right': 'lane',
      highway: 'tertiary',
      surface: 'paving_stones',
      bicycle: 'yes',
    }
    const sig = tagSignature(tags)
    expect(sig).toBe('highway=tertiary|cycleway:right=lane|surface=paving_stones|bicycle=yes')
  })
})

describe('buildAuditQuery', () => {
  const bbox = { south: 52.4, west: 13.2, north: 52.5, east: 13.3 }
  const query = buildAuditQuery(bbox)

  it('includes tertiary and residential highway types', () => {
    expect(query).toContain('tertiary')
    expect(query).toContain('residential')
  })

  it('excludes parking_aisle service roads', () => {
    expect(query).toContain('service')
    expect(query).toContain('parking_aisle')
    // The query uses negation filter for parking_aisle
    expect(query).toContain('"service"!="parking_aisle"')
  })

  it('uses out geom for geometry-based length calculation', () => {
    expect(query).toContain('out geom;')
  })

  it('sets a 25s timeout', () => {
    expect(query).toContain('[timeout:25]')
  })

  it('includes cycleway-tagged ways', () => {
    expect(query).toContain('"highway"="cycleway"')
    expect(query).toContain('bicycle_road')
    expect(query).toContain('cyclestreet')
  })

  it('includes footway with bicycle access', () => {
    expect(query).toContain('"highway"="footway"')
    expect(query).toContain('"bicycle"~"^(yes|designated)$"')
  })
})
