// Per-zoom Douglas-Peucker decimation for bike-infra overlay paths.
//
// At Berlin-wide zoom (z=10) a tile can hold 1000+ ways with hundreds
// of vertices each — most of which collapse onto a single screen pixel
// once rendered. Cutting them with DP at a tolerance ≈ 1 px of the
// current zoom drops vertex counts by 80–95% with no visible quality
// loss, keeping the overlay readable at city-overview without dragging
// mobile GPUs.
//
// Powered by simplify-js (1.7 KB, BSD-2). Tolerance is computed in
// degrees so we feed lat/lng directly without a projection step.

import simplify from 'simplify-js'

/**
 * Approximate degrees-per-pixel at a given Web-Mercator zoom level.
 * Uses the canonical square-tile formula:
 *   360 deg / (2^zoom * 256 px-per-tile)
 * That gives us ~0.0014 deg/px at z=10 (Berlin-wide) and ~0.000043
 * deg/px at z=15 (street level).
 */
export function degreesPerPixel(zoom: number): number {
  return 360 / (2 ** zoom * 256)
}

/**
 * Simplify a [lat, lng] polyline at a tolerance derived from the
 * current zoom. `pixelTolerance` controls how many pixels of error are
 * acceptable in the simplified line — 1 px is invisible, 2 px tightens
 * GPU work further with no perceptible loss.
 *
 * Returns the input unchanged at z >= 16 (street level — full detail
 * matters for clicking on individual segments) or when there are <3
 * vertices to simplify.
 */
export function simplifyPath(
  coords: [number, number][],
  zoom: number,
  pixelTolerance = 1.5,
): [number, number][] {
  if (coords.length < 3 || zoom >= 16) return coords
  return simplifyToTolerance(coords, degreesPerPixel(zoom) * pixelTolerance)
}

/**
 * Douglas-Peucker at an explicit tolerance in DEGREES, rather than one derived
 * from a zoom level. Used by the overview-tile bake
 * (scripts/pipeline/bake-overview.ts), which simplifies once, offline, at a
 * tolerance chosen for the overview zoom band — so the bake and the runtime
 * overlay share ONE DP implementation instead of each carrying their own.
 */
export function simplifyToTolerance(
  coords: [number, number][],
  toleranceDegrees: number,
): [number, number][] {
  if (coords.length < 3 || toleranceDegrees <= 0) return coords
  const points = coords.map(([lat, lng]) => ({ x: lng, y: lat }))
  // highQuality=true → Douglas-Peucker. Slower than radial-distance
  // but preserves sharp turns, which we need on bike paths that snake
  // around obstacles.
  const simplified = simplify(points, toleranceDegrees, true)
  return simplified.map((p) => [p.y, p.x] as [number, number])
}
