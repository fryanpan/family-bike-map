// Daily diff updater — chunk B2 of the enriched-tiles plan.
//
//   bun scripts/pipeline/apply-diff.ts --pbf data/norcal.osm.pbf \
//       --osc data/diffs/4032.osc --state 4032 --tiles data/tiles \
//       [--out-pbf data/norcal.osm.pbf.next] [--allow-gap] [--built-at ISO] \
//       [--dem-cache data/dem-cache] [--no-dem]
//
// Consumes a Geofabrik replication change file (.osc) against an existing
// enriched-tile directory (see scripts/pipeline/README.md for the cron flow,
// scripts/pipeline/update-region.sh for the entry point):
//
//   1. SEQUENCE GATE — the tile dir's provenance (region-state.json, or the
//      uniform meta.builtFromSeq of a fresh bake) must be exactly
//      `--state - 1`. `--allow-gap` permits an aggregated .osc that covers
//      several sequences at once (what pyosmium-get-changes produces after
//      a skipped day). Anything else refuses — applying a diff to a base it
//      wasn't made for silently corrupts every touched way.
//   2. `osmium apply-changes` produces the updated region PBF (persisted to
//      --out-pbf so the next run has its base; omitted = discarded).
//   3. The updated region is re-enriched through enrichRegion — the SAME
//      production bake as the initial run, one implementation by
//      construction. The bake is region-wide because the graph passes are
//      inherently global (the minimax mainland seed is a region-level
//      decision; a diff can merge/split components or even re-crown the
//      mainland). The DEM disk cache makes the gradient re-bake
//      network-free, so the daily cost is CPU-bound, not download-bound.
//   4. Old and new tiles are diffed way-by-way:
//        - DIRTY ways: own data changed — created, deleted, tag edit,
//          geometry change (a node move dirties every way that references
//          the node, without the way appearing in the .osc), gradientPct.
//        - RIPPLED ways: only the baked graph context changed
//          (accessGradientPct / componentPaintedLenM) — the
//          component-scoped invalidation the plan calls for, computed
//          exactly (a dirty way's whole old + new component) rather than
//          predicted from the .osc.
//      Only tiles whose content actually changed are rewritten, with
//      meta.builtFromSeq bumped to --state; untouched tiles stay
//      byte-identical so an R2 sync uploads only the delta. Tiles whose
//      last way disappeared are deleted.
//   5. region-state.json records the dir-level sequence. Tile metas alone
//      can't carry it: an empty or no-op diff advances the sequence
//      without rewriting a single tile.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseArgs } from 'node:util'

import { enrichRegion } from './enrich-region'
import { assertOsmiumAvailable } from './lib/osmium'
import type { TerrariumDemOptions } from './lib/dem'
import type { EnrichedTile, EnrichedWay } from './lib/tiles'

/**
 * Dir-level provenance file, written next to the tile JSONs after every
 * successful apply. Never collides with tile files (those are
 * `<row>_<col>.json`, digits only).
 */
export const REGION_STATE_FILE = 'region-state.json'

export interface RegionState {
  /** Replication sequence the tile dir currently reflects. */
  seq: number
  /** builtAt of the apply that last advanced the sequence. */
  updatedAt: string
}

const TILE_FILE_RE = /^-?\d+_-?\d+\.json$/

export interface ApplyDiffOptions {
  /** Base region PBF — MUST be the data the tile dir was built from. */
  pbf: string
  /** OsmChange file advancing the region from `state - 1` to `state`. */
  osc: string
  /** Replication sequence the .osc advances the region TO. */
  state: number
  /** Existing enriched tile dir; updated in place. */
  tiles: string
  /** Where to persist the updated PBF (the next run's --pbf). Omit to discard it. */
  outPbf?: string
  /**
   * Accept `state > baseSeq + 1` for an aggregated .osc covering every
   * sequence in between (pyosmium-get-changes output). Never lets a diff
   * apply BACKWARDS or re-apply the current sequence.
   */
  allowGap?: boolean
  /** meta.builtAt for rewritten tiles (pin for reproducible output). Default: now. */
  builtAt?: string
  /** Same contract as EnrichRegionOptions.dem — use the SAME DEM settings as the original bake or every gradient re-grades. */
  dem?: TerrariumDemOptions
}

export interface ApplyDiffResult {
  baseSeq: number
  newSeq: number
  /** Real ways whose own data changed: created, deleted, tag / geometry / gradientPct edits. Sorted. */
  dirtyWayIds: number[]
  /** Control-node pseudo-ways (traffic_signals/stop) that appeared, moved, or disappeared. Sorted. */
  dirtyControlNodeIds: number[]
  /**
   * Component-scoped invalidation: ways whose own data is unchanged but
   * whose baked graph context (accessGradientPct / componentPaintedLenM)
   * changed because a dirty way touched their component. Sorted.
   */
  rippledWayIds: number[]
  /** Tile files created or rewritten (meta bumped to newSeq). Sorted. */
  tilesWritten: string[]
  /** Tile files deleted because the updated region has no ways there. Sorted. */
  tilesDeleted: string[]
  /** Tiles left byte-identical (meta deliberately NOT bumped — provenance stays honest and R2 syncs stay small). */
  tilesUnchanged: number
}

