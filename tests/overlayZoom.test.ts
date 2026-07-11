import { describe, it, expect } from 'bun:test'
import {
  overviewStyle,
  selectFetchTiles,
  MAX_FETCH_TILES,
  OVERVIEW_MAX_ZOOM,
  type Tile,
} from '../src/utils/overlayZoom'

describe('overviewStyle', () => {
  it('is the identity style at and above the overview cutoff', () => {
    for (const zoom of [OVERVIEW_MAX_ZOOM, 13, 14, 15, 16, 18]) {
      expect(overviewStyle(zoom)).toEqual({
        drawHalo: true,
        interactive: true,
        strokeScale: 1,
      })
    }
  })

  it('strips halo + interactivity and thins strokes below the cutoff', () => {
    for (const zoom of [OVERVIEW_MAX_ZOOM - 1, 10, 9, 5]) {
      const s = overviewStyle(zoom)
      expect(s.drawHalo).toBe(false)
      expect(s.interactive).toBe(false)
      expect(s.strokeScale).toBeLessThan(1)
      expect(s.strokeScale).toBeGreaterThan(0)
    }
  })

  it('is a pure function of zoom (no z14+ regression boundary)', () => {
    // The boundary must sit strictly below the metro zooms that already
    // worked, so z12/z13/z14 are untouched (full halo + interactivity).
    expect(overviewStyle(11).drawHalo).toBe(false)
    expect(overviewStyle(12).drawHalo).toBe(true)
    expect(overviewStyle(14).drawHalo).toBe(true)
  })
})

describe('selectFetchTiles', () => {
  const center: [number, number] = [37.77, -122.43] // central SF

  function grid(rows: [number, number], cols: [number, number]): Tile[] {
    const out: Tile[] = []
    for (let r = rows[0]; r <= rows[1]; r++)
      for (let c = cols[0]; c <= cols[1]; c++) out.push({ row: r, col: c })
    return out
  }

  it('returns every tile unchanged when at or under budget', () => {
    const tiles = grid([377, 378], [-1226, -1224]) // 6 tiles
    expect(selectFetchTiles(tiles, center, 64)).toEqual(tiles)
    expect(selectFetchTiles(tiles, center, 6)).toEqual(tiles)
  })

  it('caps to the budget when over it', () => {
    const tiles = grid([370, 385], [-1235, -1220]) // 16 x 16 = 256 tiles
    const picked = selectFetchTiles(tiles, center, 64)
    expect(picked.length).toBe(64)
  })

  it('keeps the tiles nearest the viewport centre', () => {
    const tiles = grid([370, 385], [-1235, -1220])
    const picked = selectFetchTiles(tiles, center, 12)
    // The tile containing the centre (row 377, col -1225) must be selected.
    expect(picked.some((t) => t.row === 377 && t.col === -1225)).toBe(true)
    // A far-corner tile must NOT be selected.
    expect(picked.some((t) => t.row === 385 && t.col === -1235)).toBe(false)
  })

  it('is deterministic: independent of input order (the history-independence invariant)', () => {
    const tiles = grid([370, 385], [-1235, -1220])
    const shuffled = [...tiles].reverse()
    const a = selectFetchTiles(tiles, center, 40)
    const b = selectFetchTiles(shuffled, center, 40)
    const key = (t: Tile) => `${t.row}:${t.col}`
    expect(new Set(a.map(key))).toEqual(new Set(b.map(key)))
    // Same order too — the sort is fully specified (distance then row/col).
    expect(a.map(key)).toEqual(b.map(key))
  })

  it('does not mutate its input array', () => {
    const tiles = grid([370, 385], [-1235, -1220])
    const snapshot = tiles.map((t) => `${t.row}:${t.col}`)
    selectFetchTiles(tiles, center, 40)
    expect(tiles.map((t) => `${t.row}:${t.col}`)).toEqual(snapshot)
  })

  it('defaults to MAX_FETCH_TILES', () => {
    const tiles = grid([360, 395], [-1245, -1210]) // large
    expect(selectFetchTiles(tiles, center).length).toBe(MAX_FETCH_TILES)
  })
})
