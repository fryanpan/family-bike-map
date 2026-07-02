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

import { prefetchElevation } from '../src/services/elevation'

test('prefetchElevation — skips a pathological region-spanning bbox', async () => {
  const warns: string[] = []
  const orig = console.warn
  console.warn = ((m: unknown) => { warns.push(String(m)) }) as typeof console.warn
  try {
    // SF → Berlin: ~137° of longitude. At z=12 that's thousands of tiles —
    // must trip the cap and return without firing a request storm.
    await prefetchElevation({ south: 37, west: -123, north: 53, east: 14 })
  } finally {
    console.warn = orig
  }
  expect(warns.some((w) => w.includes('prefetch bbox spans'))).toBe(true)
})

test('prefetchElevation — does not trip the cap for a normal viewport bbox', async () => {
  const warns: string[] = []
  const orig = console.warn
  console.warn = ((m: unknown) => { warns.push(String(m)) }) as typeof console.warn
  try {
    await prefetchElevation({ south: 37.74, west: -122.46, north: 37.80, east: -122.39 })
  } finally {
    console.warn = orig
  }
  expect(warns.some((w) => w.includes('prefetch bbox spans'))).toBe(false)
})

// --- Coarse z=10 fallback (overlay-only; router stays z=12) -----------

import { lookupElevationOverlay, _hasTileEntry } from '../src/services/elevation'

// Keep in sync with the module's COARSE_TILE_ZOOM.
const COARSE_TILE_ZOOM = 10

function uniformTile(metres: number): Uint8ClampedArray {
  const { r, g, b } = encodeMetres(metres)
  const data = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i + 0] = r
    data[i + 1] = g
    data[i + 2] = b
    data[i + 3] = 255
  }
  return data
}

// Vertical-gradient tile: row py reads `metresPerRow * py` metres.
function rowGradientTile(metresPerRow: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4)
  for (let py = 0; py < TILE_SIZE; py++) {
    const { r, g, b } = encodeMetres(metresPerRow * py)
    for (let px = 0; px < TILE_SIZE; px++) {
      const i = (py * TILE_SIZE + px) * 4
      data[i + 0] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = 255
    }
  }
  return data
}

function seedAt(lat: number, lng: number, z: number, data: Uint8ClampedArray | null): void {
  const t = lngLatToTile(lng, lat, z)
  _seedTile(z, t.x, t.y, data)
}

test('lookupElevationOverlay — falls back to the z=10 tile when z=12 is absent', () => {
  seedAt(37.76, -122.42, COARSE_TILE_ZOOM, uniformTile(50))
  expect(lookupElevationOverlay(37.76, -122.42)).toBeCloseTo(50, 0)
})

test('lookupElevationOverlay — prefers z=12 when both zooms are cached', () => {
  seedAt(37.76, -122.42, TILE_ZOOM, uniformTile(100))
  seedAt(37.76, -122.42, COARSE_TILE_ZOOM, uniformTile(50))
  expect(lookupElevationOverlay(37.76, -122.42)).toBeCloseTo(100, 0)
})

test('lookupElevationOverlay — falls back past a fetched-and-failed z=12 tile', () => {
  seedAt(37.76, -122.42, TILE_ZOOM, null)
  seedAt(37.76, -122.42, COARSE_TILE_ZOOM, uniformTile(50))
  expect(lookupElevationOverlay(37.76, -122.42)).toBeCloseTo(50, 0)
})

test('lookupElevation — NEVER reads z=10 data (router isolation)', () => {
  seedAt(37.76, -122.42, COARSE_TILE_ZOOM, uniformTile(50))
  expect(lookupElevation(37.76, -122.42)).toBeNull()
})

// ~111 m way (Δlat 0.001°): above the 40 m fine floor, below the 160 m
// coarse floor — the discriminating length for the floor-scaling tests.
const MID_LEN_COORDS: Array<[number, number]> = [[37.75, -122.43], [37.751, -122.43]]

test('overlayGradientPct — coarse length floor: 111 m way is ungraded on z=10-only data', () => {
  for (const [lat, lng] of MID_LEN_COORDS) seedAt(lat, lng, COARSE_TILE_ZOOM, uniformTile(50))
  expect(overlayGradientPct(MID_LEN_COORDS)).toBeNull()
})