/** Local wrapper — lib/osmium.ts keeps its runner private and is outside this chunk's surface. Same conventions (foreground, throw on failure). */
function osmiumApplyChanges(basePbf: string, osc: string, outPbf: string): void {
  const args = ['apply-changes', basePbf, osc, '-o', outPbf, '-O']
  const r = spawnSync('osmium', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw r.error
  if (r.status !== 0) {
    throw new Error(`osmium ${args.join(' ')} failed (exit ${r.status}):\n${r.stderr}`)
  }
}

/** Read every tile JSON in a directory (skips region-state.json and anything else that isn't `<row>_<col>.json`). */
function readTileDir(dir: string): Map<string, EnrichedTile> {
  const out = new Map<string, EnrichedTile>()
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir).sort()) {
    if (!TILE_FILE_RE.test(name)) continue
    out.set(name, JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as EnrichedTile)
  }
  return out
}

/**
 * The tile dir's current sequence: region-state.json when present (written
 * by every apply-diff run), else the uniform meta.builtFromSeq of a fresh
 * enrich-region bake. Mixed or null metas without a state file are
 * unverifiable provenance — refuse rather than guess.
 */
function resolveBaseSeq(dir: string, tiles: Map<string, EnrichedTile>): number {
  const stateFile = path.join(dir, REGION_STATE_FILE)
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Partial<RegionState>
    if (!Number.isInteger(state.seq)) {
      throw new Error(`${stateFile} is corrupt (no integer "seq"): refusing to apply a diff`)
    }
    return state.seq as number
  }
  const seqs = new Set([...tiles.values()].map((t) => t.meta.builtFromSeq))
  if (seqs.size !== 1) {
    throw new Error(
      `tile dir ${dir} has mixed builtFromSeq values (${[...seqs].join(', ')}) and no ${REGION_STATE_FILE} — ` +
      'provenance is unverifiable; re-bake with enrich-region or restore the state file',
    )
  }
  const seq = [...seqs][0]
  if (seq == null) {
    throw new Error(
      `tile dir ${dir} was baked without a replication sequence (builtFromSeq null) — ` +
      'diffs cannot be verified against it; re-bake with --seq or from a PBF with a replication header',
    )
  }
  return seq
}

// A control-node pseudo-way has exactly one coordinate; real ways always
// have >= 2 (the bake drops shorter ones). Node ids and way ids live in
// separate OSM number spaces, so the diff keys them separately.
function isControlNodeEntry(w: EnrichedWay): boolean {
  return w.coordinates.length === 1
}

function collectWays(tiles: Map<string, EnrichedTile>): Map<string, EnrichedWay> {
  const out = new Map<string, EnrichedWay>()
  for (const tile of tiles.values()) {
    for (const w of tile.ways) {
      // A multi-tile way carries identical full geometry + enrichment in
      // every tile (Overpass parity), so first-seen wins is safe.
      const key = `${isControlNodeEntry(w) ? 'n' : 'w'}${w.osmId}`
      if (!out.has(key)) out.set(key, w)
    }
  }
  return out
}

/** Did the way's OWN data change? (tags / geometry / its baked gradient — as opposed to graph-context ripple.) */
function ownDataChanged(a: EnrichedWay, b: EnrichedWay): boolean {
  return (
    JSON.stringify(a.tags) !== JSON.stringify(b.tags) ||
    JSON.stringify(a.coordinates) !== JSON.stringify(b.coordinates) ||
    a.gradientPct !== b.gradientPct
  )
}

/** Did only the baked graph context change? (Component-scoped invalidation.) */
function graphContextChanged(a: EnrichedWay, b: EnrichedWay): boolean {
  return (
    a.accessGradientPct !== b.accessGradientPct ||
    a.componentPaintedLenM !== b.componentPaintedLenM
  )
}

