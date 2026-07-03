import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PNG } from 'pngjs'
import { enrichRegion } from '../../scripts/pipeline/enrich-region'
import {
  bucketIntoTiles,
  serializeEnrichedTile,
  type EnrichedTile,
  type PipelineWay,
} from '../../scripts/pipeline/lib/tiles'
import { wayLengthM } from '../../scripts/pipeline/lib/graph'
import { _resetElevationCache } from '../../src/services/elevation'

const FIXTURE_OSM = path.join(import.meta.dir, '../fixtures/enrich-fixture.osm')
const FIXTURE_PBF = path.join(import.meta.dir, '../fixtures/enrich-fixture.osm.pbf')

// Fixed provenance inputs → byte-reproducible output (the fixture PBF has no
// replication header, so builtAt must be pinned).
const BUILT_AT = '2026-07-03T00:00:00Z'
const SEQ = 42

// Fixture geography: everything lives in 0.1° tile row=377,col=-1225 except
// way 207, which crosses lat 37.8 into row=378 (see the fixture header).
const MAIN_TILE = '377_-1225.json'
const NORTH_TILE = '378_-1225.json'

const INCLUDED_WAY_IDS = [201, 202, 203, 204, 205, 206, 207, 211, 212, 213, 215, 216, 217]
const EXCLUDED_WAY_IDS = [208, 209, 210, 214]
const CONTROL_NODE_IDS = [301, 302]

function mkOutDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `enrich-test-${label}-`))
}

function readTile(dir: string, name: string): EnrichedTile {
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as EnrichedTile
}

beforeAll(() => {
  // The .osm XML is the checked-in source of truth; regenerate the PBF if a
  // clean checkout is missing it (or the XML is newer).
  const needsBuild =
    !fs.existsSync(FIXTURE_PBF) ||
    fs.statSync(FIXTURE_OSM).mtimeMs > fs.statSync(FIXTURE_PBF).mtimeMs
  if (needsBuild) {
    const r = spawnSync('osmium', ['cat', FIXTURE_OSM, '-o', FIXTURE_PBF, '-O'], { encoding: 'utf8' })
    if (r.error || r.status !== 0) {
      throw new Error(`could not build fixture pbf (is osmium installed? brew install osmium-tool): ${r.stderr ?? r.error}`)
    }
  }
})

