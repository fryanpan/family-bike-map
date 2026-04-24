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
