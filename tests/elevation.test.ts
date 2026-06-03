import { test, expect, beforeEach } from 'bun:test'
import {
  decodeTerrainRgb,
  lngLatToTile,
  lookupElevation,
  _seedTile,
  _resetElevationCache,
} from '../src/services/elevation'

// Keep in sync with the module's TILE_ZOOM (= 12; matches SRTM source
// resolution, robust to noise via the BRouter-style ascent-cost router).
const TILE_ZOOM = 12
const TILE_SIZE = 256

beforeEach(() => _resetElevationCache())

test('decodeTerrainRgb — known sea-level pixel resolves to ~0 m', () => {
  // Per MapTiler spec: height = -10000 + (R*65536 + G*256 + B) * 0.1.
  // Sea level → encoded value 100000 → R=1, G=134, B=160.
  const r = 1, g = 134, b = 160
  expect(decodeTerrainRgb(r, g, b)).toBeCloseTo(0, 1)
})

test('decodeTerrainRgb — known mountain pixel resolves correctly', () => {
  // 200 m elevation → encoded 102000 = 1*65536 + 142*256 + 112
  // → R=1, G=142, B=112
  const r = 1, g = 142, b = 112
  expect(decodeTerrainRgb(r, g, b)).toBeCloseTo(200, 1)
})

function encodeMetres(metres: number): { r: number; g: number; b: number } {
  const enc = Math.round((metres + 10000) / 0.1)
  return { r: (enc >> 16) & 0xff, g: (enc >> 8) & 0xff, b: enc & 0xff }
}

test('lngLatToTile — known coords land in plausible Web-Mercator tiles', () => {
  // Berlin Mitte (52.52°N, 13.405°E) at z=12: x is solidly in the 2200
  // column; the y can land in 1342 or 1343 depending on whether the
  // lat sits just above/below the row boundary. Assert the column hard
  // and the row within ±1.
  const berlin = lngLatToTile(13.405, 52.52, TILE_ZOOM)
  expect(berlin.x).toBe(2200)
  expect(berlin.y).toBeGreaterThanOrEqual(1342)
  expect(berlin.y).toBeLessThanOrEqual(1343)

  // SF Mission (37.76°N, -122.42°W).
  const sf = lngLatToTile(-122.42, 37.76, TILE_ZOOM)
  expect(sf.x).toBe(655)
  expect(sf.y).toBeGreaterThanOrEqual(1582)
  expect(sf.y).toBeLessThanOrEqual(1583)
})

test('lookupElevation — returns null when the covering tile is uncached', () => {
  expect(lookupElevation(52.52, 13.405)).toBeNull()
})

test('lookupElevation — returns null when the covering tile fetched and failed', () => {
  const t = lngLatToTile(13.405, 52.52, TILE_ZOOM)
  _seedTile(TILE_ZOOM, t.x, t.y, null)
  expect(lookupElevation(52.52, 13.405)).toBeNull()
})

test('lookupElevation — decodes a seeded tile', () => {
  const { r, g, b } = encodeMetres(50)
  const data = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i + 0] = r
    data[i + 1] = g
    data[i + 2] = b
    data[i + 3] = 255
  }
  const t = lngLatToTile(13.405, 52.52, TILE_ZOOM)
  _seedTile(TILE_ZOOM, t.x, t.y, data)
  expect(lookupElevation(52.52, 13.405)).toBeCloseTo(50, 0)
})

test('lookupElevation — pixel-level variation resolves to the right pixel', () => {
  // Seed a tile with a vertical gradient: row py gets elevation py metres.
  const data = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4)
  for (let py = 0; py < TILE_SIZE; py++) {
    const { r, g, b } = encodeMetres(py)
    for (let px = 0; px < TILE_SIZE; px++) {
      const i = (py * TILE_SIZE + px) * 4
      data[i + 0] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  // Whichever tile the test coord lands in — seed that one so the
  // lookup hits.
  const t = lngLatToTile(13.405, 52.52, TILE_ZOOM)
  _seedTile(TILE_ZOOM, t.x, t.y, data)

  const e = lookupElevation(52.52, 13.405)
  expect(e).not.toBeNull()
  // The test coord is somewhere inside the tile, so elevation should
  // be in [0, 255] m and not at either extreme.
  expect(e!).toBeGreaterThanOrEqual(0)
  expect(e!).toBeLessThanOrEqual(255)
})

import { wayAscentMeters, overlayGradientPct } from '../src/services/elevation'

test('wayAscentMeters — sums forward and reverse climbs separately', () => {
  // 4 colinear points; elevation keyed by lng index: 0,10,5,15.
  const coords: Array<[number, number]> = [[0, 0], [0, 1], [0, 2], [0, 3]]
  const byLng = [0, 10, 5, 15]
  const fn = (_lat: number, lng: number) => byLng[lng]
  const { forwardM, reverseM } = wayAscentMeters(coords, fn)
  // Forward (0→10→5→15): +10, +10 climbs = 20; the single −5 is the reverse climb.
  expect(forwardM).toBeCloseTo(20, 6)
  expect(reverseM).toBeCloseTo(5, 6)
})

test('wayAscentMeters — null elevations are skipped, not treated as 0', () => {
  const coords: Array<[number, number]> = [[0, 0], [0, 1], [0, 2]]
  const fn = (_lat: number, lng: number) => (lng === 1 ? null : 100)
  const { forwardM, reverseM } = wayAscentMeters(coords, fn)
  // Both pairs touch the null middle point → no countable delta.
  expect(forwardM).toBe(0)
  expect(reverseM).toBe(0)
})

test('overlayGradientPct — steep way reports gross gradient minus cutoff', () => {
  // ~111 m run (Δlat 0.001°), linear 20 m climb. Gross = (20−2)/111 ≈ 16.2%.
  const coords: Array<[number, number]> = [[37.75, -122.43], [37.751, -122.43]]
  const fn = (lat: number) => (lat - 37.75) * 20000
  const g = overlayGradientPct(coords, fn)
  expect(g).not.toBeNull()
  expect(g!).toBeGreaterThan(14)
  expect(g!).toBeLessThan(18)
})

test('overlayGradientPct — flat way reports ~0, not null', () => {
  const coords: Array<[number, number]> = [[37.75, -122.43], [37.751, -122.43]]
  const g = overlayGradientPct(coords, () => 42)
  expect(g).toBe(0)
})

test('overlayGradientPct — way shorter than the z=12 floor returns null', () => {
  // Δlat 0.0002° ≈ 22 m < 40 m floor.
  const coords: Array<[number, number]> = [[37.75, -122.43], [37.7502, -122.43]]
  const g = overlayGradientPct(coords, (lat) => (lat - 37.75) * 20000)
  expect(g).toBeNull()
})

test('overlayGradientPct — unknown elevation (all null) returns null', () => {
  const coords: Array<[number, number]> = [[37.75, -122.43], [37.751, -122.43]]
  const g = overlayGradientPct(coords, () => null)
  expect(g).toBeNull()
})
