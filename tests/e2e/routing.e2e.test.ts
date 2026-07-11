/**
 * Scripted end-to-end tests — enriched-tiles plan, "End-to-end happy
 * paths" items 3–5 (headless halves; the browser falsification pass is a
 * separate manual protocol):
 *
 *   3. Route A→B per mode via the production clientRoute over REAL
 *      pipeline output: tiles baked from tests/fixtures/enrich-fixture.osm
 *      by enrichRegion (not hand-written tile JSONs).
 *   4. The same routes via the route server — spawned as the actual CLI
 *      process (`bun server/route-server.ts`), spoken to over HTTP —
 *      with the identical-geometry (tolerance ZERO) assertion.
 *   5. Berlin-style fallback: tiles WITHOUT enriched fields (bare
 *      OsmWay[], the shape the Overpass fallback path produces) route
 *      identically — baked fields are routing-inert by construction.
 *      Plus the routeLegViaBackend seam: client default, server engine
 *      tag, graceful fallback to client on a dead server URL.
 *
 * Also asserts the route-timing instrumentation (routeTiming.ts) records
 * phase breakdowns at the clientRoute seam and round-trips at the
 * routeLegViaBackend seam — the data the phone benchmark reads.
 *
 * Fixture geography (see enrich-fixture.osm header): the routable
 * component is the residential grid Alpha(101-102-103) + Beta(104-105-106)
 * joined by Gamma(102-105), inside tile 377:-1225. START/END below snap
 * to nodes 101 and 106; the only path runs 101→102→105→106.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { enrichRegion } from '../../scripts/pipeline/enrich-region'
import { loadTilesIntoCache } from '../../server/route-server'
import { clientRoute } from '../../src/services/clientRouter'
import { routeLegViaBackend, serverRoute } from '../../src/services/routeBackend'
import { getDefaultPreferredItems } from '../../src/utils/classify'
import { MODE_RULES } from '../../src/data/modes'
import { clearRouteTimings, getRouteTimings } from '../../src/services/routeTiming'
import type { EnrichedTile } from '../../scripts/pipeline/lib/tiles'
import type { Route } from '../../src/utils/types'

const REPO_ROOT = path.join(import.meta.dir, '../..')
const FIXTURE_OSM = path.join(import.meta.dir, '../fixtures/enrich-fixture.osm')
const FIXTURE_PBF = path.join(import.meta.dir, '../fixtures/enrich-fixture.osm.pbf')

const BASE_SEQ = 42
const BUILT_AT = '2026-07-03T00:00:00Z'

const START = { lat: 37.762, lng: -122.452 } // node 101 — Alpha Street west end
const END = { lat: 37.763, lng: -122.45 }    // node 106 — Beta Street east end
const MODES = Object.keys(MODE_RULES)

let scratch: string
let enrichedDir: string
let bareDir: string
let serverProc: ReturnType<typeof Bun.spawn> | null = null
let serverBase = ''

/** Per-mode reference routes over ENRICHED tiles — the comparison anchor
 *  for the server (item 4) and bare-tile (item 5) runs. */
const referenceRoutes = new Map<string, Route>()

function ensureFixturePbf(): void {
  const needsBuild =
    !fs.existsSync(FIXTURE_PBF) ||
    fs.statSync(FIXTURE_OSM).mtimeMs > fs.statSync(FIXTURE_PBF).mtimeMs
  if (needsBuild) {
    const r = spawnSync('osmium', ['cat', FIXTURE_OSM, '-o', FIXTURE_PBF, '-O'], { encoding: 'utf8' })
    if (r.error || r.status !== 0) {
      throw new Error(`could not build fixture pbf (is osmium installed? brew install osmium-tool): ${r.stderr ?? r.error}`)
    }
  }
}

/** Strip a baked tile down to what the Overpass fallback path delivers:
 *  a bare OsmWay[] with only osmId/tags/coordinates. */
function writeBareTiles(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true })
  for (const name of fs.readdirSync(from)) {
    if (!/^-?\d+_-?\d+\.json$/.test(name)) continue
    const tile = JSON.parse(fs.readFileSync(path.join(from, name), 'utf8')) as EnrichedTile
    const bare = tile.ways.map((w) => ({ osmId: w.osmId, tags: w.tags, coordinates: w.coordinates }))
    fs.writeFileSync(path.join(to, name), JSON.stringify(bare))
  }
}

