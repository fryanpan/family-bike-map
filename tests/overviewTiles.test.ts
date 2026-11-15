import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  _resetOverviewCache,
  fetchOverviewTile,
  getCachedOverviewCell,
  getVisibleOverviewCells,
  isOverviewCellKey,
  latLngToOverviewCell,
  overviewCellForTile,
  overviewCellKey,
} from '../src/services/overviewTiles'
import { tileKey } from '../src/services/overpass'
import {
  MAX_OVERVIEW_TILES,
  OVERVIEW_TILE_DEGREES,
  selectFetchTiles,
  type Tile,
} from '../src/utils/overlayZoom'

const origFetch = globalThis.fetch

beforeEach(() => _resetOverviewCache())
afterEach(() => { globalThis.fetch = origFetch })

function mockFetch(handler: (url: string) => Response): string[] {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    return handler(url)
  }) as unknown as typeof globalThis.fetch
  return calls
}

const OVERVIEW_PAYLOAD = {
  meta: { builtFromSeq: 2776, builtAt: 'x', pipelineVersion: '1', demSource: 'terrarium-v1' },
  ways: [
    {
      osmId: 1, itemName: null, tags: { highway: 'cycleway' },
      coordinates: [[37.8, -122.4], [37.9, -122.3]],
      gradientPct: 2.1, accessGradientPct: 1.0, componentPaintedLenM: 8000,
    },
  ],
}

describe('overview cell grid', () => {
  it('floors lat/lng to integer degrees', () => {
    expect(latLngToOverviewCell(37.77, -122.42)).toEqual({ row: 37, col: -123 })
    expect(latLngToOverviewCell(52.52, 13.4)).toEqual({ row: 52, col: 13 })
    expect(latLngToOverviewCell(-0.5, -0.5)).toEqual({ row: -1, col: -1 })
  })

  it('maps a 0.1° detail tile to its parent cell (10x10 tiles per cell)', () => {
    // SF's central detail tile 377:-1223 sits in cell 37:-123.
    expect(overviewCellForTile(377, -1223)).toEqual({ row: 37, col: -123 })
    expect(overviewCellForTile(370, -1230)).toEqual({ row: 37, col: -123 })
    expect(overviewCellForTile(379, -1221)).toEqual({ row: 37, col: -123 })
    // ...and the neighbouring tile rows/cols land in the neighbouring cells.
    expect(overviewCellForTile(380, -1220)).toEqual({ row: 38, col: -122 })
    // Negative cols floor toward -inf, not toward zero.
    expect(overviewCellForTile(377, -1231)).toEqual({ row: 37, col: -124 })
  })

  it('every parent cell of a tile inside a cell is that cell', () => {
    for (let r = 370; r <= 379; r++) {
      for (let c = -1230; c <= -1221; c++) {
        expect(overviewCellForTile(r, c)).toEqual({ row: 37, col: -123 })
      }
    }
  })

  it('enumerates every cell intersecting the bounds', () => {
    const bounds = {
      getSouth: () => 37.2, getNorth: () => 38.9,
      getWest: () => -122.8, getEast: () => -121.4,
    }
    const cells = getVisibleOverviewCells(bounds)
    expect(cells).toHaveLength(4) // rows 37,38 × cols -123,-122
    expect(cells).toContainEqual({ row: 37, col: -123 })
    expect(cells).toContainEqual({ row: 38, col: -122 })
  })

  it('namespaces its keys away from the 0.1° tileKey space', () => {
    // Cell (37,-123) and detail tile (37,-123) are different places on Earth.
    expect(overviewCellKey(37, -123)).not.toBe(tileKey(37, -123))
    expect(isOverviewCellKey(overviewCellKey(37, -123))).toBe(true)
    expect(isOverviewCellKey(tileKey(377, -1223))).toBe(false)
  })
})

