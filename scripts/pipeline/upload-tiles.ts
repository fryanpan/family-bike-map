// Enriched-tiles → R2 upload with atomic manifest cutover (chunk C3).
//
//   bun scripts/pipeline/upload-tiles.ts --tiles data/tiles/bayarea-core \
//       [--version 2026-07-03-seq2776] [--bucket bike-map-enriched-tiles] \
//       [--local] [--dry-run] [--concurrency 4]
//
// Uploads every `<row>_<col>.json` in the tile dir to
// `<bucket>/<version>/<row>_<col>.json` via `wrangler r2 object put`, plus —
// when the tile dir has an `overview/` subdir (scripts/pipeline/bake-overview.ts)
// — every 1.0° overview cell to `<bucket>/<version>/overview/<row>_<col>.json`.
// Then, only after EVERY tile of BOTH levels succeeded, writes `manifest.json`
// naming the new version. The Worker (src/workerEnrichedTiles.ts) resolves tiles through the
// manifest, so readers never observe a half-uploaded tileset: cutover is the
// single manifest put.
//
// Rollback: re-run with `--rollback-to <previous-version>` — it rewrites ONLY
// the manifest to point at the still-present previous prefix. No deploy, no
// tile re-upload; live within the Worker's 60s manifest cache TTL.
//
// Naming is shared with the Worker: object keys come from
// enrichedTileObjectKey() in src/workerEnrichedTiles.ts — writer and reader
// cannot drift onto different layouts.
//
// `--local` targets miniflare's local R2 (`.wrangler/state`), used to seed a
// `wrangler dev --local` session; the default is `--remote` (the real bucket).

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { parseArgs } from 'node:util'

import {
  enrichedTileObjectKey, overviewTileObjectKey, OVERVIEW_PREFIX,
  MANIFEST_KEY, type EnrichedManifest,
} from '../../src/workerEnrichedTiles'
import { REGION_STATE_FILE, type RegionState } from './apply-diff'
import type { EnrichedTile } from './lib/tiles'

const TILE_FILE_RE = /^-?\d+_-?\d+\.json$/

export const DEFAULT_BUCKET = 'bike-map-enriched-tiles'

export interface TileFileEntry {
  /** File name inside the tile dir, e.g. "377_-1223.json". */
  name: string
  /** Absolute path to the file. */
  file: string
}

/** Tile JSONs in a dir (skips region-state.json and anything non-tile), sorted for a stable upload order. */
export function listTileFiles(dir: string): TileFileEntry[] {
  return fs
    .readdirSync(dir)
    .filter((name) => TILE_FILE_RE.test(name))
    .sort()
    .map((name) => ({ name, file: path.join(dir, name) }))
}

/**
 * Baked 1.0° overview cells in the tile dir's `overview/` subdir (empty when
 * the region has no overview bake — the client then falls back to 0.1° tiles).
 * Both levels ship under ONE version prefix, so `--rollback-to` reverts them
 * together in a single manifest write.
 */
export function listOverviewFiles(dir: string): TileFileEntry[] {
  const sub = path.join(dir, OVERVIEW_PREFIX)
  if (!fs.existsSync(sub)) return []
  return listTileFiles(sub)
}

export interface DirProvenance {
  builtFromSeq: number | null
  builtAt: string
  pipelineVersion: string
  demSource: string | null
}

/**
 * Provenance for the manifest (bookkeeping only — the Worker reads nothing but
 * `version`). Sequence: region-state.json when present (post-diff dirs carry
 * mixed per-tile seqs), else the first tile's meta.
 */
export function readDirProvenance(dir: string, entries: TileFileEntry[]): DirProvenance {
  if (entries.length === 0) throw new Error(`no tile files (<row>_<col>.json) found in ${dir}`)
  const first = JSON.parse(fs.readFileSync(entries[0].file, 'utf8')) as EnrichedTile
  let seq = first.meta.builtFromSeq
  const stateFile = path.join(dir, REGION_STATE_FILE)
  if (fs.existsSync(stateFile)) {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Partial<RegionState>
    if (Number.isInteger(state.seq)) seq = state.seq as number
  }
  return {
    builtFromSeq: seq,
    builtAt: first.meta.builtAt,
    pipelineVersion: first.meta.pipelineVersion,
    demSource: first.meta.demSource,
  }
}