async function startServer(tilesDir: string): Promise<{ proc: ReturnType<typeof Bun.spawn>; base: string }> {
  const proc = Bun.spawn(
    ['bun', 'server/route-server.ts', '--tiles', tilesDir, '--port', '0', '--no-elevation', '--region', 'e2e-fixture'],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) {
      const err = await new Response(proc.stderr).text()
      throw new Error(`route server exited before listening.\nstdout: ${buf}\nstderr: ${err}`)
    }
    buf += decoder.decode(value)
    const m = /listening on :(\d+)/.exec(buf)
    if (m) {
      reader.releaseLock()
      return { proc, base: `http://127.0.0.1:${m[1]}` }
    }
  }
}

async function postRoute(mode: string): Promise<Response> {
  return fetch(`${serverBase}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ start: START, end: END, travelMode: mode }),
  })
}

beforeAll(async () => {
  ensureFixturePbf()
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-routing-'))
  enrichedDir = path.join(scratch, 'tiles-enriched')
  bareDir = path.join(scratch, 'tiles-bare')

  // Real pipeline bake (no DEM — hermetic; gradients null, fail-soft).
  await enrichRegion({ pbf: FIXTURE_PBF, out: enrichedDir, seq: BASE_SEQ, builtAt: BUILT_AT })
  writeBareTiles(enrichedDir, bareDir)

  // Reference routes: production clientRoute over the enriched tiles.
  loadTilesIntoCache(enrichedDir)
  for (const mode of MODES) {
    const route = await clientRoute(
      START.lat, START.lng, END.lat, END.lng, mode, getDefaultPreferredItems(mode),
    )
    if (route) referenceRoutes.set(mode, route)
  }

  const started = await startServer(enrichedDir)
  serverProc = started.proc
  serverBase = started.base
})

afterAll(() => {
  serverProc?.kill()
  fs.rmSync(scratch, { recursive: true, force: true })
})

// ── Item 3: route A→B per mode, client backend, enriched tiles ────────────

describe('item 3 — clientRoute per mode over pipeline-baked enriched tiles', () => {
  test.each(MODES)('%s finds a route with populated summary and segments', (mode) => {
    const route = referenceRoutes.get(mode)
    expect(route).toBeDefined()
    expect(route!.engine).toBe('client')
    expect(route!.coordinates.length).toBeGreaterThan(1)
    expect(route!.summary.distance).toBeGreaterThan(0)
    expect(route!.summary.duration).toBeGreaterThan(0)
    expect(route!.segments!.length).toBeGreaterThan(0)
  })

  test('the grid route crosses the Gamma connector (105) — sanity that this is a real multi-way path', () => {
    const route = referenceRoutes.get('kid-confident')!
    const viaGamma = route.coordinates.some(
      ([lat, lng]) => Math.abs(lat - 37.763) < 1e-9 && Math.abs(lng - -122.451) < 1e-9,
    )
    expect(viaGamma).toBe(true)
  })

  test('route timing instrumentation records the phase breakdown at the clientRoute seam', async () => {
    clearRouteTimings()
    const route = await clientRoute(
      START.lat, START.lng, END.lat, END.lng, 'kid-confident', getDefaultPreferredItems('kid-confident'),
    )
    expect(route).not.toBeNull()
    const timings = getRouteTimings()
    expect(timings.length).toBe(1)
    const t = timings[0]
    expect(t.backend).toBe('client')
    expect(t.mode).toBe('kid-confident')
    expect(t.found).toBe(true)
    expect(t.tileLoadMs).toBeGreaterThanOrEqual(0)
    expect(t.graphBuildMs).toBeGreaterThanOrEqual(0)
    expect(t.astarMs).toBeGreaterThanOrEqual(0)
    expect(t.totalMs).toBeGreaterThanOrEqual(t.graphBuildMs!)
    expect(t.totalMs).toBeGreaterThanOrEqual(t.astarMs!)
    expect(t.graphNodes).toBeGreaterThan(0)
    expect(t.graphEdges).toBeGreaterThan(0)
  })
})

// ── Item 4: same routes via the spawned route-server process ──────────────

describe('item 4 — route server (spawned CLI process) over the same tiles', () => {
  test('GET /health reports the fixture region and bake provenance', async () => {
    const res = await fetch(`${serverBase}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      region: 'e2e-fixture',
      tilesLoaded: 2, // 377_-1225 + 378_-1225 (way 207 straddles the tile edge)
      builtFromSeq: BASE_SEQ,
    })
  })

  test.each(MODES)('%s: server route is IDENTICAL to the direct clientRoute result (tolerance zero)', async (mode) => {
    const res = await postRoute(mode)
    expect(res.status).toBe(200)
    const serverBody = await res.json()
    const reference = referenceRoutes.get(mode)
    expect(reference).toBeDefined()
    // JSON round-trip normalizes undefined optional fields the same way
    // the HTTP serialization did — the geometry/cost comparison itself is
    // exact, not approximate.
    expect(serverBody).toEqual(JSON.parse(JSON.stringify(reference)))
  })
})