export async function applyDiff(opts: ApplyDiffOptions): Promise<ApplyDiffResult> {
  assertOsmiumAvailable()
  if (!fs.existsSync(opts.pbf)) throw new Error(`--pbf not found: ${opts.pbf}`)
  if (!fs.existsSync(opts.osc)) throw new Error(`--osc not found: ${opts.osc}`)
  if (!Number.isInteger(opts.state)) throw new Error(`--state must be an integer sequence number, got: ${opts.state}`)

  const existing = readTileDir(opts.tiles)
  if (existing.size === 0) {
    throw new Error(`--tiles has no enriched tiles: ${opts.tiles} — run enrich-region first`)
  }

  // 1. Sequence gate.
  const baseSeq = resolveBaseSeq(opts.tiles, existing)
  if (opts.state <= baseSeq) {
    throw new Error(
      `sequence mismatch: tiles are at seq ${baseSeq}, --state ${opts.state} does not advance it ` +
      '(diff already applied, or the wrong .osc)',
    )
  }
  if (opts.state !== baseSeq + 1 && !opts.allowGap) {
    throw new Error(
      `sequence mismatch: tiles are at seq ${baseSeq}, expected --state ${baseSeq + 1} but got ${opts.state}. ` +
      'Pass allowGap ONLY for an aggregated .osc that covers every sequence in between (pyosmium-get-changes output).',
    )
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-diff-'))
  try {
    // 2. Apply the change file to the base PBF.
    const updatedPbf = opts.outPbf ?? path.join(tmpDir, 'updated.osm.pbf')
    osmiumApplyChanges(opts.pbf, opts.osc, updatedPbf)

    // 3. Re-enrich the updated region through the production bake.
    const builtAt = opts.builtAt ?? new Date().toISOString()
    const bakeDir = path.join(tmpDir, 'tiles')
    await enrichRegion({
      pbf: updatedPbf,
      out: bakeDir,
      seq: opts.state,
      builtAt,
      dem: opts.dem,
    })
    const next = readTileDir(bakeDir)

    // 4. Way-level diff: dirty (own data) vs rippled (graph context only).
    const oldWays = collectWays(existing)
    const newWays = collectWays(next)
    const dirtyWayIds = new Set<number>()
    const dirtyControlNodeIds = new Set<number>()
    const rippledWayIds = new Set<number>()
    for (const key of new Set([...oldWays.keys(), ...newWays.keys()])) {
      const before = oldWays.get(key)
      const after = newWays.get(key)
      const isControl = key[0] === 'n'
      const id = Number(key.slice(1))
      if (!before || !after) {
        // Created or deleted (includes admission flips, e.g. bicycle=no
        // added, or a control node re-tagged to something else).
        ;(isControl ? dirtyControlNodeIds : dirtyWayIds).add(id)
      } else if (ownDataChanged(before, after)) {
        ;(isControl ? dirtyControlNodeIds : dirtyWayIds).add(id)
      } else if (!isControl && graphContextChanged(before, after)) {
        rippledWayIds.add(id)
      }
    }

    // 5. Tile-level writes: only content changes touch the dir.
    const tilesWritten: string[] = []
    const tilesDeleted: string[] = []
    let tilesUnchanged = 0
    for (const [name, tile] of next) {
      const before = existing.get(name)
      if (before && JSON.stringify(before.ways) === JSON.stringify(tile.ways)) {
        tilesUnchanged++
        continue
      }
      fs.copyFileSync(path.join(bakeDir, name), path.join(opts.tiles, name))
      tilesWritten.push(name)
    }
    for (const name of existing.keys()) {
      if (!next.has(name)) {
        fs.rmSync(path.join(opts.tiles, name))
        tilesDeleted.push(name)
      }
    }

    // 6. Advance the dir-level sequence (even when the diff was a no-op).
    const regionState: RegionState = { seq: opts.state, updatedAt: builtAt }
    fs.writeFileSync(
      path.join(opts.tiles, REGION_STATE_FILE),
      JSON.stringify(regionState, null, 2) + '\n',
    )

    const asc = (a: number, b: number) => a - b
    return {
      baseSeq,
      newSeq: opts.state,
      dirtyWayIds: [...dirtyWayIds].sort(asc),
      dirtyControlNodeIds: [...dirtyControlNodeIds].sort(asc),
      rippledWayIds: [...rippledWayIds].sort(asc),
      tilesWritten: tilesWritten.sort(),
      tilesDeleted: tilesDeleted.sort(),
      tilesUnchanged,
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      pbf: { type: 'string' },
      osc: { type: 'string' },
      state: { type: 'string' },
      tiles: { type: 'string' },
      'out-pbf': { type: 'string' },
      'allow-gap': { type: 'boolean' },
      'built-at': { type: 'string' },
      'dem-cache': { type: 'string' },
      'no-dem': { type: 'boolean' },
    },
  })
  if (!values.pbf || !values.osc || !values.state || !values.tiles) {
    console.error(
      'Usage: bun scripts/pipeline/apply-diff.ts --pbf <base.osm.pbf> --osc <change.osc> ' +
      '--state <seq> --tiles <dir> [--out-pbf <updated.osm.pbf>] [--allow-gap] ' +
      '[--built-at ISO] [--dem-cache data/dem-cache] [--no-dem]',
    )
    process.exit(1)
  }

  const started = Date.now()
  const result = await applyDiff({
    pbf: values.pbf,
    osc: values.osc,
    state: Number(values.state),
    tiles: values.tiles,
    outPbf: values['out-pbf'],
    allowGap: values['allow-gap'],
    builtAt: values['built-at'],
    // Same default as enrich-region: DEM ON, cache under data/ (gitignored).
    dem: values['no-dem'] ? undefined : { cacheDir: values['dem-cache'] ?? 'data/dem-cache' },
  })
  console.log(
    `[apply-diff] seq ${result.baseSeq} -> ${result.newSeq}: ` +
    `${result.dirtyWayIds.length} dirty ways, ${result.dirtyControlNodeIds.length} dirty control nodes, ` +
    `${result.rippledWayIds.length} rippled (component-scoped), ` +
    `${result.tilesWritten.length} tiles written, ${result.tilesDeleted.length} deleted, ` +
    `${result.tilesUnchanged} unchanged, in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  )
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[apply-diff] FAILED:', err)
    process.exit(1)
  })
}