describe('enrichRegion on the fixture extract', () => {
  let outDir: string

  beforeAll(async () => {
    outDir = mkOutDir('main')
    await enrichRegion({ pbf: FIXTURE_PBF, out: outDir, builtAt: BUILT_AT, seq: SEQ })
  })

  test('emits exactly the two expected tiles', () => {
    expect(fs.readdirSync(outDir).sort()).toEqual([MAIN_TILE, NORTH_TILE])
  })

  test('main tile contains exactly the buildQuery-matched ways', () => {
    const tile = readTile(outDir, MAIN_TILE)
    const realWays = tile.ways.filter((w) => w.coordinates.length > 1)
    expect(realWays.map((w) => w.osmId)).toEqual(INCLUDED_WAY_IDS)
    for (const id of EXCLUDED_WAY_IDS) {
      expect(tile.ways.some((w) => w.osmId === id)).toBe(false)
    }
  })

  test('control nodes ride along as single-coordinate pseudo-ways, after real ways', () => {
    const tile = readTile(outDir, MAIN_TILE)
    const tail = tile.ways.slice(-CONTROL_NODE_IDS.length)
    expect(tail.map((w) => w.osmId)).toEqual(CONTROL_NODE_IDS)
    for (const w of tail) {
      expect(w.coordinates).toHaveLength(1)
      expect(['traffic_signals', 'stop']).toContain(w.tags.highway)
    }
    // The highway=crossing node (303) is not a control node.
    expect(tile.ways.some((w) => w.osmId === 303)).toBe(false)
  })

  test('tile-boundary-crossing way appears in both tiles with full geometry', () => {
    const main = readTile(outDir, MAIN_TILE)
    const north = readTile(outDir, NORTH_TILE)
    const inMain = main.ways.find((w) => w.osmId === 207)
    const inNorth = north.ways.find((w) => w.osmId === 207)
    expect(inMain).toBeDefined()
    expect(inNorth).toBeDefined()
    // Full (unclipped) geometry in both — Overpass `out geom` parity.
    expect(inMain!.coordinates).toEqual([[37.799, -122.451], [37.801, -122.451]])
    expect(inNorth!.coordinates).toEqual(inMain!.coordinates)
    // The north tile contains ONLY this way (no control nodes up there).
    expect(north.ways.map((w) => w.osmId)).toEqual([207])
  })

  test('schema: meta populated; without a DEM only gradientPct stays null', () => {
    for (const name of [MAIN_TILE, NORTH_TILE]) {
      const tile = readTile(outDir, name)
      expect(tile.meta).toEqual({
        builtFromSeq: SEQ,
        builtAt: BUILT_AT,
        pipelineVersion: '1',
        demSource: null, // no opts.dem → no gradient bake
      })
      for (const w of tile.ways) {
        expect(w.itemName).toBeNull()
        expect(w.gradientPct).toBeNull() // DEM pass skipped
        expect(typeof w.osmId).toBe('number')
        expect(w.coordinates.length).toBeGreaterThan(0)
      }
    }
  })

  test('accessGradientPct: 0 on the mainland seed component, null on disconnected islands', () => {
    const tile = readTile(outDir, MAIN_TILE)
    const accessOf = (id: number) => tile.ways.find((w) => w.osmId === id)!.accessGradientPct
    // The Alpha/Beta/Gamma grid (201+202+203, ~463 m) is the largest
    // connected component → mainland seed → access 0.
    expect(accessOf(201)).toBe(0)
    expect(accessOf(202)).toBe(0)
    expect(accessOf(203)).toBe(0)
    // Every other fixture way shares no node with the grid: topologically
    // disconnected → null (fail-soft unknown, not a moat verdict).
    for (const id of [204, 205, 206, 207, 211, 212, 213, 215, 216, 217]) {
      expect(accessOf(id)).toBeNull()
    }
  })

  test('componentPaintedLenM: connected grid shares one total; isolated ways carry their own length', () => {
    const tile = readTile(outDir, MAIN_TILE)
    const byId = new Map(tile.ways.map((w) => [w.osmId, w]))
    const round1 = (v: number) => Math.round(v * 10) / 10
    const lenOf = (id: number) =>
      round1(wayLengthM(byId.get(id)!.coordinates as [number, number][]))
    const gridTotal = round1(
      [201, 202, 203].reduce(
        (sum, id) => sum + wayLengthM(byId.get(id)!.coordinates as [number, number][]),
        0,
      ),
    )
    for (const id of [201, 202, 203]) {
      expect(byId.get(id)!.componentPaintedLenM).toBeCloseTo(gridTotal, 1)
    }
    // Isolated painted candidates (every other included way is one — the
    // fixture graph is deliberately mostly disconnected): own length only.
    for (const id of [204, 205, 206, 207, 211, 212, 213, 215, 216, 217]) {
      expect(byId.get(id)!.componentPaintedLenM).toBeCloseTo(lenOf(id), 1)
    }
    // The ~14 m Isolated Stub is exactly the fragment class the field
    // exists to suppress at overview zooms.
    expect(byId.get(206)!.componentPaintedLenM!).toBeLessThan(20)
  })

  test('control-node pseudo-ways never carry enrichment values', () => {
    const tile = readTile(outDir, MAIN_TILE)
    for (const w of tile.ways.filter((x) => x.coordinates.length === 1)) {
      expect(w.gradientPct).toBeNull()
      expect(w.accessGradientPct).toBeNull()
      expect(w.componentPaintedLenM).toBeNull()
    }
  })

  test('coordinates are [lat, lng] (parseOverpassResponse convention)', () => {
    const tile = readTile(outDir, MAIN_TILE)
    const alpha = tile.ways.find((w) => w.osmId === 201)!
    expect(alpha.coordinates).toEqual([
      [37.762, -122.452],
      [37.762, -122.451],
      [37.762, -122.45],
    ])
    expect(alpha.tags).toEqual({ highway: 'residential', name: 'Alpha Street' })
  })

  test('tile JSON round-trips byte-identically through serializeEnrichedTile', () => {
    for (const name of [MAIN_TILE, NORTH_TILE]) {
      const raw = fs.readFileSync(path.join(outDir, name), 'utf8')
      expect(serializeEnrichedTile(JSON.parse(raw) as EnrichedTile)).toBe(raw)
    }
  })

  test('deterministic: a second run is byte-identical', async () => {
    const outDir2 = mkOutDir('second')
    await enrichRegion({ pbf: FIXTURE_PBF, out: outDir2, builtAt: BUILT_AT, seq: SEQ })
    const names = fs.readdirSync(outDir).sort()
    expect(fs.readdirSync(outDir2).sort()).toEqual(names)
    for (const name of names) {
      const a = fs.readFileSync(path.join(outDir, name))
      const b = fs.readFileSync(path.join(outDir2, name))
      expect(a.equals(b)).toBe(true)
    }
  })

  test('--bbox clips to the requested area', async () => {
    const outDir3 = mkOutDir('bbox')
    // Only the northern tile's box: way 207 straddles it, nothing else does.
    await enrichRegion({
      pbf: FIXTURE_PBF,
      out: outDir3,
      bbox: { south: 37.8, west: -122.5, north: 37.9, east: -122.4 },
      builtAt: BUILT_AT,
      seq: SEQ,
    })
    const names = fs.readdirSync(outDir3).sort()
    // complete_ways keeps way 207's full geometry, so its southern vertex
    // still buckets it into the main tile as well — Overpass parity.
    expect(names).toEqual([MAIN_TILE, NORTH_TILE])
    for (const name of names) {
      expect(readTile(outDir3, name).ways.map((w) => w.osmId)).toEqual([207])
    }
  })
})

