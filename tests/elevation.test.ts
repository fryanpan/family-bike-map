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

// --- Pluggable DEM source (terrarium) ---------------------------------

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import {
  decodeTerrarium,
  setElevationSource,
  getElevationSource,
  setElevationDecoder,
  setElevationReferer,
} from '../src/services/elevation'

test('decodeTerrarium — known encodings resolve per the tilezen spec', () => {
  // height = (R * 256 + G + B / 256) - 32768
  expect(decodeTerrarium(128, 0, 0)).toBe(0) // sea level
  expect(decodeTerrarium(162, 144, 0)).toBe(8848) // Everest
  expect(decodeTerrarium(127, 224, 0)).toBe(-32) // below sea level
  expect(decodeTerrarium(128, 100, 64)).toBe(100.25) // fractional metres in B
})

test('decodeTerrarium and decodeTerrainRgb are different formulas (no accidental aliasing)', () => {
  // The same bytes MUST decode differently: (1,134,160) is 0 m in
  // Mapbox terrain-RGB but 1*256+134+160/256-32768 = -32377.375 m
  // in terrarium.
  expect(decodeTerrainRgb(1, 134, 160)).toBeCloseTo(0, 1)
  expect(decodeTerrarium(1, 134, 160)).toBeCloseTo(-32377.375, 3)
})

test('decodeTerrarium — checked-in PNG fixture with known elevations', () => {
  // tests/fixtures/terrarium-known.png: 4×1 terrarium-encoded pixels
  // written by an offline pngjs script (see fixture provenance in the
  // PR). Proves the formula against real PNG-roundtripped bytes, not
  // just hand-computed tuples.
  const buf = readFileSync(join(import.meta.dir, 'fixtures', 'terrarium-known.png'))
  const png = PNG.sync.read(buf)
  expect(png.width).toBe(4)
  expect(png.height).toBe(1)
  const expected = [0, 8848, -32, 100.25]
  for (let i = 0; i < expected.length; i++) {
    const r = png.data[i * 4]
    const g = png.data[i * 4 + 1]
    const b = png.data[i * 4 + 2]
    expect(decodeTerrarium(r, g, b)).toBeCloseTo(expected[i], 6)
  }
})

test('elevation source — default is mapbox-terrain-rgb and reset restores it', () => {
  expect(getElevationSource()).toBe('mapbox-terrain-rgb')
  setElevationSource('terrarium')
  expect(getElevationSource()).toBe('terrarium')
  _resetElevationCache()
  expect(getElevationSource()).toBe('mapbox-terrain-rgb')
})

// Terrarium-encoded uniform 256×256 RGBA pixel array.
function uniformTerrariumTile(metres: number): Uint8ClampedArray {
  const v = metres + 32768
  const whole = Math.floor(v)
  const r = Math.floor(whole / 256)
  const g = whole % 256
  const b = Math.round((v - whole) * 256)
  const data = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4)
  for (let i = 0; i < data.length; i += 4) {
    data[i + 0] = r
    data[i + 1] = g
    data[i + 2] = b
    data[i + 3] = 255
  }
  return data
}

test('lookupElevation — decodes with the ACTIVE source formula (terrarium)', () => {
  setElevationSource('terrarium')
  seedAt(37.76, -122.42, TILE_ZOOM, uniformTerrariumTile(123.5))
  expect(lookupElevation(37.76, -122.42)).toBeCloseTo(123.5, 3)
})

test('elevation source — caches are keyed per source (no cross-decode on switch)', () => {
  // Seed under the DEFAULT (mapbox) source…
  seedAt(37.76, -122.42, TILE_ZOOM, uniformTile(100))
  expect(lookupElevation(37.76, -122.42)).toBeCloseTo(100, 0)
  // …switch to terrarium: the mapbox tile must be INVISIBLE (null,
  // fail-soft), never decoded with the terrarium formula.
  setElevationSource('terrarium')
  expect(lookupElevation(37.76, -122.42)).toBeNull()
  // Switching back restores the original data untouched.
  setElevationSource('mapbox-terrain-rgb')
  expect(lookupElevation(37.76, -122.42)).toBeCloseTo(100, 0)
})

test('router default unchanged — lookupElevation reads mapbox data unless switched', () => {
  // No setElevationSource call in this test: the module default must
  // serve mapbox-encoded tiles (chunk C2 flips the default behind the
  // benchmark gate — not here).
  seedAt(52.52, 13.405, TILE_ZOOM, uniformTile(34))
  expect(lookupElevation(52.52, 13.405)).toBeCloseTo(34, 0)
})

// In-memory 256×256 PNG (terrarium- or mapbox-encoded uniform value).
function pngTileBuffer(pixels: Uint8ClampedArray): Buffer {
  const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE })
  png.data = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.length)
  return PNG.sync.write(png)
}

function registerPngjsDecoder(): void {
  setElevationDecoder((bytes) => {
    const png = PNG.sync.read(Buffer.from(bytes))
    return new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length)
  })
}

interface CapturedRequest {
  url: string
  referer: string | null
}

