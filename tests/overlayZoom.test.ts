import { describe, it, expect } from 'bun:test'
import {
  overviewStyle,
  selectFetchTiles,
  MAX_FETCH_TILES,
  OVERVIEW_MAX_ZOOM,
  OVERVIEW_TILE_DEGREES,
  type Tile,
} from '../src/utils/overlayZoom'
import { nextActiveKeys } from '../src/components/BikeMapOverlay'

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

describe('selectFetchTiles — grid pitch', () => {
  it('defaults to the 0.1° detail grid (behaviour unchanged for detail tiles)', () => {
    const tiles: Tile[] = []
    for (let r = 370; r < 390; r++) for (let c = -1230; c < -1210; c++) tiles.push({ row: r, col: c })
    const center: [number, number] = [37.75, -122.45]
    const withDefault = selectFetchTiles(tiles, center, MAX_FETCH_TILES)
    const withExplicit = selectFetchTiles(tiles, center, MAX_FETCH_TILES, 0.1)
    expect(withDefault).toEqual(withExplicit)
    // Centre tile of the SF viewport is in the selection.
    expect(withDefault).toContainEqual({ row: 377, col: -1225 })
  })

  it('uses the 1.0° pitch for overview cells — the same centre picks different rows', () => {
    const cells: Tile[] = []
    for (let r = 35; r < 40; r++) for (let c = -125; c < -120; c++) cells.push({ row: r, col: c })
    const selected = selectFetchTiles(cells, [37.75, -122.45], 2, OVERVIEW_TILE_DEGREES)
    expect(selected[0]).toEqual({ row: 37, col: -123 })
  })
})

// ── Active-key swap guard (BikeMapOverlay.nextActiveKeys) ───────────────────
//
// Paint is scoped to the active key set and the overlay unmounts when that set
// has no ways, so naming a new selection before its data lands blanks the map
// for a round-trip — which is exactly what a zoom-out across OVERVIEW_MAX_ZOOM
// (drop detail keys, name overview keys) or a cold pan does.

describe('nextActiveKeys', () => {
  const loaded = (...keys: string[]) => (k: string) => keys.includes(k)

  it('swaps immediately when ANY key of the new selection has data (progressive pop-in)', () => {
    const prev = ['377:-1223', '377:-1224']
    const next = ['377:-1224', '377:-1225', '378:-1225']
    // A same-level pan overlaps: 377:-1224 is already loaded.
    expect(nextActiveKeys(prev, next, loaded('377:-1224'))).toEqual(next)
  })

  it('RETAINS the previous keys when nothing in the new selection has data yet', () => {
    // The level swap: z12 → z11 drops the detail keys and names overview cells
    // that have not been fetched. Un-guarded, this is a blank map.
    const prev = ['377:-1223', '377:-1224']
    const next = ['ov:37:-123', 'ov:38:-123']
    expect(nextActiveKeys(prev, next, loaded('377:-1223'))).toEqual(prev)
    // ...and a cold pan into never-loaded territory, at the same level.
    expect(nextActiveKeys(prev, ['400:-1300'], loaded('377:-1223'))).toEqual(prev)
  })

  it('lands on EXACTLY the new selection once its data arrives — no leftovers from the old level', () => {
    const prev = ['377:-1223', '377:-1224']
    const next = ['ov:37:-123', 'ov:38:-123']
    // First overview cell lands → swap, and the detail keys are gone.
    const after = nextActiveKeys(prev, next, loaded('377:-1223', 'ov:37:-123'))
    expect(after).toEqual(next)
    expect(after.some((k) => prev.includes(k))).toBe(false)
  })

  it('never paints both key sets at once (the result is one selection or the other)', () => {
    const prev = ['377:-1223']
    const next = ['ov:37:-123']
    for (const has of [loaded(), loaded('ov:37:-123')]) {
      const result = nextActiveKeys(prev, next, has)
      expect(result === prev || result === next).toBe(true)
    }
  })

  it('an empty new selection cannot blank the map on its own', () => {
    const prev = ['377:-1223']
    expect(nextActiveKeys(prev, [], loaded('377:-1223'))).toEqual(prev)
  })
})
