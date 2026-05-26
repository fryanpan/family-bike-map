import { test, expect, beforeEach } from 'bun:test'
import {
  decodeTerrainRgb,
  lngLatToTile,
  lookupElevation,
  _seedTile,
  _resetElevationCache,
} from '../src/services/elevation'

// Keep in sync with the module's TILE_ZOOM (= 15; Mapbox's max for
// terrain-rgb).
const TILE_ZOOM = 15
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
  // Berlin Mitte (52.52°N, 13.405°E) at z=15. Float precision can shift
  // ±1 at the boundary, so assert a small range.
  const berlin = lngLatToTile(13.405, 52.52, TILE_ZOOM)
  expect(berlin.x).toBeGreaterThanOrEqual(17603)
  expect(berlin.x).toBeLessThanOrEqual(17605)
  expect(berlin.y).toBeGreaterThanOrEqual(10743)
  expect(berlin.y).toBeLessThanOrEqual(10747)

  // SF Mission (37.76°N, -122.42°W) at z=15.
  const sf = lngLatToTile(-122.42, 37.76, TILE_ZOOM)
  expect(sf.x).toBeGreaterThanOrEqual(5239)
  expect(sf.x).toBeLessThanOrEqual(5241)
  expect(sf.y).toBeGreaterThanOrEqual(12660)
  expect(sf.y).toBeLessThanOrEqual(12667)
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