// ── Item 5: non-enriched (Berlin-style fallback) tiles ────────────────────

describe('item 5 — bare non-enriched tiles route identically (fallback path)', () => {
  beforeAll(() => {
    // Overwrites the enriched tiles in the module tile cache with the
    // stripped fallback shape — same keys, same geometry, no baked fields.
    loadTilesIntoCache(bareDir)
  })

  test.each(MODES)('%s routes over bare tiles with geometry identical to the enriched run', async (mode) => {
    const route = await clientRoute(
      START.lat, START.lng, END.lat, END.lng, mode, getDefaultPreferredItems(mode),
    )
    expect(route).not.toBeNull()
    const reference = referenceRoutes.get(mode)
    expect(reference).toBeDefined()
    // Baked fields (gradientPct / accessGradientPct / componentPaintedLenM)
    // must be routing-inert: identical result with them stripped.
    expect(route).toEqual(reference!)
  })
})

// ── routeLegViaBackend seam (the branch App.tsx calls) ─────────────────────

describe('routeLegViaBackend seam — backend selection + fallback', () => {
  const req = (mode: string) => ({
    start: START,
    end: END,
    travelMode: mode,
    preferredItemNames: getDefaultPreferredItems(mode),
  })
  const clientFn = (mode: string) => () =>
    clientRoute(START.lat, START.lng, END.lat, END.lng, mode, getDefaultPreferredItems(mode))

  test('empty backend URL routes on the client (default)', async () => {
    const route = await routeLegViaBackend('', req('kid-confident'), clientFn('kid-confident'))
    expect(route).not.toBeNull()
    expect(route!.engine).toBe('client')
    expect(route!.coordinates).toEqual(referenceRoutes.get('kid-confident')!.coordinates)
  })

  test('live server URL routes on the server, tags engine, and records a round-trip timing', async () => {
    clearRouteTimings()
    const route = await routeLegViaBackend(serverBase, req('kid-confident'), clientFn('kid-confident'))
    expect(route).not.toBeNull()
    expect(route!.engine).toBe('server')
    expect(route!.coordinates).toEqual(referenceRoutes.get('kid-confident')!.coordinates)
    const t = getRouteTimings()[0]
    expect(t.backend).toBe('server')
    expect(t.graphBuildMs).toBeNull() // round-trip only; breakdown lives server-side
    expect(t.totalMs).toBeGreaterThan(0)
    expect(t.found).toBe(true)
  })

  test('dead server URL falls back to the client route', async () => {
    // Port 9 (discard) — nothing listens there; connection is refused fast.
    const route = await routeLegViaBackend('http://127.0.0.1:9', req('kid-confident'), clientFn('kid-confident'))
    expect(route).not.toBeNull()
    expect(route!.engine).toBe('client')
    expect(route!.coordinates).toEqual(referenceRoutes.get('kid-confident')!.coordinates)
  })

  test('serverRoute surfaces protocol errors for the caller to handle', async () => {
    // Unknown mode → 400 → throw (routeLegViaBackend turns this into fallback).
    await expect(
      serverRoute(serverBase, { start: START, end: END, travelMode: 'car', preferredItemNames: new Set() }),
    ).rejects.toThrow(/400/)
  })
})
