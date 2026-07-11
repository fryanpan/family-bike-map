// Chunk B2 — daily diff updater. Synthetic .osc fixtures against a fresh
// bake of tests/fixtures/enrich-fixture.osm (see that file's header for the
// way/node roster). Covers: exact dirty sets (dirty vs rippled — the
// component-scoped invalidation), tile writes/deletes limited to actual
// content changes, provenance (builtFromSeq bump + region-state.json), and
// sequence-mismatch refusals.

import { beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { enrichRegion } from '../../scripts/pipeline/enrich-region'
import {
  REGION_STATE_FILE,
  applyDiff,
  type ApplyDiffOptions,
  type RegionState,
} from '../../scripts/pipeline/apply-diff'
import type { EnrichedTile } from '../../scripts/pipeline/lib/tiles'

const FIXTURE_OSM = path.join(import.meta.dir, '../fixtures/enrich-fixture.osm')
const FIXTURE_PBF = path.join(import.meta.dir, '../fixtures/enrich-fixture.osm.pbf')

const BASE_BUILT_AT = '2026-07-03T00:00:00Z'
const DIFF_BUILT_AT = '2026-07-04T00:00:00Z'
const BASE_SEQ = 42

const MAIN_TILE = '377_-1225.json'
const NORTH_TILE = '378_-1225.json'
const WEST_TILE = '377_-1226.json' // created by the way-220 fixture diff

let scratch: string
let pristineBase: string // baked once, copied per test

function readTile(dir: string, name: string): EnrichedTile {
  return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as EnrichedTile
}

function readState(dir: string): RegionState {
  return JSON.parse(fs.readFileSync(path.join(dir, REGION_STATE_FILE), 'utf8')) as RegionState
}

/** Fresh copy of the pristine base bake for a test to mutate. */
function freshTileDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(scratch, `tiles-${label}-`))
  for (const name of fs.readdirSync(pristineBase)) {
    fs.copyFileSync(path.join(pristineBase, name), path.join(dir, name))
  }
  return dir
}

let oscCounter = 0
function writeOsc(body: string): string {
  const p = path.join(scratch, `change-${oscCounter++}.osc`)
  fs.writeFileSync(
    p,
    `<?xml version='1.0' encoding='UTF-8'?>\n<osmChange version="0.6" generator="test">\n${body}\n</osmChange>\n`,
  )
  return p
}

function diffOpts(tiles: string, osc: string, extra?: Partial<ApplyDiffOptions>): ApplyDiffOptions {
  return {
    pbf: FIXTURE_PBF,
    osc,
    state: BASE_SEQ + 1,
    tiles,
    builtAt: DIFF_BUILT_AT,
    ...extra,
  }
}

beforeAll(async () => {
  // Same fixture-PBF bootstrap as enrich.test.ts.
  const needsBuild =
    !fs.existsSync(FIXTURE_PBF) ||
    fs.statSync(FIXTURE_OSM).mtimeMs > fs.statSync(FIXTURE_PBF).mtimeMs
  if (needsBuild) {
    const r = spawnSync('osmium', ['cat', FIXTURE_OSM, '-o', FIXTURE_PBF, '-O'], { encoding: 'utf8' })
    if (r.error || r.status !== 0) {
      throw new Error(`could not build fixture pbf (is osmium installed? brew install osmium-tool): ${r.stderr ?? r.error}`)
    }
  }
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-diff-test-'))
  pristineBase = path.join(scratch, 'pristine')
  fs.mkdirSync(pristineBase)
  await enrichRegion({ pbf: FIXTURE_PBF, out: pristineBase, builtAt: BASE_BUILT_AT, seq: BASE_SEQ })
})

