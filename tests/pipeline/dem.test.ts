import { afterAll, beforeEach, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PNG } from 'pngjs'

import {
  DEM_TILE_ZOOM,
  bakeWayGradients,
  createTerrariumDem,
  type TerrariumDem,
} from '../../scripts/pipeline/lib/dem'
import type { PipelineWay } from '../../scripts/pipeline/lib/tiles'
import { _resetElevationCache, lngLatToTile } from '../../src/services/elevation'

const TILE_SIZE = 256

// The provider seeds the PRODUCTION elevation module — reset its state
// (cache, source switch) around every test so provider instances and other
// test files never see each other's tiles.
beforeEach(() => _resetElevationCache())
afterAll(() => _resetElevationCache())

function mkCacheDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dem-test-${label}-`))
}

/** Terrarium-encode a per-pixel elevation function into a PNG buffer. */
function terrariumPng(elevationAt: (px: number, py: number) => number): Buffer {
  const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE })
  for (let py = 0; py < TILE_SIZE; py++) {
    for (let px = 0; px < TILE_SIZE; px++) {
      const v = elevationAt(px, py) + 32768
      const whole = Math.floor(v)
      const i = (py * TILE_SIZE + px) * 4
      png.data[i + 0] = Math.floor(whole / 256)
      png.data[i + 1] = whole % 256
      png.data[i + 2] = Math.round((v - whole) * 256)
      png.data[i + 3] = 255
    }
  }
  return PNG.sync.write(png)
}

interface FetchStub {
  fetchImpl: typeof fetch
  requests: string[]
}

/**
 * fetch stub serving terrarium tiles. `tileFor` returns a PNG buffer for a
 * z/x/y (or null → 404). Optional `delayMs` + concurrency tracking.
 */
function stubFetch(
  tileFor: (z: number, x: number, y: number) => Buffer | null,
  opts: { delayMs?: number; onConcurrency?: (inFlight: number) => void } = {},
): FetchStub {
  const requests: string[] = []
  let inFlight = 0
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input)
    requests.push(url)
    inFlight++
    opts.onConcurrency?.(inFlight)
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
    inFlight--
    const m = url.match(/terrarium\/(\d+)\/(-?\d+)\/(-?\d+)\.png$/)
    const body = m ? tileFor(Number(m[1]), Number(m[2]), Number(m[3])) : null
    if (!body) return new Response('not found', { status: 404 })
    return new Response(new Uint8Array(body), { status: 200 })
  }) as typeof fetch
  return { fetchImpl, requests }
}

function pway(osmId: number, coordinates: [number, number][]): PipelineWay {
  return { osmId, tags: { highway: 'residential' }, coordinates, isControlNode: false }
}

// Test geography: SF-ish, well inside one z=12 tile.
const LAT_A = 37.755
const LAT_B = 37.7595 // ~500 m north
const LNG = -122.44

test('sloped DEM: gradient matches the production formula over production lookups', async () => {
  // Row-linear elevation (1 m per pixel row): a north-south way has a real
  // grade. Same PNG for every requested tile.
  const png = terrariumPng((_px, py) => py)
  const { fetchImpl } = stubFetch(() => png)
  const dem = createTerrariumDem({ cacheDir: mkCacheDir('slope'), fetchImpl })

  const coords: [number, number][] = [[LAT_A, LNG], [LAT_B, LNG]]
  const result = await bakeWayGradients([pway(1, coords)], dem)
  const g = result.get(1)
  expect(g).not.toBeNull()

  // Recompute the expectation from first principles: gross gradient =
  // (climb − 2 m noise cutoff) / horizontal length. Elevations come from
  // the PRODUCTION lookup the bake used (lookupElevation via dem.lookup).
  const eA = dem.lookup(LAT_A, LNG)!
  const eB = dem.lookup(LAT_B, LNG)!
  expect(eA).not.toBe(eB)
  const lengthM = (LAT_B - LAT_A) * (Math.PI / 180) * 6371000
  const expected = ((Math.abs(eB - eA) - 2) / lengthM) * 100
  expect(g!).toBeCloseTo(expected, 6)
  expect(g!).toBeGreaterThan(1)
})

test('flat DEM: long way grades exactly 0; sub-noise-floor way is null', async () => {
  const png = terrariumPng(() => 100)
  const { fetchImpl } = stubFetch(() => png)
  const dem = createTerrariumDem({ cacheDir: mkCacheDir('flat'), fetchImpl })

  const long = pway(1, [[LAT_A, LNG], [LAT_B, LNG]])
  const short = pway(2, [[LAT_A, LNG], [LAT_A + 0.0001, LNG]]) // ~11 m < 40 m floor
  const result = await bakeWayGradients([long, short], dem)
  expect(result.get(1)).toBe(0)
  expect(result.get(2)).toBeNull() // production noise-floor semantics, not a DEM void
})

test('DEM void (404): null gradient, counted as a failure, no disk cache entry', async () => {
  // Valid DEM everywhere except one tile: the way on the missing tile is
  // the ONLY null among graded-length ways.
  const png = terrariumPng(() => 100)
  const voidTile = lngLatToTile(LNG, LAT_A, DEM_TILE_ZOOM)
  const { fetchImpl } = stubFetch((_z, x, y) => (x === voidTile.x && y === voidTile.y ? null : png))
  const cacheDir = mkCacheDir('void')
  const dem = createTerrariumDem({ cacheDir, fetchImpl })

  // A second way one z=12 tile east (~0.088° of lng) sits on a valid tile.
  const eastLng = LNG + 360 / 2 ** DEM_TILE_ZOOM
  const onVoid = pway(1, [[LAT_A, LNG], [LAT_B, LNG]])
  const onValid = pway(2, [[LAT_A, eastLng], [LAT_B, eastLng]])
  const result = await bakeWayGradients([onVoid, onValid], dem)
  expect(result.get(1)).toBeNull()
  expect(result.get(2)).not.toBeNull()
  expect(dem.stats.failures).toBe(1)
  expect(fs.existsSync(path.join(cacheDir, 'terrarium', String(DEM_TILE_ZOOM), String(voidTile.x)))).toBe(false)
})

test('on-disk cache: a fresh provider resolves tiles with zero HTTP fetches', async () => {
  const png = terrariumPng(() => 42)
  const cacheDir = mkCacheDir('disk')
  const first = stubFetch(() => png)
  const dem1 = createTerrariumDem({ cacheDir, fetchImpl: first.fetchImpl })
  await dem1.ensureCoords([[LAT_A, LNG]])
  expect(dem1.stats.httpFetches).toBe(1)
  expect(dem1.lookup(LAT_A, LNG)).toBe(42)

  // New process simulation: wipe the in-memory elevation cache, then serve
  // the same coord from a provider whose network is dead.
  _resetElevationCache()
  const deadFetch = (async () => {
    throw new Error('network disabled')
  }) as unknown as typeof fetch
  const dem2 = createTerrariumDem({ cacheDir, fetchImpl: deadFetch })
  await dem2.ensureCoords([[LAT_A, LNG]])
  expect(dem2.lookup(LAT_A, LNG)).toBe(42)
  expect(dem2.stats.httpFetches).toBe(0)
  expect(dem2.stats.diskHits).toBe(1)
})

test('bounded fetch concurrency: never more than `concurrency` requests in flight', async () => {
  const png = terrariumPng(() => 0)
  let maxInFlight = 0
  const { fetchImpl, requests } = stubFetch(() => png, {
    delayMs: 5,
    onConcurrency: (n) => {
      maxInFlight = Math.max(maxInFlight, n)
    },
  })
  const dem = createTerrariumDem({ cacheDir: mkCacheDir('conc'), fetchImpl, concurrency: 8 })

  // 20 coords in 20 distinct z=12 tiles (one tile is 360/4096° of lng).
  const tileLng = 360 / 2 ** DEM_TILE_ZOOM
  const coords: [number, number][] = Array.from({ length: 20 }, (_, k) => [
    LAT_A,
    LNG + k * tileLng,
  ])
  await dem.ensureCoords(coords)
  expect(requests.length).toBe(20)
  expect(maxInFlight).toBeGreaterThan(1)
  expect(maxInFlight).toBeLessThanOrEqual(8)
})

test('LRU eviction: evicted tiles read null until re-ensured (then reload from disk)', async () => {
  const png = terrariumPng(() => 7)
  const { fetchImpl } = stubFetch(() => png)
  const dem: TerrariumDem = createTerrariumDem({
    cacheDir: mkCacheDir('lru'),
    fetchImpl,
    maxCachedTiles: 2,
  })

  const tileLng = 360 / 2 ** DEM_TILE_ZOOM
  const a: [number, number] = [LAT_A, LNG]
  const b: [number, number] = [LAT_A, LNG + tileLng]
  const c: [number, number] = [LAT_A, LNG + 2 * tileLng]

  await dem.ensureCoords([a, b])
  expect(dem.lookup(a[0], a[1])).toBe(7)
  // Ensuring a third tile over a 2-tile budget evicts the LRU one (a).
  await dem.ensureCoords([c])
  expect(dem.lookup(c[0], c[1])).toBe(7)
  expect(dem.lookup(a[0], a[1])).toBeNull() // evicted — fail-soft, not wrong data
  // Re-ensure brings it back from the on-disk cache, not HTTP.
  await dem.ensureCoords([a])
  expect(dem.lookup(a[0], a[1])).toBe(7)
  expect(dem.stats.diskHits).toBe(1)
  expect(dem.stats.httpFetches).toBe(3)
})
