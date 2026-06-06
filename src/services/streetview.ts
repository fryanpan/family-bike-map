/**
 * Google Street View Static image URL builder.
 *
 * Used by single-image popovers (routing-mode segment click, overlay
 * way click). Server-side key via the Worker proxy at /api/streetview —
 * the browser never sees the Google API key.
 *
 * Bulk image grids (admin AuditSamplesTab + AuditGroupDetail) still use
 * Mapillary because Street View is $7/1000 and audit scans fetch
 * thousands of images per run.
 */

export interface StreetViewOptions {
  /** Image size in pixels, e.g. "400x300". Default 400×300. */
  size?: string
  /** Compass heading 0–360. Omit to let Google pick facing the road. */
  heading?: number
  /** Up/down angle -90 to 90. Default 0 (horizontal). */
  pitch?: number
  /** Field of view 10–120. Default 90. Lower = more zoomed in. */
  fov?: number
}

/**
 * Build a URL that, when loaded as an <img src="">, returns a Google
 * Street View image at the given lat/lng. Nothing is fetched here —
 * this just assembles the proxy URL.
 */
export function getStreetViewUrl(lat: number, lng: number, opts: StreetViewOptions = {}): string {
  const params = new URLSearchParams({
    lat: lat.toFixed(6),
    lng: lng.toFixed(6),
    size: opts.size ?? '400x300',
  })
  if (opts.heading != null) params.set('heading', String(opts.heading))
  if (opts.pitch   != null) params.set('pitch',   String(opts.pitch))
  if (opts.fov     != null) params.set('fov',     String(opts.fov))
  return `/api/streetview?${params}`
}

export type StreetViewCoverage = 'ok' | 'none'

/**
 * Session-lived memo of definitive coverage results, keyed on the quantized
 * point. Coverage is geographically stable, so reopening the same popup (or
 * clicking a neighbouring point) shouldn't re-roundtrip even to the edge
 * cache. Mirrors the IndexedDB cache `mapillary.ts` keeps for the fallback
 * source. Only definitive results are stored — a transient failure stays
 * retryable.
 */
const coverageCache = new Map<string, StreetViewCoverage>()

/**
 * Ask Google (via the Worker's metadata proxy) whether Street View imagery
 * exists near this point. The Static image API returns a generic gray "no
 * imagery" tile for uncovered points, so coverage can't be inferred from the
 * image itself — this metadata check is the only reliable signal. Metadata
 * requests are free, so this adds no billable cost.
 *
 * Returns 'none' on any non-OK outcome (unconfigured key → 503, network
 * error, ZERO_RESULTS) so the caller falls back to Mapillary. Only OK and
 * ZERO_RESULTS are memoized; 503 / network errors stay retryable.
 */
export async function getStreetViewCoverage(lat: number, lng: number): Promise<StreetViewCoverage> {
  const key = `${lat.toFixed(6)},${lng.toFixed(6)}`
  const cached = coverageCache.get(key)
  if (cached !== undefined) return cached
  try {
    const params = new URLSearchParams({ lat: lat.toFixed(6), lng: lng.toFixed(6) })
    const resp = await fetch(`/api/streetview/metadata?${params}`)
    if (!resp.ok) return 'none' // transient / unconfigured — don't memoize
    const body = (await resp.json()) as { status?: string }
    const result: StreetViewCoverage = body.status === 'OK' ? 'ok' : 'none'
    coverageCache.set(key, result)
    return result
  } catch {
    return 'none' // network error — don't memoize, let a later click retry
  }
}

/** Test hook: clear the coverage memo between tests. */
export function __resetCoverageCacheForTests(): void {
  coverageCache.clear()
}