describe('sequence gate', () => {
  test('refuses --state equal to the base seq (diff already applied)', async () => {
    const tiles = freshTileDir('seq-equal')
    const osc = writeOsc('<modify><node id="103" version="2" lat="37.7620" lon="-122.4495"/></modify>')
    await expect(applyDiff(diffOpts(tiles, osc, { state: BASE_SEQ }))).rejects.toThrow(/sequence mismatch/)
  })

  test('refuses --state behind the base seq', async () => {
    const tiles = freshTileDir('seq-behind')
    const osc = writeOsc('<modify><node id="103" version="2" lat="37.7620" lon="-122.4495"/></modify>')
    await expect(applyDiff(diffOpts(tiles, osc, { state: BASE_SEQ - 1 }))).rejects.toThrow(/sequence mismatch/)
  })

  test('refuses a sequence gap without allowGap, accepts it with allowGap', async () => {
    const tiles = freshTileDir('seq-gap')
    const osc = writeOsc('<modify><node id="103" version="2" lat="37.7620" lon="-122.4495"/></modify>')
    await expect(applyDiff(diffOpts(tiles, osc, { state: BASE_SEQ + 2 }))).rejects.toThrow(/allowGap/)
    const result = await applyDiff(diffOpts(tiles, osc, { state: BASE_SEQ + 2, allowGap: true }))
    expect(result.baseSeq).toBe(BASE_SEQ)
    expect(result.newSeq).toBe(BASE_SEQ + 2)
    expect(readState(tiles).seq).toBe(BASE_SEQ + 2)
  })

  test('refuses an empty or missing tile dir', async () => {
    const empty = fs.mkdtempSync(path.join(scratch, 'empty-'))
    const osc = writeOsc('<modify><node id="103" version="2" lat="37.7620" lon="-122.4495"/></modify>')
    await expect(applyDiff(diffOpts(empty, osc))).rejects.toThrow(/no enriched tiles/)
    await expect(applyDiff(diffOpts(path.join(scratch, 'does-not-exist'), osc))).rejects.toThrow(/no enriched tiles/)
  })

  test('refuses a base bake without a sequence (builtFromSeq null)', async () => {
    const tiles = fs.mkdtempSync(path.join(scratch, 'noseq-'))
    await enrichRegion({ pbf: FIXTURE_PBF, out: tiles, builtAt: BASE_BUILT_AT }) // no seq
    const osc = writeOsc('<modify><node id="103" version="2" lat="37.7620" lon="-122.4495"/></modify>')
    await expect(applyDiff(diffOpts(tiles, osc))).rejects.toThrow(/builtFromSeq null/)
  })

  test('refuses mixed tile seqs when region-state.json is missing', async () => {
    const tiles = freshTileDir('mixed')
    // Apply one diff (bumps MAIN to 43, leaves NORTH at 42), then drop the state file.
    const osc = writeOsc(
      '<modify><way id="204" version="2"><nd ref="107"/><nd ref="108"/><tag k="highway" v="cycleway"/><tag k="name" v="Renamed Path"/></way></modify>',
    )
    await applyDiff(diffOpts(tiles, osc))
    fs.rmSync(path.join(tiles, REGION_STATE_FILE))
    const osc2 = writeOsc('<modify><node id="103" version="2" lat="37.7620" lon="-122.4495"/></modify>')
    await expect(applyDiff(diffOpts(tiles, osc2, { state: BASE_SEQ + 2 }))).rejects.toThrow(/mixed builtFromSeq/)
  })

  test('region-state.json is authoritative: re-applying the same diff refuses', async () => {
    const tiles = freshTileDir('reapply')
    const osc = writeOsc(
      '<modify><way id="204" version="2"><nd ref="107"/><nd ref="108"/><tag k="highway" v="cycleway"/><tag k="name" v="Renamed Path"/></way></modify>',
    )
    await applyDiff(diffOpts(tiles, osc))
    await expect(applyDiff(diffOpts(tiles, osc))).rejects.toThrow(/sequence mismatch/)
  })
})

