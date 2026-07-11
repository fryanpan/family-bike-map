import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  buildManifest,
  deriveVersion,
  listTileFiles,
  planUploadOps,
  readDirProvenance,
  runUpload,
  type PutOp,
} from '../../scripts/pipeline/upload-tiles'
import { enrichedTileObjectKey, MANIFEST_KEY, parseManifest } from '../../src/workerEnrichedTiles'

let dir: string

const META = { builtFromSeq: 2776, builtAt: '2026-07-03T04:51:13Z', pipelineVersion: '1', demSource: 'terrarium-v1' }

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-tiles-test-'))
  for (const name of ['377_-1223.json', '377_-1224.json', '378_-1223.json']) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ meta: META, ways: [] }))
  }
  // Non-tile files that must be skipped.
  fs.writeFileSync(path.join(dir, 'region-state.json'), JSON.stringify({ seq: 2800, builtAt: 'x' }))
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'junk')
})

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('listTileFiles', () => {
  test('returns only <row>_<col>.json, sorted', () => {
    expect(listTileFiles(dir).map((e) => e.name)).toEqual([
      '377_-1223.json', '377_-1224.json', '378_-1223.json',
    ])
  })
})

describe('readDirProvenance', () => {
  test('region-state.json seq overrides per-tile meta (post-diff dirs carry mixed seqs)', () => {
    const prov = readDirProvenance(dir, listTileFiles(dir))
    expect(prov.builtFromSeq).toBe(2800)
    expect(prov.pipelineVersion).toBe('1')
    expect(prov.demSource).toBe('terrarium-v1')
  })

  test('falls back to tile meta when no state file exists', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-tiles-fresh-'))
    fs.writeFileSync(path.join(fresh, '1_1.json'), JSON.stringify({ meta: META, ways: [] }))
    expect(readDirProvenance(fresh, listTileFiles(fresh)).builtFromSeq).toBe(2776)
    fs.rmSync(fresh, { recursive: true, force: true })
  })

  test('refuses an empty dir', () => {
    expect(() => readDirProvenance('/nonexistent', [])).toThrow(/no tile files/)
  })
})

describe('deriveVersion', () => {
  test('date + seq; -noseq without provenance', () => {
    const now = new Date('2026-07-03T12:00:00Z')
    expect(deriveVersion(2776, now)).toBe('2026-07-03-seq2776')
    expect(deriveVersion(null, now)).toBe('2026-07-03-noseq')
  })
})

describe('planUploadOps', () => {
  const entries = [
    { name: '377_-1223.json', file: '/t/377_-1223.json' },
    { name: '378_-1223.json', file: '/t/378_-1223.json' },
  ]
  const manifest = buildManifest('v9', { ...META, builtFromSeq: 2800 }, entries.length, '2026-07-03T12:00:00Z')

  test('tile keys use the Worker-shared enrichedTileObjectKey layout', () => {
    const ops = planUploadOps('v9', entries, manifest)
    expect(ops[0]).toEqual({ key: enrichedTileObjectKey('v9', 377, -1223), file: '/t/377_-1223.json' })
    expect(ops[1]).toEqual({ key: enrichedTileObjectKey('v9', 378, -1223), file: '/t/378_-1223.json' })
  })

  test('manifest is the LAST op and round-trips through the Worker parser', () => {
    const ops = planUploadOps('v9', entries, manifest)
    const last = ops[ops.length - 1]
    expect(last.key).toBe(MANIFEST_KEY)
    const parsed = parseManifest(last.body!)
    expect(parsed?.version).toBe('v9')
    expect(parsed?.builtFromSeq).toBe(2800)
    expect(parsed?.tileCount).toBe(2)
  })
})

describe('runUpload', () => {
  const entries = [
    { name: '1_1.json', file: '/t/1_1.json' },
    { name: '1_2.json', file: '/t/1_2.json' },
    { name: '2_1.json', file: '/t/2_1.json' },
  ]
  const manifest = buildManifest('v1', { ...META }, entries.length, 'now')

  test('every tile put completes before the manifest put (atomic cutover barrier)', async () => {
    const order: string[] = []
    const put = async (_bucket: string, op: PutOp) => {
      // Random-ish async delay so concurrent completion order is scrambled.
      await new Promise((r) => setTimeout(r, op.key.length % 3))
      order.push(op.key)
    }
    await runUpload('b', planUploadOps('v1', entries, manifest), { local: true, concurrency: 2, put })
    expect(order).toHaveLength(4)
    expect(order[order.length - 1]).toBe(MANIFEST_KEY)
    expect(new Set(order.slice(0, 3))).toEqual(new Set(entries.map((e) => enrichedTileObjectKey('v1', ...(/^(-?\d+)_(-?\d+)/.exec(e.name)!.slice(1).map(Number) as [number, number])))))
  })

  test('a tile failure aborts BEFORE the manifest put — active tileset stays live', async () => {
    const putKeys: string[] = []
    const put = async (_bucket: string, op: PutOp) => {
      if (op.key.endsWith('1_2.json')) throw new Error('upload failed')
      putKeys.push(op.key)
    }
    await expect(
      runUpload('b', planUploadOps('v1', entries, manifest), { local: true, concurrency: 1, put }),
    ).rejects.toThrow('upload failed')
    expect(putKeys).not.toContain(MANIFEST_KEY)
  })

  test('refuses a plan that does not end with the manifest', async () => {
    const ops = planUploadOps('v1', entries, manifest).slice(0, -1)
    await expect(runUpload('b', ops, { local: true, concurrency: 1, put: async () => {} })).rejects.toThrow(/manifest/)
  })
})
