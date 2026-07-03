import { beforeEach, describe, expect, test } from 'bun:test'

import {
  _resetManifestCache,
  enrichedTileObjectKey,
  getEnrichedTileResponse,
  MANIFEST_KEY,
  MANIFEST_TTL_MS,
  parseManifest,
  parseTileCoord,
  type R2BucketLike,
  type R2ObjectBodyLike,
} from '../src/workerEnrichedTiles'
import { tileFileName } from '../scripts/pipeline/lib/tiles'

// ── Fake R2 bucket ──────────────────────────────────────────────────────────

function makeBucket(objects: Record<string, string>) {
  const getCalls: string[] = []
  const bucket: R2BucketLike = {
    async get(key: string): Promise<R2ObjectBodyLike | null> {
      getCalls.push(key)
      if (!(key in objects)) return null
      const content = objects[key]
      return {
        body: new Response(content).body,
        text: async () => content,
      }
    },
  }
  return { bucket, getCalls, objects }
}

const MANIFEST = JSON.stringify({ version: '2026-07-03-seq2776', builtFromSeq: 2776 })
const TILE_BODY = JSON.stringify({ meta: { builtFromSeq: 2776 }, ways: [] })

beforeEach(() => _resetManifestCache())

// ── parseTileCoord ──────────────────────────────────────────────────────────

describe('parseTileCoord', () => {
  test('accepts plain integers, including negatives', () => {
    expect(parseTileCoord('377')).toBe(377)
    expect(parseTileCoord('-1223')).toBe(-1223)
    expect(parseTileCoord('0')).toBe(0)
  })

  test('rejects anything that is not a plain integer', () => {
    for (const bad of [null, '', ' 3', '3 ', '1.5', '1e3', 'abc', '12x', '--3', '+3']) {
      expect(parseTileCoord(bad)).toBeNull()
    }
  })
})

// ── enrichedTileObjectKey ───────────────────────────────────────────────────

describe('enrichedTileObjectKey', () => {
  test('layout is <version>/<row>_<col>.json', () => {
    expect(enrichedTileObjectKey('v1', 377, -1223)).toBe('v1/377_-1223.json')
  })

  test('file part matches the pipeline emitter tileFileName — writer and reader share one naming', () => {
    for (const [row, col] of [[377, -1223], [-5, 12], [0, 0]] as const) {
      expect(enrichedTileObjectKey('x', row, col)).toBe(`x/${tileFileName(row, col)}`)
    }
  })
})

// ── parseManifest ───────────────────────────────────────────────────────────

describe('parseManifest', () => {
  test('accepts a manifest with a plain version string', () => {
    expect(parseManifest(MANIFEST)?.version).toBe('2026-07-03-seq2776')
  })

  test('rejects malformed or unsafe manifests (fail-open to Overpass)', () => {
    expect(parseManifest('not json')).toBeNull()
    expect(parseManifest('42')).toBeNull()
    expect(parseManifest('null')).toBeNull()
    expect(parseManifest('{}')).toBeNull()
    expect(parseManifest('{"version": 3}')).toBeNull()
    expect(parseManifest('{"version": ""}')).toBeNull()
    expect(parseManifest('{"version": "/abs"}')).toBeNull()
    expect(parseManifest('{"version": "v1/"}')).toBeNull()
    expect(parseManifest('{"version": "../escape"}')).toBeNull()
  })
})

// ── getEnrichedTileResponse ─────────────────────────────────────────────────

describe('getEnrichedTileResponse', () => {
  test('serves the tile named by the active manifest, with identifying headers', async () => {
    const { bucket } = makeBucket({
      [MANIFEST_KEY]: MANIFEST,
      '2026-07-03-seq2776/377_-1223.json': TILE_BODY,
    })
    const resp = await getEnrichedTileResponse(bucket, 377, -1223)
    expect(resp).not.toBeNull()
    expect(await resp!.text()).toBe(TILE_BODY)
    expect(resp!.headers.get('Content-Type')).toBe('application/json')
    expect(resp!.headers.get('X-Tile-Source')).toBe('enriched')
    expect(resp!.headers.get('X-Cache')).toBe('R2')
    expect(resp!.headers.get('X-Enriched-Version')).toBe('2026-07-03-seq2776')
  })

  test('tile absent from the active version → null (falls through to Overpass)', async () => {
    const { bucket } = makeBucket({ [MANIFEST_KEY]: MANIFEST })
    expect(await getEnrichedTileResponse(bucket, 999, 999)).toBeNull()
  })

  test('no manifest → null, and the absence is cached (one manifest GET per TTL, zero tile GETs)', async () => {
    const { bucket, getCalls } = makeBucket({})
    expect(await getEnrichedTileResponse(bucket, 377, -1223, { now: 1000 })).toBeNull()
    expect(await getEnrichedTileResponse(bucket, 378, -1223, { now: 1001 })).toBeNull()
    expect(getCalls).toEqual([MANIFEST_KEY])
  })

  test('manifest is cached across tile requests within the TTL and refetched after it', async () => {
    const { bucket, getCalls } = makeBucket({
      [MANIFEST_KEY]: MANIFEST,
      '2026-07-03-seq2776/377_-1223.json': TILE_BODY,
      '2026-07-03-seq2776/378_-1223.json': TILE_BODY,
    })
    await getEnrichedTileResponse(bucket, 377, -1223, { now: 1000 })
    await getEnrichedTileResponse(bucket, 378, -1223, { now: 1000 + MANIFEST_TTL_MS - 1 })
    expect(getCalls.filter((k) => k === MANIFEST_KEY)).toHaveLength(1)

    await getEnrichedTileResponse(bucket, 377, -1223, { now: 1000 + MANIFEST_TTL_MS })
    expect(getCalls.filter((k) => k === MANIFEST_KEY)).toHaveLength(2)
  })

  test('manifest cutover is picked up after the TTL (rollback path)', async () => {
    const { bucket, objects } = makeBucket({
      [MANIFEST_KEY]: MANIFEST,
      '2026-07-03-seq2776/377_-1223.json': TILE_BODY,
      'prev-version/377_-1223.json': JSON.stringify({ meta: {}, ways: [{ osmId: 1 }] }),
    })
    const first = await getEnrichedTileResponse(bucket, 377, -1223, { now: 0 })
    expect(first!.headers.get('X-Enriched-Version')).toBe('2026-07-03-seq2776')

    objects[MANIFEST_KEY] = JSON.stringify({ version: 'prev-version' })
    const after = await getEnrichedTileResponse(bucket, 377, -1223, { now: MANIFEST_TTL_MS + 1 })
    expect(after!.headers.get('X-Enriched-Version')).toBe('prev-version')
  })

  test('malformed manifest → null', async () => {
    const { bucket } = makeBucket({
      [MANIFEST_KEY]: '{"nope": true}',
      'v/377_-1223.json': TILE_BODY,
    })
    expect(await getEnrichedTileResponse(bucket, 377, -1223)).toBeNull()
  })

  test('R2 errors fail open (null) and report via onError', async () => {
    const boom = new Error('r2 down')
    const bucket: R2BucketLike = { get: async () => { throw boom } }
    const seen: unknown[] = []
    const resp = await getEnrichedTileResponse(bucket, 377, -1223, { onError: (e) => seen.push(e) })
    expect(resp).toBeNull()
    expect(seen).toEqual([boom])
  })
})