describe('dirty sets and tile writes', () => {
  test('way tag edit: exactly that way dirty, exactly its tile rewritten', async () => {
    const tiles = freshTileDir('tag-edit')
    const northBefore = fs.readFileSync(path.join(tiles, NORTH_TILE))
    const osc = writeOsc(
      '<modify><way id="204" version="2"><nd ref="107"/><nd ref="108"/><tag k="highway" v="cycleway"/><tag k="name" v="Renamed Path"/></way></modify>',
    )
    const result = await applyDiff(diffOpts(tiles, osc))
    expect(result.dirtyWayIds).toEqual([204])
    expect(result.dirtyControlNodeIds).toEqual([])
    expect(result.rippledWayIds).toEqual([]) // 204 is its own component; geometry unchanged
    expect(result.tilesWritten).toEqual([MAIN_TILE])
    expect(result.tilesDeleted).toEqual([])
    expect(result.tilesUnchanged).toBe(1)
    // Content landed; untouched tile byte-identical.
    const main = readTile(tiles, MAIN_TILE)
    expect(main.ways.find((w) => w.osmId === 204)!.tags.name).toBe('Renamed Path')
    expect(fs.readFileSync(path.join(tiles, NORTH_TILE)).equals(northBefore)).toBe(true)
  })

  test('node move dirties the referencing way and ripples through its component', async () => {
    const tiles = freshTileDir('node-move')
    const lenBefore = readTile(tiles, MAIN_TILE).ways.find((w) => w.osmId === 202)!.componentPaintedLenM!
    // Node 103 belongs only to way 201 (Alpha); 201+202+203 share one
    // component. The way itself never appears in the .osc.
    const osc = writeOsc('<modify><node id="103" version="2" lat="37.7620" lon="-122.4470"/></modify>')
    const result = await applyDiff(diffOpts(tiles, osc))
    expect(result.dirtyWayIds).toEqual([201]) // geometry changed via the node
    // Component-scoped invalidation: Beta + Gamma re-enriched because the
    // component's painted length changed, though their own data didn't.
    expect(result.rippledWayIds).toEqual([202, 203])
    expect(result.tilesWritten).toEqual([MAIN_TILE])
    const main = readTile(tiles, MAIN_TILE)
    expect(main.ways.find((w) => w.osmId === 201)!.coordinates[2]).toEqual([37.762, -122.447])
    const lenAfter = main.ways.find((w) => w.osmId === 202)!.componentPaintedLenM!
    expect(lenAfter).toBeGreaterThan(lenBefore) // Alpha got ~260 m longer
    // Access pass unaffected: the grid is still the mainland seed.
    expect(main.ways.find((w) => w.osmId === 203)!.accessGradientPct).toBe(0)
  })

  test('way deletion: way dirty, removed from its tile', async () => {
    const tiles = freshTileDir('way-delete')
    const osc = writeOsc('<delete><way id="205" version="2"/></delete>')
    const result = await applyDiff(diffOpts(tiles, osc))
    expect(result.dirtyWayIds).toEqual([205])
    expect(result.rippledWayIds).toEqual([]) // 205 was isolated
    expect(result.tilesWritten).toEqual([MAIN_TILE])
    expect(readTile(tiles, MAIN_TILE).ways.some((w) => w.osmId === 205)).toBe(false)
  })

  test('deleting a tile\'s only way deletes the tile file', async () => {
    const tiles = freshTileDir('tile-delete')
    // Way 207 straddles MAIN and NORTH and is NORTH's only way.
    const osc = writeOsc('<delete><way id="207" version="2"/></delete>')
    const result = await applyDiff(diffOpts(tiles, osc))
    expect(result.dirtyWayIds).toEqual([207])
    expect(result.tilesWritten).toEqual([MAIN_TILE])
    expect(result.tilesDeleted).toEqual([NORTH_TILE])
    expect(fs.existsSync(path.join(tiles, NORTH_TILE))).toBe(false)
    expect(readTile(tiles, MAIN_TILE).ways.some((w) => w.osmId === 207)).toBe(false)
  })

  test('way creation in an uncovered area creates a new tile, touching nothing else', async () => {
    const tiles = freshTileDir('way-create')
    const osc = writeOsc(
      `<create>
  <node id="141" version="1" lat="37.7620" lon="-122.5010"/>
  <node id="142" version="1" lat="37.7630" lon="-122.5010"/>
  <way id="220" version="1">
    <nd ref="141"/>
    <nd ref="142"/>
    <tag k="highway" v="cycleway"/>
  </way>
</create>`,
    )
    const result = await applyDiff(diffOpts(tiles, osc))
    expect(result.dirtyWayIds).toEqual([220])
    expect(result.rippledWayIds).toEqual([]) // disconnected from everything
    expect(result.tilesWritten).toEqual([WEST_TILE])
    expect(result.tilesUnchanged).toBe(2)
    const west = readTile(tiles, WEST_TILE)
    expect(west.ways.map((w) => w.osmId)).toEqual([220])
    expect(west.meta.builtFromSeq).toBe(BASE_SEQ + 1)
  })

  test('control-node change (traffic_signals retagged to crossing) reported separately', async () => {
    const tiles = freshTileDir('control-node')
    const osc = writeOsc(
      '<modify><node id="301" version="2" lat="37.7621" lon="-122.4511"><tag k="highway" v="crossing"/></node></modify>',
    )
    const result = await applyDiff(diffOpts(tiles, osc))
    expect(result.dirtyWayIds).toEqual([])
    expect(result.dirtyControlNodeIds).toEqual([301])
    expect(result.tilesWritten).toEqual([MAIN_TILE])
    expect(readTile(tiles, MAIN_TILE).ways.some((w) => w.osmId === 301)).toBe(false)
  })

  test('no-op diff (identical way re-sent): nothing dirty, no writes, sequence still advances', async () => {
    const tiles = freshTileDir('noop')
    const mainBefore = fs.readFileSync(path.join(tiles, MAIN_TILE))
    const osc = writeOsc(
      '<modify><way id="204" version="2"><nd ref="107"/><nd ref="108"/><tag k="highway" v="cycleway"/><tag k="name" v="Panhandle Path"/></way></modify>',
    )
    const result = await applyDiff(diffOpts(tiles, osc))
    expect(result.dirtyWayIds).toEqual([])
    expect(result.dirtyControlNodeIds).toEqual([])
    expect(result.rippledWayIds).toEqual([])
    expect(result.tilesWritten).toEqual([])
    expect(result.tilesUnchanged).toBe(2)
    expect(fs.readFileSync(path.join(tiles, MAIN_TILE)).equals(mainBefore)).toBe(true)
    // The dir still advanced — this is exactly why region-state.json exists.
    expect(readState(tiles)).toEqual({ seq: BASE_SEQ + 1, updatedAt: DIFF_BUILT_AT })
  })

  test('admission flip (bicycle=no added) reads as a deletion from the tile set', async () => {
    const tiles = freshTileDir('admission-flip')
    const osc = writeOsc(
      '<modify><way id="217" version="2"><nd ref="131"/><nd ref="132"/><tag k="highway" v="residential"/><tag k="bicycle" v="no"/></way></modify>',
    )
    // Note: highway=residential + bicycle=no fails the Overpass-mirror
    // filter, and bicycle_road was dropped in the edit.
    const result = await applyDiff(diffOpts(tiles, osc))
    expect(result.dirtyWayIds).toEqual([217])
    expect(readTile(tiles, MAIN_TILE).ways.some((w) => w.osmId === 217)).toBe(false)
  })
})