describe('overview tile selection (determinism)', () => {
  // The overview budget is applied by the SAME selectFetchTiles used at detail
  // zoom, with the 1° grid pitch — a pure function of (tiles, centre, max).
  const cells: Tile[] = []
  for (let r = 30; r < 45; r++) for (let c = -125; c < -115; c++) cells.push({ row: r, col: c })

  it('is a pure function of (tiles, centre) — order-independent', () => {
    const center: [number, number] = [37.5, -122.5]
    const a = selectFetchTiles(cells, center, MAX_OVERVIEW_TILES, OVERVIEW_TILE_DEGREES)
    const shuffled = [...cells].reverse()
    const b = selectFetchTiles(shuffled, center, MAX_OVERVIEW_TILES, OVERVIEW_TILE_DEGREES)
    expect(a).toHaveLength(MAX_OVERVIEW_TILES)
    expect(new Set(a.map((t) => overviewCellKey(t.row, t.col))))
      .toEqual(new Set(b.map((t) => overviewCellKey(t.row, t.col))))
  })

  it('keeps the cells nearest the viewport centre', () => {
    const selected = selectFetchTiles(cells, [37.5, -122.5], 4, OVERVIEW_TILE_DEGREES)
    // Centre 37.5,-122.5 is the exact centre of cell 37,-123 (cell centres are
    // at row+0.5, col+0.5 → 37.5, -122.5).
    expect(selected[0]).toEqual({ row: 37, col: -123 })
    for (const t of selected) {
      expect(Math.abs(t.row - 37)).toBeLessThanOrEqual(1)
      expect(Math.abs(t.col + 123)).toBeLessThanOrEqual(1)
    }
  })

  it('returns every cell unchanged when the viewport fits the budget', () => {
    const few: Tile[] = [{ row: 37, col: -123 }, { row: 38, col: -123 }]
    expect(selectFetchTiles(few, [37.5, -122.5], MAX_OVERVIEW_TILES, OVERVIEW_TILE_DEGREES)).toEqual(few)
  })
})

describe('fetchOverviewTile', () => {
  it('parses a baked cell into OsmWays with the enriched fields intact', async () => {
    const calls = mockFetch(() => new Response(JSON.stringify(OVERVIEW_PAYLOAD), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Tile-Source': 'overview' },
    }))
    const ways = await fetchOverviewTile(37, -123)
    expect(calls[0]).toBe('/api/overview?row=37&col=-123')
    expect(ways).not.toBeNull()
    expect(ways).toHaveLength(1)
    expect(ways![0].gradientPct).toBe(2.1)
    expect(ways![0].componentPaintedLenM).toBe(8000)
    expect(ways![0].tags).toEqual({ highway: 'cycleway' })
  })

  it('returns null on 404 (un-baked region → caller falls back to 0.1° tiles)', async () => {
    mockFetch(() => new Response('overview tile not baked', { status: 404 }))
    expect(await fetchOverviewTile(52, 13)).toBeNull()
  })

  it('remembers a 404 so an un-baked region is not re-probed on every pan', async () => {
    const calls = mockFetch(() => new Response('nope', { status: 404 }))
    await fetchOverviewTile(52, 13)
    await fetchOverviewTile(52, 13)
    await fetchOverviewTile(52, 13)
    expect(calls).toHaveLength(1)
    expect(getCachedOverviewCell(52, 13)).toBeNull()
  })

  it('does NOT cache a transient failure as "un-baked"', async () => {
    let status = 503
    const calls = mockFetch(() => new Response('boom', { status }))
    expect(await fetchOverviewTile(37, -123)).toBeNull()
    expect(getCachedOverviewCell(37, -123)).toBeUndefined() // not remembered

    status = 200
    globalThis.fetch = (async () => new Response(JSON.stringify(OVERVIEW_PAYLOAD), { status: 200 })) as unknown as typeof globalThis.fetch
    const ways = await fetchOverviewTile(37, -123)
    expect(ways).toHaveLength(1)
    expect(calls).toHaveLength(1) // the retry went through the reassigned mock
  })

  it('fails soft to null (never throws) on a network error', async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof globalThis.fetch
    expect(await fetchOverviewTile(37, -123)).toBeNull()
    expect(getCachedOverviewCell(37, -123)).toBeUndefined()
  })

  it('serves a cached cell without a second request', async () => {
    const calls = mockFetch(() => new Response(JSON.stringify(OVERVIEW_PAYLOAD), { status: 200 }))
    await fetchOverviewTile(37, -123)
    const again = await fetchOverviewTile(37, -123)
    expect(calls).toHaveLength(1)
    expect(again).toHaveLength(1)
  })

  it('coalesces concurrent requests for the same cell (both callers see the same verdict)', async () => {
    const calls = mockFetch(() => new Response('nope', { status: 404 }))
    const [a, b] = await Promise.all([fetchOverviewTile(52, 13), fetchOverviewTile(52, 13)])
    expect(calls).toHaveLength(1)
    // Both callers must learn "not baked" — a caller that missed it would skip
    // its 0.1° fallback and paint nothing for that cell.
    expect(a).toBeNull()
    expect(b).toBeNull()
  })
})