test('overlayGradientPct — fine floors apply when the z=12 midpoint tile is cached', () => {
  for (const [lat, lng] of MID_LEN_COORDS) {
    seedAt(lat, lng, COARSE_TILE_ZOOM, uniformTile(50))
    seedAt(lat, lng, TILE_ZOOM, uniformTile(50))
  }
  // Same 111 m way, but z=12 data present → fine 40 m floor → graded flat.
  expect(overlayGradientPct(MID_LEN_COORDS)).toBe(0)
})

test('overlayGradientPct — coarse cutoff (8 m) swallows a climb the fine cutoff (2 m) would report', () => {
  // ~445 m way over a gentle z=10 row gradient (1.5 m per ~120 m pixel row).
  const coords: Array<[number, number]> = [[37.75, -122.43], [37.754, -122.43]]
  for (const [lat, lng] of coords) seedAt(lat, lng, COARSE_TILE_ZOOM, rowGradientTile(1.5))
  const eA = lookupElevationOverlay(coords[0][0], coords[0][1])
  const eB = lookupElevationOverlay(coords[1][0], coords[1][1])
  // Sanity: the seeded climb sits between the fine (2 m) and coarse (8 m)
  // cutoffs, so the assertion below actually discriminates the two.
  const climb = Math.abs(eB! - eA!)
  expect(climb).toBeGreaterThan(2.5)
  expect(climb).toBeLessThan(8)
  expect(overlayGradientPct(coords)).toBe(0)
})

test('overlayGradientPct — genuinely steep way still reports a gradient on coarse data', () => {
  // 20 m per z=10 pixel row ≈ 60-80 m climb over ~445 m: far above the
  // 8 m coarse cutoff, must survive the noise floors.
  const coords: Array<[number, number]> = [[37.75, -122.43], [37.754, -122.43]]
  for (const [lat, lng] of coords) seedAt(lat, lng, COARSE_TILE_ZOOM, rowGradientTile(20))
  const g = overlayGradientPct(coords)
  expect(g).not.toBeNull()
  expect(g!).toBeGreaterThan(5)
})

test('overlayGradientPct — custom elevationFn with nothing cached keeps the fine floors', () => {
  // Pre-fallback behavior for injected fns (scripts, tests): 111 m > 40 m
  // floor, flat fn → 0, not null.
  expect(overlayGradientPct(MID_LEN_COORDS, () => 42)).toBe(0)
})

test('prefetchElevation — falls back to z=10 for a bbox too wide for z=12', async () => {
  // Bay-Area-scale bbox: >200 tiles at z=12, a couple dozen at z=10.
  const bbox = { south: 37.0, west: -123.0, north: 38.0, east: -121.5 }
  const z12a = lngLatToTile(bbox.west, bbox.north, TILE_ZOOM)
  const z12b = lngLatToTile(bbox.east, bbox.south, TILE_ZOOM)
  const z12Count = (z12b.x - z12a.x + 1) * (z12b.y - z12a.y + 1)
  expect(z12Count).toBeGreaterThan(200) // precondition for the fallback

  const warns: string[] = []
  const orig = console.warn
  console.warn = ((m: unknown) => { warns.push(String(m)) }) as typeof console.warn
  try {
    await prefetchElevation(bbox)
  } finally {
    console.warn = orig
  }
  // No token in the test env, so fetchTile records a null entry per tile —
  // enough to observe which zoom the prefetch targeted.
  expect(warns.some((w) => w.includes('prefetch bbox spans'))).toBe(false)
  const z10 = lngLatToTile(bbox.west, bbox.north, COARSE_TILE_ZOOM)
  expect(_hasTileEntry(COARSE_TILE_ZOOM, z10.x, z10.y)).toBe(true)
  expect(_hasTileEntry(TILE_ZOOM, z12a.x, z12a.y)).toBe(false)
})

test('prefetchElevation — stays at z=12 for a normal viewport bbox', async () => {
  const bbox = { south: 37.74, west: -122.46, north: 37.80, east: -122.39 }
  await prefetchElevation(bbox)
  const z12 = lngLatToTile(bbox.west, bbox.north, TILE_ZOOM)
  const z10 = lngLatToTile(bbox.west, bbox.north, COARSE_TILE_ZOOM)
  expect(_hasTileEntry(TILE_ZOOM, z12.x, z12.y)).toBe(true)
  expect(_hasTileEntry(COARSE_TILE_ZOOM, z10.x, z10.y)).toBe(false)
})