describe('provenance', () => {
  test('rewritten tiles carry the new seq + builtAt; untouched tiles keep the old meta', async () => {
    const tiles = freshTileDir('provenance')
    const osc = writeOsc(
      '<modify><way id="204" version="2"><nd ref="107"/><nd ref="108"/><tag k="highway" v="cycleway"/><tag k="name" v="Renamed Path"/></way></modify>',
    )
    await applyDiff(diffOpts(tiles, osc))
    expect(readTile(tiles, MAIN_TILE).meta).toEqual({
      builtFromSeq: BASE_SEQ + 1,
      builtAt: DIFF_BUILT_AT,
      pipelineVersion: '1',
      demSource: null,
    })
    expect(readTile(tiles, NORTH_TILE).meta).toEqual({
      builtFromSeq: BASE_SEQ,
      builtAt: BASE_BUILT_AT,
      pipelineVersion: '1',
      demSource: null,
    })
    expect(readState(tiles)).toEqual({ seq: BASE_SEQ + 1, updatedAt: DIFF_BUILT_AT })
  })

  test('chained diffs: seq 42 -> 43 -> 44, second diff based on region-state.json', async () => {
    const tiles = freshTileDir('chained')
    const osc1 = writeOsc(
      '<modify><way id="204" version="2"><nd ref="107"/><nd ref="108"/><tag k="highway" v="cycleway"/><tag k="name" v="Renamed Path"/></way></modify>',
    )
    const updatedPbf = path.join(scratch, 'chained-updated.osm.pbf')
    const r1 = await applyDiff(diffOpts(tiles, osc1, { outPbf: updatedPbf }))
    expect(r1.newSeq).toBe(BASE_SEQ + 1)
    // Second day's diff applies against the UPDATED pbf.
    const osc2 = writeOsc('<delete><way id="205" version="2"/></delete>')
    const r2 = await applyDiff(
      diffOpts(tiles, osc2, { pbf: updatedPbf, state: BASE_SEQ + 2, builtAt: '2026-07-05T00:00:00Z' }),
    )
    expect(r2.baseSeq).toBe(BASE_SEQ + 1)
    expect(r2.newSeq).toBe(BASE_SEQ + 2)
    const main = readTile(tiles, MAIN_TILE)
    expect(main.meta.builtFromSeq).toBe(BASE_SEQ + 2)
    expect(main.ways.find((w) => w.osmId === 204)!.tags.name).toBe('Renamed Path') // day 1 survived
    expect(main.ways.some((w) => w.osmId === 205)).toBe(false) // day 2 applied
    expect(readState(tiles).seq).toBe(BASE_SEQ + 2)
  })

  test('after a diff, tile CONTENT equals a fresh full bake of the updated PBF', async () => {
    const tiles = freshTileDir('parity')
    const updatedPbf = path.join(scratch, 'parity-updated.osm.pbf')
    const osc = writeOsc('<modify><node id="103" version="2" lat="37.7620" lon="-122.4470"/></modify>')
    await applyDiff(diffOpts(tiles, osc, { outPbf: updatedPbf }))
    // Full re-bake from the persisted updated PBF.
    const rebake = fs.mkdtempSync(path.join(scratch, 'rebake-'))
    await enrichRegion({ pbf: updatedPbf, out: rebake, builtAt: DIFF_BUILT_AT, seq: BASE_SEQ + 1 })
    const tileNames = fs.readdirSync(tiles).filter((n) => n !== REGION_STATE_FILE).sort()
    expect(fs.readdirSync(rebake).sort()).toEqual(tileNames)
    for (const name of tileNames) {
      // Ways byte-identical everywhere; meta may differ on tiles the diff
      // didn't rewrite (kept old provenance on purpose).
      expect(JSON.stringify(readTile(tiles, name).ways)).toBe(
        JSON.stringify(readTile(rebake, name).ways),
      )
    }
  })
})
