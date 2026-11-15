import { describe, it, expect } from 'bun:test'
import {
  isPaintedPixel, paintedMask, countPainted, comparePaintedMasks,
  type DecodedImage,
} from '../scripts/render-checks/lib/pixels'
import { PATH_LEVEL_LABELS } from '../src/utils/lts'

// PATH_LEVEL_LABELS['1a'].defaultColor is '#004529' — a real overlay tier
// color (see pixels.ts's OVERLAY_PALETTE_HEX). Used directly rather than
// hardcoding a hex string so this test can't silently drift from the
// palette pixels.ts actually matches against.
const BIKE_PATH_COLOR_HEX = PATH_LEVEL_LABELS['1a'].defaultColor

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)!
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

function makeImage(width: number, height: number, fill: (x: number, y: number) => [number, number, number, number]): DecodedImage {
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = fill(x, y)
      const i = (y * width + x) * 4
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a
    }
  }
  return { width, height, data }
}

describe('isPaintedPixel', () => {
  it('matches an exact overlay palette color', () => {
    const [r, g, b] = hexToRgb(BIKE_PATH_COLOR_HEX)
    expect(isPaintedPixel(r, g, b, 255)).toBe(true)
  })

  it('matches a color within tolerance (antialiased edge blend)', () => {
    const [r, g, b] = hexToRgb(BIKE_PATH_COLOR_HEX)
    expect(isPaintedPixel(r + 10, g - 10, b + 5, 255)).toBe(true)
  })

  it('does not match a color far outside tolerance', () => {
    expect(isPaintedPixel(255, 255, 255, 255)).toBe(false) // white — halo/background
  })

  it('does not match the OSM Carto pale-orange road fill despite its high HSL saturation', () => {
    // #fcd6a4 — the false positive a naive saturation heuristic would hit
    // (see pixels.ts's file header). Confirms the palette-match approach
    // avoids it.
    expect(isPaintedPixel(0xfc, 0xd6, 0xa4, 255)).toBe(false)
  })

  it('treats near-transparent pixels as not painted regardless of color', () => {
    const [r, g, b] = hexToRgb(BIKE_PATH_COLOR_HEX)
    expect(isPaintedPixel(r, g, b, 50)).toBe(false)
  })

  it('excludes LTS4 grey (#999999) — grey basemap pixels must not read as painted', () => {
    expect(isPaintedPixel(0x99, 0x99, 0x99, 255)).toBe(false)
  })
})

describe('paintedMask / countPainted', () => {
  it('counts exactly the painted pixels in a small synthetic image', () => {
    const [pr, pg, pb] = hexToRgb(BIKE_PATH_COLOR_HEX)
    // 3x3 image: center pixel painted, everything else white background.
    const img = makeImage(3, 3, (x, y) => (x === 1 && y === 1) ? [pr, pg, pb, 255] : [255, 255, 255, 255])
    const mask = paintedMask(img)
    expect(countPainted(mask)).toBe(1)
    expect(mask[1 * 3 + 1]).toBe(1)
    expect(mask[0]).toBe(0)
  })
})

describe('comparePaintedMasks', () => {
  const W = 10, H = 10
  function maskFromPoints(points: Array<[number, number]>): Uint8Array {
    const mask = new Uint8Array(W * H)
    for (const [x, y] of points) mask[y * W + x] = 1
    return mask
  }

  it('reports identical masks as fully agreeing', () => {
    const mask = maskFromPoints([[5, 5], [5, 6], [6, 5]])
    const cmp = comparePaintedMasks(mask, mask, W, H)
    expect(cmp.onlyInA).toBe(0)
    expect(cmp.onlyInB).toBe(0)
    expect(cmp.paintedInA).toBe(3)
    expect(cmp.paintedInB).toBe(3)
  })

  it('a pixel shifted by 1px within the dilation radius does NOT count as vanished', () => {
    const maskA = maskFromPoints([[5, 5]])
    const maskB = maskFromPoints([[6, 5]]) // 1px over — within default radius 2
    const cmp = comparePaintedMasks(maskA, maskB, W, H)
    expect(cmp.onlyInA).toBe(0)
    expect(cmp.onlyInB).toBe(0)
  })

  it('a pixel that moves beyond the dilation radius DOES count as vanished/appeared', () => {
    const maskA = maskFromPoints([[5, 5]])
    const maskB = maskFromPoints([[9, 5]]) // 4px away — outside default radius 2
    const cmp = comparePaintedMasks(maskA, maskB, W, H)
    expect(cmp.onlyInA).toBe(1) // A's pixel has nothing nearby in B
    expect(cmp.onlyInB).toBe(1) // B's pixel has nothing nearby in A
  })

  it('ADDED paint (present in B, absent in A) counts as onlyInB, not onlyInA', () => {
    // The TIME-STABILITY check's core distinction: painted-pixels added
    // over time (progressive loading) are fine; the failure mode is only
    // pixels that were painted and then vanished (onlyInA).
    const maskA = maskFromPoints([]) // nothing painted at t0
    const maskB = maskFromPoints([[3, 3], [3, 4]]) // painted by t+15s
    const cmp = comparePaintedMasks(maskA, maskB, W, H)
    expect(cmp.onlyInA).toBe(0) // nothing vanished
    expect(cmp.onlyInB).toBe(2) // this is "added paint", not a failure
  })

  it('throws on mismatched mask/dimension inputs', () => {
    const mask10 = new Uint8Array(W * H)
    const mask5 = new Uint8Array(5 * 5)
    expect(() => comparePaintedMasks(mask10, mask5, W, H)).toThrow()
  })
})
