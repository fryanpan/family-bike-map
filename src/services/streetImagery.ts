/**
 * Picks which street-level image to show for a map point.
 *
 * Google Street View where it has coverage; otherwise the nearest Mapillary
 * image; otherwise nothing. This fills Street View's coverage gaps (alleys,
 * paths, newer developments) so the segment popup no longer shows a blank /
 * gray "no imagery" tile where Google has nothing.
 *
 * Pure orchestration over the two existing data sources — no React, no direct
 * network — so the fallback decision is unit-testable by injecting `deps`.
 */
import { getStreetViewCoverage, getStreetViewUrl } from './streetview'
import { getStreetImage } from './mapillary'

export interface ResolvedImagery {
  /** Which source produced the image, or 'none' if neither has coverage. */
  kind: 'streetview' | 'mapillary' | 'none'
  /** Image URL to render (absent when kind === 'none'). */
  url?: string
  /** Attribution to show beneath the image. Mapillary only — Street View
   *  images carry Google's own baked-in watermark. */
  credit?: string
}

export interface ResolveImageryDeps {
  coverage: (lat: number, lng: number) => Promise<'ok' | 'none'>
  mapillary: (lat: number, lng: number) => Promise<{ thumbUrl: string } | null>
  streetViewUrl: (lat: number, lng: number, opts?: { size?: string }) => string
}

const DEFAULT_DEPS: ResolveImageryDeps = {
  coverage: getStreetViewCoverage,
  mapillary: getStreetImage,
  streetViewUrl: getStreetViewUrl,
}

export async function resolveStreetImagery(
  lat: number,
  lng: number,
  deps: ResolveImageryDeps = DEFAULT_DEPS,
): Promise<ResolvedImagery> {
  const coverage = await deps.coverage(lat, lng)
  if (coverage === 'ok') {
    return { kind: 'streetview', url: deps.streetViewUrl(lat, lng, { size: '400x240' }) }
  }
  const img = await deps.mapillary(lat, lng)
  if (img) return { kind: 'mapillary', url: img.thumbUrl, credit: 'Mapillary' }
  return { kind: 'none' }
}
