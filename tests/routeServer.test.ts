/**
 * Route-server contract tests (enriched-tiles plan, "Route server unit").
 *
 * NOTE on fixtures: chunk A2's pipeline fixture tiles hadn't landed when
 * this was written, so these tests generate their own minimal tile JSONs
 * (enriched-tile shape: {meta, ways}) into a temp dir. The geometry is a
 * tiny synthetic Berlin-ish network inside tile 525:134 — a cycleway
 * spine, a residential connector (exercises bridge-walk for
 * kid-starting-out), and a second cycleway leg.
 *
 * The CRITICAL test: the server's route for an OD pair is IDENTICAL
 * (tolerance zero) to a direct clientRoute() call on the same tile data —
 * the same-code invariant. Both run in this process against the same
 * injected tile cache, so any divergence is a real code-path difference.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startRouteServer, loadTilesIntoCache } from '../server/route-server'
import type { RouteServerHandle } from '../server/route-server'
import { clientRoute } from '../src/services/clientRouter'
import { getDefaultPreferredItems } from '../src/utils/classify'
import { MODE_RULES } from '../src/data/modes'
import type { Route } from '../src/utils/types'

// ── Fixture tiles ──────────────────────────────────────────────────────────
// Tile 525:134 covers lat 52.5–52.6, lng 13.4–13.5.

const TILE_525_134 = {
  meta: { builtFromSeq: 12345, builtAt: '2026-07-03T00:00:00Z', pipelineVersion: '1' },
  ways: [
    {
      osmId: 1,
      tags: { highway: 'cycleway' },
      coordinates: [
        [52.5000, 13.4000],
        [52.5050, 13.4000],
        [52.5100, 13.4000],
      ],
      // Enriched baked fields must be tolerated (and ignored by routing).
      gradientPct: 1.2,
      accessGradientPct: 1.2,
      componentPaintedLenM: 2300,
    },
    {
      osmId: 2,
      tags: { highway: 'residential' },
      coordinates: [
        [52.5100, 13.4000],
        [52.5100, 13.4050],
      ],
    },
    {
      osmId: 3,
      tags: { highway: 'cycleway' },
      coordinates: [
        [52.5100, 13.4050],
        [52.5150, 13.4050],
      ],
    },
  ],
}

// Second tile: disconnected mini-way far from the main network, plus a
// higher builtFromSeq so /health reports the max.
const TILE_525_135 = {
  meta: { builtFromSeq: 12346 },
  ways: [
    {
      osmId: 10,
      tags: { highway: 'cycleway' },
      coordinates: [
        [52.5500, 13.5500],
        [52.5550, 13.5500],
      ],
    },
  ],
}

const START = { lat: 52.5, lng: 13.4 }
const END = { lat: 52.515, lng: 13.405 }

let tilesDir: string
let handle: RouteServerHandle
let base: string

async function postRoute(body: unknown): Promise<Response> {
  return fetch(`${base}/route`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeAll(() => {
  tilesDir = mkdtempSync(join(tmpdir(), 'route-server-tiles-'))
  writeFileSync(join(tilesDir, '525_134.json'), JSON.stringify(TILE_525_134))
  writeFileSync(join(tilesDir, '525_135.json'), JSON.stringify(TILE_525_135))
  // Junk that the loader must skip without dying.
  writeFileSync(join(tilesDir, 'not-a-tile.json'), JSON.stringify({ hello: 'world' }))
  writeFileSync(join(tilesDir, 'README.txt'), 'not json at all')
  handle = startRouteServer({ tilesDir, port: 0, region: 'test-fixture' })
  base = `http://localhost:${handle.port}`
})

afterAll(() => {
  handle?.server.stop(true)
  rmSync(tilesDir, { recursive: true, force: true })
})

// ── /health ────────────────────────────────────────────────────────────────

describe('GET /health', () => {
  test('reports ok, region, tile count, and max builtFromSeq', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      ok: true,
      region: 'test-fixture',
      tilesLoaded: 2,
      builtFromSeq: 12346,
    })
  })
})

// ── POST /route happy paths ────────────────────────────────────────────────

describe('POST /route — happy path', () => {
  const modes = Object.keys(MODE_RULES)

  test.each(modes)('%s returns a 200 route with the clientRoute shape', async (mode) => {
    const res = await postRoute({ start: START, end: END, travelMode: mode })
    expect(res.status).toBe(200)
    const route = (await res.json()) as Route
    expect(route).not.toBeNull()
    expect(route.engine).toBe('client')
    expect(route.coordinates.length).toBeGreaterThan(1)
    expect(route.summary.distance).toBeGreaterThan(0)
    expect(route.summary.duration).toBeGreaterThan(0)
    expect(Array.isArray(route.segments)).toBe(true)
  })

  test('CRITICAL: server route is identical to a direct clientRoute call on the same tiles', async () => {
    for (const mode of modes) {
      const res = await postRoute({ start: START, end: END, travelMode: mode })
      expect(res.status).toBe(200)
      const serverRoute = await res.json()

      // Direct call — same process, same injected tile cache, same
      // default preferred items the server resolves for the mode.
      const direct = await clientRoute(
        START.lat, START.lng, END.lat, END.lng,
        mode, getDefaultPreferredItems(mode),
      )
      expect(direct).not.toBeNull()
      // JSON round-trip normalizes undefined-valued optional fields the
      // same way the HTTP response serialization did. Tolerance ZERO.
      expect(serverRoute).toEqual(JSON.parse(JSON.stringify(direct)))
    }
  })

  test('explicit preferredItemNames are honored (same as passing them to clientRoute)', async () => {
    const preferred = ['Bike path']
    const res = await postRoute({
      start: START, end: END, travelMode: 'kid-confident', preferredItemNames: preferred,
    })
    expect(res.status).toBe(200)
    const serverRoute = await res.json()
    const direct = await clientRoute(
      START.lat, START.lng, END.lat, END.lng, 'kid-confident', new Set(preferred),
    )
    expect(serverRoute).toEqual(JSON.parse(JSON.stringify(direct)))
  })

  test('avoidedWayIds are honored ("reroute around this" reaches the server router)', async () => {
    // Way 2 is the only connector between the two cycleway legs: without
    // avoids the route crosses it; with it avoided the router must not —
    // and the answer must match a direct clientRoute call with the same
    // avoid set (same-code invariant). The pre-fix bug: the server dropped
    // avoidedWayIds and returned the unavoided route unchanged.
    const unavoided = await postRoute({ start: START, end: END, travelMode: 'kid-confident' })
    expect(unavoided.status).toBe(200)
    const unavoidedRoute = (await unavoided.json()) as Route | null
    expect(unavoidedRoute).not.toBeNull()
    expect(unavoidedRoute!.segments!.some((s) => s.wayIds?.includes(2))).toBe(true)

    const res = await postRoute({
      start: START, end: END, travelMode: 'kid-confident', avoidedWayIds: [2],
    })
    expect(res.status).toBe(200)
    const avoidedRoute = (await res.json()) as Route | null

    const direct = await clientRoute(
      START.lat, START.lng, END.lat, END.lng,
      'kid-confident', getDefaultPreferredItems('kid-confident'),
      undefined, undefined, new Set([2]),
    )
    expect(avoidedRoute).toEqual(direct === null ? null : JSON.parse(JSON.stringify(direct)))
    // With way 2 severed, the end-snap falls back to the directed-reachable
    // set (way 1 only) — whatever the router does, way 2 must be absent.
    expect(avoidedRoute).not.toBeNull()
    expect(avoidedRoute!.segments!.every((s) => !(s.wayIds ?? []).includes(2))).toBe(true)
    expect(avoidedRoute!.coordinates).not.toEqual(unavoidedRoute!.coordinates)
  })

  test('empty avoidedWayIds behaves exactly like no avoidedWayIds', async () => {
    const res = await postRoute({
      start: START, end: END, travelMode: 'kid-confident', avoidedWayIds: [],
    })
    expect(res.status).toBe(200)
    const route = await res.json()
    const direct = await clientRoute(
      START.lat, START.lng, END.lat, END.lng,
      'kid-confident', getDefaultPreferredItems('kid-confident'),
    )
    expect(route).toEqual(JSON.parse(JSON.stringify(direct)))
  })

  test('unroutable pair inside the region returns 200 null (clientRoute semantics)', async () => {
    // (52.595, 13.495) is inside loaded tile 525:134 but >1 km from any
    // way, so the nearest-node snap fails and clientRoute returns null.
    const res = await postRoute({
      start: START, end: { lat: 52.595, lng: 13.495 }, travelMode: 'kid-confident',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  })
})

// ── 400s ───────────────────────────────────────────────────────────────────

describe('POST /route — malformed input', () => {
  test('non-JSON body → 400', async () => {
    const res = await postRoute('this is not json')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('JSON')
  })

  test('missing start → 400', async () => {
    const res = await postRoute({ end: END, travelMode: 'kid-confident' })
    expect(res.status).toBe(400)
  })

  test('non-numeric lat → 400', async () => {
    const res = await postRoute({
      start: { lat: '52.5', lng: 13.4 }, end: END, travelMode: 'kid-confident',
    })
    expect(res.status).toBe(400)
  })

  test('out-of-range coordinates → 400', async () => {
    const res = await postRoute({
      start: { lat: 152.5, lng: 13.4 }, end: END, travelMode: 'kid-confident',
    })
    expect(res.status).toBe(400)
  })

  test('unknown travelMode → 400 listing the valid modes', async () => {
    const res = await postRoute({ start: START, end: END, travelMode: 'car' })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('kid-starting-out')
  })

  test('missing travelMode → 400', async () => {
    const res = await postRoute({ start: START, end: END })
    expect(res.status).toBe(400)
  })

  test('preferredItemNames with non-strings → 400', async () => {
    const res = await postRoute({
      start: START, end: END, travelMode: 'kid-confident', preferredItemNames: [42],
    })
    expect(res.status).toBe(400)
  })

  test('avoidedWayIds with non-numbers → 400', async () => {
    const res = await postRoute({
      start: START, end: END, travelMode: 'kid-confident', avoidedWayIds: ['2'],
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('avoidedWayIds')
  })

  test('non-array avoidedWayIds → 400', async () => {
    const res = await postRoute({
      start: START, end: END, travelMode: 'kid-confident', avoidedWayIds: 2,
    })
    expect(res.status).toBe(400)
  })
})

// ── 422s ───────────────────────────────────────────────────────────────────

describe('POST /route — out of region', () => {
  test('start far outside the region → 422', async () => {
    const res = await postRoute({
      start: { lat: 0, lng: 0 }, end: END, travelMode: 'kid-confident',
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toContain('start')
  })

  test('end in an adjacent-but-unloaded tile → 422', async () => {
    // Tile 526:134 is in the padding ring (injected empty), NOT a loaded
    // region tile — points there must still 422.
    const res = await postRoute({
      start: START, end: { lat: 52.62, lng: 13.41 }, travelMode: 'kid-confident',
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { error: string }).error).toContain('end')
  })
})

// ── Misc routing table ─────────────────────────────────────────────────────

describe('unknown routes', () => {
  test('GET /route → 404', async () => {
    const res = await fetch(`${base}/route`)
    expect(res.status).toBe(404)
  })

  test('POST /nope → 404', async () => {
    const res = await fetch(`${base}/nope`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(404)
  })

  test('OPTIONS preflight → 204 with CORS headers', async () => {
    const res = await fetch(`${base}/route`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})

// ── Tile loader ────────────────────────────────────────────────────────────

describe('loadTilesIntoCache', () => {
  test('throws on a directory with no usable tiles', () => {
    const empty = mkdtempSync(join(tmpdir(), 'route-server-empty-'))
    try {
      expect(() => loadTilesIntoCache(empty)).toThrow(/no usable tile JSONs/)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  test('accepts bare OsmWay[] tiles and meta.row/meta.col overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'route-server-alt-'))
    try {
      // Bare-array format, row/col from filename. Far away from the main
      // fixture region so it can't interfere with other tests.
      writeFileSync(join(dir, '100_100.json'), JSON.stringify([
        { osmId: 20, tags: { highway: 'cycleway' }, coordinates: [[10.05, 10.05], [10.055, 10.05]] },
      ]))
      // Enriched format where meta.row/meta.col override a junk filename.
      writeFileSync(join(dir, 'weird-name.json'), JSON.stringify({
        meta: { row: 100, col: 101, builtFromSeq: 7 },
        ways: [
          { osmId: 21, tags: { highway: 'cycleway' }, coordinates: [[10.05, 10.15], [10.055, 10.15]] },
        ],
      }))
      const loaded = loadTilesIntoCache(dir)
      expect(loaded.tilesLoaded).toBe(2)
      expect(loaded.loadedKeys.has('100:100')).toBe(true)
      expect(loaded.loadedKeys.has('100:101')).toBe(true)
      expect(loaded.builtFromSeq).toBe(7)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
