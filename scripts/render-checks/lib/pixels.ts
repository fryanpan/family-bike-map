// Pixel-level comparison utilities shared by every render check.
//
// "Painted" is defined by exact-ish color match against the overlay's
// known tier palette (colorForLevel's output colors), not a generic
// saturation/lightness heuristic. A saturation heuristic looks appealing
// ("vivid = overlay, muted = basemap") but breaks on OSM Carto's own
// palette: pale road fills like #fcd6a4 have HSL saturation ~0.94 despite
// reading as a washed-out pastel, because HSL saturation isn't lightness-
// normalized. Matching against the real, small, known palette avoids that
// false-positive class entirely and stays exact regardless of which
// raster tiles sit underneath. See README.md for the raster-vs-vector
// basemap scope note.
//
// Calibrated for the Leaflet/OSM-Carto engine, which is what every check
// actually renders under in this harness: `resolveEngine` falls back to
// 'leaflet-osm' whenever VITE_GOOGLE_MAPS_KEY / VITE_MAPTILER_KEY are
// unset (see src/services/mapEngine/resolve.ts), and CI/local render-check
// runs never set those secrets. If a future run wants to cover Google/
// MapTiler basemaps, extend OVERLAY_PALETTE_HEX per README's calibration
// section — don't just widen the tolerance blindly.

import { PNG } from 'pngjs'
import { PATH_LEVEL_LABELS, PATH_LEVELS } from '../../../src/utils/lts'
import { PREFERRED_COLOR, OTHER_COLOR } from '../../../src/utils/classify'

export interface DecodedImage {
  width: number
  height: number
  data: Buffer // RGBA, 4 bytes/pixel, row-major
}

export function decodePng(buffer: Buffer): DecodedImage {
  const png = PNG.sync.read(buffer)
  return { width: png.width, height: png.height, data: png.data }
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) throw new Error(`not a hex color: ${hex}`)
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}

// LTS4 ('4', grey #999999) is excluded — LTS4 ways are never painted by
// the overlay (classifyOsmTagsToItem returns null), so including it would
// make ordinary grey basemap pixels false-positive as "painted."
const OVERLAY_PALETTE_HEX: string[] = [
  ...PATH_LEVELS.filter((l) => l !== '4').map((l) => PATH_LEVEL_LABELS[l].defaultColor),
  PREFERRED_COLOR,
  OTHER_COLOR,
]
const OVERLAY_PALETTE_RGB = OVERLAY_PALETTE_HEX.map(hexToRgb)

/** Euclidean RGB distance a pixel may sit from a palette color and still
 *  count as "painted" — covers antialiased edge pixels (partial coverage
 *  blends the line color toward the background) without matching the
 *  basemap's own (unrelated) colors. */
const DEFAULT_COLOR_TOLERANCE = 45

export function isPaintedPixel(
  r: number, g: number, b: number, a: number,
  tolerance = DEFAULT_COLOR_TOLERANCE,
): boolean {
  if (a < 200) return false // near-transparent — not actually painted
  for (const [pr, pg, pb] of OVERLAY_PALETTE_RGB) {
    const dr = r - pr, dg = g - pg, db = b - pb
    if (Math.sqrt(dr * dr + dg * dg + db * db) <= tolerance) return true
  }
  return false
}

/** Boolean painted-mask over every pixel of the image. */
export function paintedMask(img: DecodedImage, tolerance = DEFAULT_COLOR_TOLERANCE): Uint8Array {
  const mask = new Uint8Array(img.width * img.height)
  for (let i = 0, p = 0; p < mask.length; i += 4, p++) {
    mask[p] = isPaintedPixel(img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3], tolerance) ? 1 : 0
  }
  return mask
}

export function countPainted(mask: Uint8Array): number {
  let n = 0
  for (let i = 0; i < mask.length; i++) n += mask[i]
  return n
}

/**
 * Compare two painted-masks of the same dimensions with a dilation
 * tolerance: a pixel painted in A "survives" in B if ANY pixel within
 * `radiusPx` of the same location is painted in B (absorbs the few-pixel
 * jitter from re-simplified geometry / re-tiled label placement / sub-
 * pixel AA differences between two renders of the "same" viewport).
 *
 * Returns counts, not booleans, so callers can apply their own ratio
 * thresholds (TIME-STABILITY cares only about onlyInA / vanished;
 * DETERMINISM cares about both directions).
 */
export function comparePaintedMasks(
  maskA: Uint8Array, maskB: Uint8Array,
  width: number, height: number,
  radiusPx = 2,
): { paintedInA: number; paintedInB: number; onlyInA: number; onlyInB: number } {
  if (maskA.length !== width * height || maskB.length !== width * height) {
    throw new Error('mask/dimension mismatch')
  }

  const survivesNearby = (mask: Uint8Array, x: number, y: number): boolean => {
    for (let dy = -radiusPx; dy <= radiusPx; dy++) {
      const ny = y + dy
      if (ny < 0 || ny >= height) continue
      for (let dx = -radiusPx; dx <= radiusPx; dx++) {
        const nx = x + dx
        if (nx < 0 || nx >= width) continue
        if (mask[ny * width + nx]) return true
      }
    }
    return false
  }

  let paintedInA = 0, paintedInB = 0, onlyInA = 0, onlyInB = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      const a = maskA[idx], b = maskB[idx]
      if (a) paintedInA++
      if (b) paintedInB++
      if (a && !survivesNearby(maskB, x, y)) onlyInA++
      if (b && !survivesNearby(maskA, x, y)) onlyInB++
    }
  }
  return { paintedInA, paintedInB, onlyInA, onlyInB }
}
