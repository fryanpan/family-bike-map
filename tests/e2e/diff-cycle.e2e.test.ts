/**
 * Scripted end-to-end test — enriched-tiles plan, "End-to-end happy
 * paths" item 6: the daily-diff cycle on fixtures.
 *
 *   edit (.osc) → apply-diff → re-enrich → updated tile, provenance seq
 *   advances — and the change is VISIBLE to routing: reloading the
 *   updated tiles into the cache changes the route the production
 *   clientRoute returns.
 *
 * Scenario: the fixture's only multi-way component is the residential
 * grid Alpha(101-102-103) + Beta(104-105-106) joined by Gamma(102-105).
 * Before the diff, routing node 101 → node 106 crosses Gamma. The .osc
 * deletes Gamma (way 203), splitting Alpha from Beta — afterwards the
 * end snap can only reach Alpha (node 103, ~111 m from the requested
 * end), so the route stays on lat 37.7620 and never touches Beta.
 *
 * The pipeline units (dirty sets, sequence gate, provenance stamping)
 * are covered in tests/pipeline/apply-diff.test.ts; this file covers the
 * cycle end-to-end through the ROUTER's eyes.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { enrichRegion } from '../../scripts/pipeline/enrich-region'
import { REGION_STATE_FILE, applyDiff, type RegionState } from '../../scripts/pipeline/apply-diff'
import { loadTilesIntoCache } from '../../server/route-server'
import { clientRoute } from '../../src/services/clientRouter'
import { getDefaultPreferredItems } from '../../src/utils/classify'
import type { EnrichedTile } from '../../scripts/pipeline/lib/tiles'
import type { Route } from '../../src/utils/types'

const FIXTURE_OSM = path.join(import.meta.dir, '../fixtures/enrich-fixture.osm')
const FIXTURE_PBF = path.join(import.meta.dir, '../fixtures/enrich-fixture.osm.pbf')

const BASE_SEQ = 42
const BASE_BUILT_AT = '2026-07-03T00:00:00Z'
const DIFF_BUILT_AT = '2026-07-04T00:00:00Z'
const MAIN_TILE = '377_-1225.json'

const START = { lat: 37.762, lng: -122.452 } // node 101 — Alpha Street west end
const END = { lat: 37.763, lng: -122.45 }    // node 106 — Beta Street east end
const MODE = 'kid-confident'

// Node 105 — the Gamma/Beta junction the pre-diff route must cross.
const GAMMA_JUNCTION: [number, number] = [37.763, -122.451]

let scratch: string
let tilesDir: string

function hasCoord(route: Route, [lat, lng]: [number, number]): boolean {
  return route.coordinates.some(
    ([a, b]) => Math.abs(a - lat) < 1e-9 && Math.abs(b - lng) < 1e-9,
  )
}

function readTile(name: string): EnrichedTile {
  return JSON.parse(fs.readFileSync(path.join(tilesDir, name), 'utf8')) as EnrichedTile
}

async function route(): Promise<Route | null> {
  return clientRoute(START.lat, START.lng, END.lat, END.lng, MODE, getDefaultPreferredItems(MODE))
}

beforeAll(async () => {
  const needsBuild =
    !fs.existsSync(FIXTURE_PBF) ||
    fs.statSync(FIXTURE_OSM).mtimeMs > fs.statSync(FIXTURE_PBF).mtimeMs
  if (needsBuild) {
    const r = spawnSync('osmium', ['cat', FIXTURE_OSM, '-o', FIXTURE_PBF, '-O'], { encoding: 'utf8' })
    if (r.error || r.status !== 0) {
      throw new Error(`could not build fixture pbf (is osmium installed? brew install osmium-tool): ${r.stderr ?? r.error}`)
    }
  }
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-diff-cycle-'))
  tilesDir = path.join(scratch, 'tiles')
  await enrichRegion({ pbf: FIXTURE_PBF, out: tilesDir, seq: BASE_SEQ, builtAt: BASE_BUILT_AT })
})

describe('item 6 — daily-diff cycle: edit → diff → re-enrich → routing sees the update', () => {
  test('full cycle', async () => {
    // BEFORE: the baked tiles route across the Gamma connector.
    loadTilesIntoCache(tilesDir)
    const before = await route()
    expect(before).not.toBeNull()
    expect(hasCoord(before!, GAMMA_JUNCTION)).toBe(true)
    expect(readTile(MAIN_TILE).ways.some((w) => w.osmId === 203)).toBe(true)
    expect(readTile(MAIN_TILE).meta.builtFromSeq).toBe(BASE_SEQ)

    // EDIT: an OsmChange file deleting Gamma Street (way 203).
    const osc = path.join(scratch, 'delete-gamma.osc')
    fs.writeFileSync(
      osc,
      `<?xml version='1.0' encoding='UTF-8'?>\n` +
      `<osmChange version="0.6" generator="e2e-test">\n` +
      `<delete><way id="203" version="2"/></delete>\n` +
      `</osmChange>\n`,
    )

    // DIFF → RE-ENRICH (the production apply-diff path, full pipeline bake).
    const result = await applyDiff({
      pbf: FIXTURE_PBF,
      osc,
      state: BASE_SEQ + 1,
      tiles: tilesDir,
      builtAt: DIFF_BUILT_AT,
    })
    expect(result.dirtyWayIds).toEqual([203])
    // Deleting the grid's connector re-crowns the mainland component, so
    // accessGradientPct legitimately ripples beyond MAIN_TILE (the north
    // tile's way 207 gets a new access verdict) — assert containment, not
    // equality. The exact ripple semantics are pinned in
    // tests/pipeline/apply-diff.test.ts.
    expect(result.tilesWritten).toContain(MAIN_TILE)
    expect(result.tilesDeleted).toEqual([])

    // UPDATED TILE + PROVENANCE: way gone, seq advanced on the rewritten
    // tile and in the dir-level state file.
    const main = readTile(MAIN_TILE)
    expect(main.ways.some((w) => w.osmId === 203)).toBe(false)
    expect(main.meta.builtFromSeq).toBe(BASE_SEQ + 1)
    expect(main.meta.builtAt).toBe(DIFF_BUILT_AT)
    const state = JSON.parse(
      fs.readFileSync(path.join(tilesDir, REGION_STATE_FILE), 'utf8'),
    ) as RegionState
    expect(state).toEqual({ seq: BASE_SEQ + 1, updatedAt: DIFF_BUILT_AT })

    // ROUTING SEES IT: reload the updated tiles; Alpha and Beta are now
    // split, so the route can no longer cross Gamma — the end snap falls
    // back to Alpha's east end (node 103) and the whole route stays on
    // Alpha (lat 37.7620).
    loadTilesIntoCache(tilesDir)
    const after = await route()
    expect(after).not.toBeNull()
    expect(hasCoord(after!, GAMMA_JUNCTION)).toBe(false)
    for (const [lat] of after!.coordinates) {
      expect(Math.abs(lat - 37.762)).toBeLessThan(1e-6)
    }
    expect(after!.coordinates).not.toEqual(before!.coordinates)
  }, 30_000)
})