/**
 * Default version prefix: date + replication sequence ("2026-07-03-seq2776").
 * Re-uploading the same seq on the same day overwrites that prefix in place —
 * pass an explicit --version when you need a distinct prefix (e.g. a re-bake
 * with changed pipeline code at the same OSM sequence).
 */
export function deriveVersion(builtFromSeq: number | null, now: Date): string {
  const date = now.toISOString().slice(0, 10)
  return builtFromSeq != null ? `${date}-seq${builtFromSeq}` : `${date}-noseq`
}

export function buildManifest(
  version: string,
  prov: DirProvenance,
  tileCount: number,
  uploadedAt: string,
  overviewTileCount = 0,
): EnrichedManifest {
  return {
    version,
    builtFromSeq: prov.builtFromSeq,
    pipelineVersion: prov.pipelineVersion,
    demSource: prov.demSource,
    tileCount,
    overviewTileCount,
    uploadedAt,
  }
}

export interface PutOp {
  /** Object key inside the bucket. */
  key: string
  /** File to upload (tiles) … */
  file?: string
  /** … or an inline body (manifest — serialized at plan time). */
  body?: string
}

function tileCoords(name: string): { row: number; col: number } {
  const m = /^(-?\d+)_(-?\d+)\.json$/.exec(name)!
  return { row: Number(m[1]), col: Number(m[2]) }
}

/**
 * Ordered upload plan: all 0.1° tile puts, then all 1.0° overview puts, then
 * the manifest put LAST. The runner must preserve this barrier (tiles may
 * upload concurrently; the manifest only goes up after every tile succeeded) —
 * that ordering IS the atomic cutover, and it now covers BOTH levels: the
 * manifest flip publishes detail + overview together, and `--rollback-to`
 * reverts both.
 */
export function planUploadOps(
  version: string,
  entries: TileFileEntry[],
  manifest: EnrichedManifest,
  overviewEntries: TileFileEntry[] = [],
): PutOp[] {
  const ops: PutOp[] = entries.map((e) => {
    const { row, col } = tileCoords(e.name)
    return { key: enrichedTileObjectKey(version, row, col), file: e.file }
  })
  for (const e of overviewEntries) {
    const { row, col } = tileCoords(e.name)
    ops.push({ key: overviewTileObjectKey(version, row, col), file: e.file })
  }
  ops.push({ key: MANIFEST_KEY, body: JSON.stringify(manifest) + '\n' })
  return ops
}

// ── Runner ────────────────────────────────────────────────────────────────

const PUT_MAX_ATTEMPTS = 5

/** One wrangler put, retried with exponential backoff on transient failures. */
async function wranglerPut(bucket: string, op: PutOp, local: boolean): Promise<void> {
  let lastErr: unknown
  for (let attempt = 1; attempt <= PUT_MAX_ATTEMPTS; attempt++) {
    try {
      return await wranglerPutOnce(bucket, op, local)
    } catch (err) {
      lastErr = err
      if (attempt < PUT_MAX_ATTEMPTS) {
        const backoffMs = 500 * 2 ** (attempt - 1) // 0.5s, 1s, 2s, 4s
        console.warn(`  retry ${attempt}/${PUT_MAX_ATTEMPTS - 1} for ${op.key} after ${backoffMs}ms: ${String(err).split('\n')[0]}`)
        await new Promise((r) => setTimeout(r, backoffMs))
      }
    }
  }
  throw lastErr
}

function wranglerPutOnce(bucket: string, op: PutOp, local: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let file = op.file
    let tmp: string | null = null
    if (!file) {
      tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'upload-tiles-')), 'manifest.json')
      fs.writeFileSync(tmp, op.body ?? '')
      file = tmp
    }
    const args = [
      'wrangler', 'r2', 'object', 'put', `${bucket}/${op.key}`,
      '--file', file,
      '--content-type', 'application/json',
      local ? '--local' : '--remote',
    ]
    const child = spawn('bunx', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('error', reject)
    child.on('close', (code) => {
      if (tmp) fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
      if (code === 0) resolve()
      else reject(new Error(`wrangler r2 object put ${op.key} failed (exit ${code}):\n${out}`))
    })
  })
}