function mockFetch(body: Buffer, captured: CapturedRequest[]): () => void {
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    captured.push({ url: String(input), referer: headers.get('Referer') })
    return new Response(new Uint8Array(body), { status: 200 })
  }) as typeof fetch
  return () => {
    globalThis.fetch = orig
  }
}

test('terrarium fetch — S3 URL, no token, no Referer; full prefetch→lookup path', async () => {
  const captured: CapturedRequest[] = []
  const restore = mockFetch(pngTileBuffer(uniformTerrariumTile(250.5)), captured)
  // Bun auto-loads .env, so a real token may be ambient — remove it for
  // this test to prove terrarium needs NO token to fetch.
  const savedToken = process.env.VITE_MAPBOX_TOKEN
  delete process.env.VITE_MAPBOX_TOKEN
  try {
    setElevationSource('terrarium')
    registerPngjsDecoder()
    // A registered Referer must NOT leak onto terrarium requests — it
    // exists solely for the URL-restricted Mapbox token.
    setElevationReferer('https://bike-map.fryanpan.com/')

    await prefetchElevation({ south: 37.75, west: -122.43, north: 37.76, east: -122.42 })

    expect(captured.length).toBeGreaterThan(0)
    for (const req of captured) {
      expect(req.url).toMatch(
        /^https:\/\/s3\.amazonaws\.com\/elevation-tiles-prod\/terrarium\/12\/\d+\/\d+\.png$/,
      )
      expect(req.url).not.toContain('access_token')
      expect(req.referer).toBeNull()
    }
    expect(lookupElevation(37.755, -122.425)).toBeCloseTo(250.5, 3)
  } finally {
    if (savedToken !== undefined) process.env.VITE_MAPBOX_TOKEN = savedToken
    restore()
  }
})

test('mapbox fetch path untouched — pngraw URL with access_token and Referer', async () => {
  const captured: CapturedRequest[] = []
  const restore = mockFetch(pngTileBuffer(uniformTile(75)), captured)
  const savedToken = process.env.VITE_MAPBOX_TOKEN
  process.env.VITE_MAPBOX_TOKEN = 'pk.test-token'
  try {
    // Default source — no setElevationSource call.
    registerPngjsDecoder()
    setElevationReferer('https://bike-map.fryanpan.com/')

    await prefetchElevation({ south: 37.75, west: -122.43, north: 37.76, east: -122.42 })

    expect(captured.length).toBeGreaterThan(0)
    for (const req of captured) {
      expect(req.url).toMatch(
        /^https:\/\/api\.mapbox\.com\/v4\/mapbox\.terrain-rgb\/12\/\d+\/\d+\.pngraw\?access_token=pk\.test-token$/,
      )
      expect(req.referer).toBe('https://bike-map.fryanpan.com/')
    }
    expect(lookupElevation(37.755, -122.425)).toBeCloseTo(75, 0)
  } finally {
    if (savedToken !== undefined) process.env.VITE_MAPBOX_TOKEN = savedToken
    else delete process.env.VITE_MAPBOX_TOKEN
    restore()
  }
})

// --- computeWayGradientPct (shared pipeline/overlay formula) -----------

import { computeWayGradientPct } from '../src/services/elevation'

test('computeWayGradientPct — pure helper matches overlayGradientPct on the same inputs', () => {
  // ~111 m run, linear 20 m climb (same setup as the overlayGradientPct
  // steep-way test). With nothing cached, overlayGradientPct uses
  // floorScale 1 — the two MUST agree exactly (same implementation).
  const coords: Array<[number, number]> = [[37.75, -122.43], [37.751, -122.43]]
  const fn = (lat: number) => (lat - 37.75) * 20000
  expect(computeWayGradientPct(coords, fn, 1)).toBe(overlayGradientPct(coords, fn))
  expect(computeWayGradientPct(coords, () => 42, 1)).toBe(0)
  expect(computeWayGradientPct(coords, () => null, 1)).toBeNull()
})

test('computeWayGradientPct — floorScale scales the length floor and noise cutoff', () => {
  // 111 m way: graded at floorScale 1 (40 m floor), ungraded at
  // floorScale 4 (160 m floor).
  const coords: Array<[number, number]> = [[37.75, -122.43], [37.751, -122.43]]
  const fn = (lat: number) => (lat - 37.75) * 20000
  expect(computeWayGradientPct(coords, fn, 1)).not.toBeNull()
  expect(computeWayGradientPct(coords, fn, 4)).toBeNull()
  // ~445 m way with a 5 m climb: above the 2 m fine cutoff, below the
  // 8 m coarse cutoff.
  const longCoords: Array<[number, number]> = [[37.75, -122.43], [37.754, -122.43]]
  const gentle = (lat: number) => (lat - 37.75) * 1250 // 5 m over 0.004°
  expect(computeWayGradientPct(longCoords, gentle, 1)!).toBeGreaterThan(0)
  expect(computeWayGradientPct(longCoords, gentle, 4)).toBe(0)
})