describe('enrichRegion with the DEM pass', () => {
  // The bake seeds the production elevation module; don't leak terrarium
  // state into other test files.
  afterAll(() => _resetElevationCache())

  const TILE_SIZE = 256

  function terrariumPng(metres: number): Buffer {
    const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE })
    const v = metres + 32768
    for (let i = 0; i < TILE_SIZE * TILE_SIZE * 4; i += 4) {
      png.data[i + 0] = Math.floor(v / 256)
      png.data[i + 1] = v % 256
      png.data[i + 2] = 0
      png.data[i + 3] = 255
    }
    return PNG.sync.write(png)
  }

  function servePng(body: Buffer | null): typeof fetch {
    return (async () =>
      body
        ? new Response(new Uint8Array(body), { status: 200 })
        : new Response('not found', { status: 404 })) as unknown as typeof fetch
  }

  test('bakes gradients: 0 on flat DEM for graded-length ways, null below the noise floor; demSource stamped', async () => {
    _resetElevationCache()
    const outDir = mkOutDir('dem')
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-dem-cache-'))
    await enrichRegion({
      pbf: FIXTURE_PBF,
      out: outDir,
      builtAt: BUILT_AT,
      seq: SEQ,
      dem: { cacheDir, fetchImpl: servePng(terrariumPng(100)) },
    })
    const tile = readTile(outDir, MAIN_TILE)
    expect(tile.meta.demSource).toBe('terrarium-v1')
    const byId = new Map(tile.ways.map((w) => [w.osmId, w]))
    // Flat DEM → exactly 0 for every way longer than the 40 m noise floor…
    for (const id of [201, 202, 203, 204, 207]) {
      expect(byId.get(id)!.gradientPct).toBe(0)
    }
    // …and null for the ~14 m Isolated Stub (below the floor — production
    // overlayGradientPct semantics, not a DEM void).
    expect(byId.get(206)!.gradientPct).toBeNull()
    // Access/component passes ran too (unchanged by a flat DEM).
    expect(byId.get(201)!.accessGradientPct).toBe(0)
    expect(byId.get(204)!.accessGradientPct).toBeNull()
  })

  test('DEM voids (404 everywhere): gradientPct null for all ways, fail-soft', async () => {
    _resetElevationCache()
    const outDir = mkOutDir('dem-void')
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-dem-void-'))
    await enrichRegion({
      pbf: FIXTURE_PBF,
      out: outDir,
      builtAt: BUILT_AT,
      seq: SEQ,
      dem: { cacheDir, fetchImpl: servePng(null) },
    })
    const tile = readTile(outDir, MAIN_TILE)
    expect(tile.meta.demSource).toBe('terrarium-v1')
    for (const w of tile.ways) expect(w.gradientPct).toBeNull()
    // The graph passes still bake (null gradients are fail-soft passable).
    expect(tile.ways.find((w) => w.osmId === 201)!.accessGradientPct).toBe(0)
    expect(tile.ways.find((w) => w.osmId === 201)!.componentPaintedLenM).not.toBeNull()
  })

  test('deterministic with a DEM: a second run (served from the disk cache) is byte-identical', async () => {
    _resetElevationCache()
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-dem-det-'))
    const outA = mkOutDir('dem-a')
    await enrichRegion({
      pbf: FIXTURE_PBF,
      out: outA,
      builtAt: BUILT_AT,
      seq: SEQ,
      dem: { cacheDir, fetchImpl: servePng(terrariumPng(100)) },
    })
    // Second run: network dead — every tile must come from the disk cache.
    _resetElevationCache()
    const outB = mkOutDir('dem-b')
    const deadFetch = (async () => {
      throw new Error('network disabled')
    }) as unknown as typeof fetch
    await enrichRegion({
      pbf: FIXTURE_PBF,
      out: outB,
      builtAt: BUILT_AT,
      seq: SEQ,
      dem: { cacheDir, fetchImpl: deadFetch },
    })
    const names = fs.readdirSync(outA).sort()
    expect(fs.readdirSync(outB).sort()).toEqual(names)
    for (const name of names) {
      expect(
        fs.readFileSync(path.join(outA, name)).equals(fs.readFileSync(path.join(outB, name))),
      ).toBe(true)
    }
  })
})

describe('bucketIntoTiles (unit)', () => {
  const way = (osmId: number, coordinates: [number, number][], isControlNode = false): PipelineWay => ({
    osmId,
    tags: {},
    coordinates,
    isControlNode,
  })

  test('a way is bucketed once per tile it has a vertex in', () => {
    const w = way(1, [[37.799, -122.451], [37.801, -122.451], [37.802, -122.451]])
    const buckets = bucketIntoTiles([w])
    expect([...buckets.keys()].sort()).toEqual(['377:-1225', '378:-1225'])
    expect(buckets.get('378:-1225')!.ways).toHaveLength(1)
  })

  test('ways and control nodes are separated and sorted by osmId', () => {
    const buckets = bucketIntoTiles([
      way(5, [[37.75, -122.45], [37.751, -122.45]]),
      way(2, [[37.75, -122.45]], true),
      way(3, [[37.752, -122.45], [37.753, -122.45]]),
      way(1, [[37.751, -122.45]], true),
    ])
    const b = buckets.get('377:-1225')!
    expect(b.ways.map((w) => w.osmId)).toEqual([3, 5])
    expect(b.controlNodes.map((w) => w.osmId)).toEqual([1, 2])
  })
})