/** Run tile puts with bounded concurrency; the manifest (last op) strictly after all tiles. */
export async function runUpload(
  bucket: string,
  ops: PutOp[],
  opts: { local: boolean; concurrency: number; put?: typeof wranglerPut },
): Promise<void> {
  const put = opts.put ?? wranglerPut
  const tiles = ops.slice(0, -1)
  const manifestOp = ops[ops.length - 1]
  if (manifestOp.key !== MANIFEST_KEY) throw new Error('upload plan must end with the manifest put')

  let next = 0
  let done = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= tiles.length) return
      await put(bucket, tiles[i], opts.local)
      done++
      if (done % 25 === 0 || done === tiles.length) {
        console.log(`  ${done}/${tiles.length} tiles uploaded`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker))

  // All tiles are in place — flip the manifest. This is the cutover.
  await put(bucket, manifestOp, opts.local)
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tiles: { type: 'string' },
      bucket: { type: 'string', default: DEFAULT_BUCKET },
      version: { type: 'string' },
      'rollback-to': { type: 'string' },
      local: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      concurrency: { type: 'string', default: '4' },
    },
  })

  const bucket = values.bucket!
  const local = values.local!
  const uploadedAt = new Date().toISOString()

  // Rollback path: rewrite ONLY the manifest to a previous (still-uploaded)
  // version prefix. Tile provenance fields are omitted — the authoritative
  // values live in the tiles themselves.
  if (values['rollback-to']) {
    const manifest: EnrichedManifest = { version: values['rollback-to'], uploadedAt }
    console.log(`Rolling back manifest → version "${manifest.version}" (${local ? 'local' : 'remote'} ${bucket})`)
    if (values['dry-run']) { console.log('(dry-run) skipped'); return }
    await wranglerPut(bucket, { key: MANIFEST_KEY, body: JSON.stringify(manifest) + '\n' }, local)
    console.log('Done. Worker picks it up within the 60s manifest cache TTL.')
    return
  }

  if (!values.tiles) {
    console.error('usage: bun scripts/pipeline/upload-tiles.ts --tiles <dir> [--version v] [--bucket b] [--local] [--dry-run] [--concurrency n]')
    console.error('       bun scripts/pipeline/upload-tiles.ts --rollback-to <previous-version> [--bucket b] [--local]')
    process.exit(2)
  }

  const dir = path.resolve(values.tiles)
  const entries = listTileFiles(dir)
  const overviewEntries = listOverviewFiles(dir)
  const prov = readDirProvenance(dir, entries)
  const version = values.version ?? deriveVersion(prov.builtFromSeq, new Date())
  const manifest = buildManifest(version, prov, entries.length, uploadedAt, overviewEntries.length)
  const ops = planUploadOps(version, entries, manifest, overviewEntries)

  console.log(`Uploading ${entries.length} tiles + ${overviewEntries.length} overview cells from ${dir}`)
  console.log(`  bucket:  ${bucket} (${local ? 'local miniflare' : 'remote R2'})`)
  console.log(`  version: ${version}  (builtFromSeq ${prov.builtFromSeq ?? 'null'})`)
  if (values['dry-run']) {
    for (const op of ops) console.log(`  put ${op.key}${op.file ? ` ← ${op.file}` : ' (manifest, LAST)'}`)
    console.log('(dry-run) nothing uploaded; manifest untouched')
    return
  }

  await runUpload(bucket, ops, { local, concurrency: Number(values.concurrency) || 4 })
  console.log(`Cutover complete: manifest.json → "${version}". Rollback: --rollback-to <previous-version>.`)
}

if (import.meta.main) {
  main().catch((err) => {
    // A failure before the manifest put leaves the ACTIVE manifest untouched —
    // readers keep the previous version; re-run to resume (puts are idempotent).
    console.error(String(err?.stack ?? err))
    console.error('Upload aborted BEFORE the manifest cutover — the previously active tileset is still being served.')
    process.exit(1)
  })
}
