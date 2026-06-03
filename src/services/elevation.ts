/**
 * Elevation lookup via Mapbox terrain-RGB tiles.
 *
 * Tiles are fetched once per session and cached in memory as decoded
 * pixel arrays. `prefetchElevation(bbox)` is awaited up-front by the
 * router before graph construction; `lookupElevation(lat, lng)` is then
 * a synchronous nearest-pixel read inside the graph builder.
 *
 * Fails soft: if the Mapbox token is missing, or a tile 404s, the
 * lookup returns null for any coord it can't resolve. Callers (the
 * gradient gate in clientRouter) skip the cap when elevation is null,
 * so the absence of elevation degrades gracefully to "no gradient
 * filter" rather than blocking routes.
 *
 * Reference: https://docs.mapbox.com/data/tilesets/reference/mapbox-terrain-rgb-v1/
 *   height (m) = -10000 + ((R*256*256 + G*256 + B) * 0.1)
 *
 * History: started on MapTiler terrain-rgb at z=12, swapped to Mapbox
 * 2026-05-26 because MapTiler caps at z=12 and the ±10 m inter-pixel
 * noise faked 12% gradients on flat Berlin streets. Mapbox supports
 * up to z=15 (~5 m/pixel at equator), which gives smoother interpolation
 * between SRTM samples and less spurious-gradient noise.
 */

// z=12 = ~24 m/pixel at Berlin latitude, ~30 m at SF. This matches the
// SRTM-1 native horizontal resolution that the source data is derived
// from — higher zooms (Mapbox supports up to z=15) just smooth-interpolate
// between the same source samples, costing 4-64× more tiles per request
// without adding real elevation signal. We stay at z=12 because the
// router uses BRouter-style ascent-cost (not a binary gradient gate), so
// pixel noise here adds tiny extra cost rather than triggering false
// bridge-walks — the source-resolution tile count keeps memory bounded
// (Berlin city ~36 tiles, ~9 MB) while still supporting the elevation-
// aware overlay rendering.
const TILE_ZOOM = 12
const TILE_SIZE = 256

// Upper bound on tiles a single prefetch may request. A full-screen z=12
// viewport is ~a few dozen tiles; this caps pathological bboxes (outlier
// OSM nodes, region-spanning unions) so prefetch can never fire a storm
// of fetches. ~14×14 tiles ≈ a very generous metro viewport.
const MAX_PREFETCH_TILES = 200

// In-memory cache. `null` means "fetched and failed" — don't retry this
// session. A `Uint8ClampedArray` is the decoded RGBA pixel data (length
// 256*256*4).
const tileCache = new Map<string, Uint8ClampedArray | null>()
const inflight = new Map<string, Promise<void>>()

function canDecodeTiles(): boolean {
  return (
    (typeof createImageBitmap !== 'undefined' && typeof OffscreenCanvas !== 'undefined') ||
    externalDecoder != null
  )
}

function getMapboxToken(): string | undefined {
  // Skip fetches entirely in runtimes that can't decode the PNGs anyway —
  // a Bun/Node script without a registered decoder would otherwise burn
  // bandwidth pulling tiles only to discard them. Browser keeps its
  // OffscreenCanvas path; benchmark registers a decoder before this runs.
  if (!canDecodeTiles()) return undefined
  // Browser: Vite inlines `import.meta.env.VITE_MAPBOX_TOKEN` at build time.
  // Non-browser (Bun benchmark script, Node test runner): fall back to
  // process.env so the gradient gate can be exercised outside the browser.
  const viteToken = import.meta.env?.VITE_MAPBOX_TOKEN
  if (viteToken) return viteToken
  if (typeof process !== 'undefined' && process.env?.VITE_MAPBOX_TOKEN) {
    return process.env.VITE_MAPBOX_TOKEN
  }
  return undefined
}

function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`
}

// Web-Mercator tile coords (integer) for a lat/lng at zoom z.
export function lngLatToTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 2 ** z
  const x = Math.floor(((lng + 180) / 360) * n)
  const latRad = (lat * Math.PI) / 180
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  )
  return { x, y }
}

// Full tile + sub-tile pixel position (fractional) for a lat/lng. The
// caller can floor for nearest-neighbour or use fpx/fpy for bilinear.
function lngLatToTileSubPixel(
  lng: number,
  lat: number,
  z: number,
): { tx: number; ty: number; fpx: number; fpy: number } {
  const n = 2 ** z
  const fx = ((lng + 180) / 360) * n
  const latRad = (lat * Math.PI) / 180
  const fy =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  const tx = Math.floor(fx)
  const ty = Math.floor(fy)
  const fpx = (fx - tx) * TILE_SIZE
  const fpy = (fy - ty) * TILE_SIZE
  return { tx, ty, fpx, fpy }
}

/** terrain-RGB pixel → metres above sea level. */
export function decodeTerrainRgb(r: number, g: number, b: number): number {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1
}

// Pluggable PNG decoder. The browser path uses OffscreenCanvas +
// createImageBitmap. Non-browser environments (Bun, Node, benchmark
// scripts) can register a decoder via `setElevationDecoder()` so the
// gradient gate can actually be exercised in scripts. Returning null
// keeps the soft-fail invariant.
type ElevationDecoder = (bytes: Uint8Array) => Promise<Uint8ClampedArray | null> | Uint8ClampedArray | null

let externalDecoder: ElevationDecoder | null = null

/**
 * Register a non-browser PNG → RGBA decoder. The decoder must return
 * a `Uint8ClampedArray` of length `TILE_SIZE * TILE_SIZE * 4` (256×256
 * RGBA pixels), or null on failure. Set to `null` to clear.
 *
 * Used by `scripts/benchmark-routing.ts` to inject a Bun-friendly
 * pngjs decoder so the gradient gate is actually exercised in the
 * benchmark.
 *
 * DO NOT call this from browser code. The OffscreenCanvas path is
 * preferred in the browser — it's faster and avoids bundling a JS
 * PNG decoder. The decoder only runs when OffscreenCanvas is absent.
 */
export function setElevationDecoder(decoder: ElevationDecoder | null): void {
  externalDecoder = decoder
}

// Mapbox tokens can be URL-restricted in production; a request from a
// browser tab on bike-map.fryanpan.com gets an automatic matching
// Referer. Bun's fetch sends no Referer, so a restricted token would
// 401/403. The benchmark script registers a Referer here matching the
// allowed origin so the same token works without us proxying through
// the worker.
let fetchReferer: string | null = null

export function setElevationReferer(url: string | null): void {
  fetchReferer = url
}

async function decodeImageBlob(blob: Blob): Promise<Uint8ClampedArray | null> {
  // Prefer the browser-native path when it's available — fast and uses
  // GPU-assisted decode where the runtime offers it.
  if (typeof createImageBitmap !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
    const bitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0)
    return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data
  }
  // Non-browser path: defer to the injected decoder if one was
  // registered. No decoder = soft null (the historical Bun behavior).
  if (externalDecoder) {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const result = await externalDecoder(bytes)
    return result
  }
  return null
}

async function fetchTile(z: number, x: number, y: number): Promise<void> {
  const key = tileKey(z, x, y)
  if (tileCache.has(key)) return
  const existing = inflight.get(key)
  if (existing) return existing

  const apiKey = getMapboxToken()
  if (!apiKey) {
    tileCache.set(key, null)
    return
  }

  const p = (async () => {
    try {
      // Mapbox Raster Tiles API. `pngraw` returns a non-color-managed PNG
      // so the RGB values are the encoded elevation bytes — required for
      // accurate decode. The standard `.png` variant goes through Mapbox's
      // sRGB pipeline and shifts the bytes.
      const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}.pngraw?access_token=${apiKey}`
      const init: RequestInit = fetchReferer ? { headers: { Referer: fetchReferer } } : {}
      const res = await fetch(url, init)
      if (!res.ok) {
        tileCache.set(key, null)
        return
      }
      const blob = await res.blob()
      const data = await decodeImageBlob(blob)
      tileCache.set(key, data)
    } catch {
      tileCache.set(key, null)
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, p)
  await p
}

export interface BBox {
  south: number
  west: number
  north: number
  east: number
}

/**
 * Pre-fetch the terrain-RGB tiles covering `bbox` at zoom 12. Called
 * once per route request before graph construction. Awaiting this
 * before `buildRoutingGraph` lets the gradient check inside the graph
 * builder stay synchronous.
 *
 * z=12 is ~24 m/pixel at Berlin latitude, ~30 m at SF — matches the SRTM
 * source resolution that the data is ultimately derived from. For a
 * typical urban corridor that's ~9–25 tiles per request; for a city-wide
 * overlay viewport ~30-50 tiles. Mapbox's free tier (200K tile reads/
 * month) covers a personal-scale deployment with room to spare.
 */
export async function prefetchElevation(bbox: BBox): Promise<void> {
  const { x: xA, y: yA } = lngLatToTile(bbox.west, bbox.north, TILE_ZOOM)
  const { x: xB, y: yB } = lngLatToTile(bbox.east, bbox.south, TILE_ZOOM)
  const minX = Math.min(xA, xB)
  const maxX = Math.max(xA, xB)
  const minY = Math.min(yA, yB)
  const maxY = Math.max(yA, yB)
  // Backstop: a viewport-sized bbox is a few dozen tiles. Anything past
  // this means the caller passed a pathological bbox (an outlier node, a
  // bbox spanning regions) — skip rather than fire thousands of fetches
  // and hang the page. The gradient gate fails soft (null → shown).
  const tileCount = (maxX - minX + 1) * (maxY - minY + 1)
  if (tileCount > MAX_PREFETCH_TILES) {
    console.warn(`[elevation] prefetch bbox spans ${tileCount} tiles (> ${MAX_PREFETCH_TILES}) — skipping to avoid a request storm`)
    return
  }
  const tasks: Promise<void>[] = []
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      tasks.push(fetchTile(TILE_ZOOM, x, y))
    }
  }
  await Promise.all(tasks)
}

/**
 * Synchronous elevation lookup (metres). Returns null when the covering
 * tile wasn't successfully fetched. Callers MUST treat null as
 * "elevation unknown, skip the gradient gate."
 *
 * Nearest-pixel lookup. Bilinear interpolation was tested 2026-05-26
 * and over-smoothed real peaks — Bernal Heights' 22 m nearest-pixel
 * read became 10 m bilinear because the peak is one z=12 pixel wide
 * (~38 m at SF lat) and its 3 neighbours are valley floor. Smoothing
 * destroyed the gradient signal that the gate needs. Noise mitigation
 * has to come from the way-length floor in the router, not the lookup.
 */
export function lookupElevation(lat: number, lng: number): number | null {
  const { tx, ty, fpx, fpy } = lngLatToTileSubPixel(lng, lat, TILE_ZOOM)
  const data = tileCache.get(tileKey(TILE_ZOOM, tx, ty))
  if (!data) return null
  const px = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(fpx)))
  const py = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(fpy)))
  const i = (py * TILE_SIZE + px) * 4
  return decodeTerrainRgb(data[i], data[i + 1], data[i + 2])
}

/**
 * Sum of positive elevation deltas in each traversal direction over a
 * way's vertices. `forwardM` is the climb when walking the coords as
 * listed; `reverseM` is the climb walking them backwards (one way's
 * ascent is the other's descent). Also returns the per-vertex elevations
 * (null where the covering tile is unavailable) so callers that
 * distribute ascent per-segment don't look them up twice.
 *
 * This is the single source of per-way ascent: the router consumes
 * forward/reverse to weight A* cost; the overlay consumes them (via
 * `overlayGradientPct`) to gate too-steep ways out of the browse map.
 * Pure over `elevationFn`; defaults to the module's `lookupElevation`.
 */
export function wayAscentMeters(
  coords: Array<[number, number]>,
  elevationFn: (lat: number, lng: number) => number | null = lookupElevation,
): { forwardM: number; reverseM: number; elevations: Array<number | null> } {
  const elevations = coords.map(([lat, lng]) => elevationFn(lat, lng))
  let forwardM = 0
  let reverseM = 0
  for (let i = 0; i < elevations.length - 1; i++) {
    const a = elevations[i]
    const b = elevations[i + 1]
    if (a == null || b == null) continue
    if (b > a) forwardM += b - a
    else if (a > b) reverseM += a - b
  }
  return { forwardM, reverseM, elevations }
}

// Overlay steepness gate constants. The 2 m cutoff matches the router's
// UPHILL_CUTOFF_M so a flat way reading ±noise across z=12 pixels doesn't
// register a phantom grade. The 40 m length floor reflects the z=12 pixel
// size (~24-30 m): below ~1.5 pixels a "gradient" is just two adjacent
// noisy samples, so we report null (unknown) rather than gate on noise.
const OVERLAY_GRADIENT_CUTOFF_M = 2
const MIN_GRADED_LEN_M = 40

// Local equirectangular metres-between — kept private here so elevation.ts
// has no dependency on the routing module (which imports this one).
function segMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const meanLat = ((lat1 + lat2) / 2) * (Math.PI / 180)
  const x = dLng * Math.cos(meanLat)
  return Math.sqrt(dLat * dLat + x * x) * R
}

/**
 * Gross gradient (%) for overlay display: the steeper of the two
 * traversal climbs over the way's horizontal length, minus the noise
 * cutoff. Returns null when the way is shorter than the z=12 resolution
 * floor or no covering elevation tile is loaded — callers treat null as
 * "unknown, show it" (fail-soft, matching the router's gradient handling).
 */
export function overlayGradientPct(
  coords: Array<[number, number]>,
  elevationFn: (lat: number, lng: number) => number | null = lookupElevation,
): number | null {
  let lengthM = 0
  for (let i = 1; i < coords.length; i++) {
    lengthM += segMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
  }
  if (lengthM < MIN_GRADED_LEN_M) return null
  const { forwardM, reverseM, elevations } = wayAscentMeters(coords, elevationFn)
  if (elevations.every((e) => e == null)) return null
  const gross = Math.max(0, Math.max(forwardM, reverseM) - OVERLAY_GRADIENT_CUTOFF_M)
  return (gross / lengthM) * 100
}

/** Test-only — wipe caches and clear module-level registrations between runs. */
export function _resetElevationCache(): void {
  tileCache.clear()
  inflight.clear()
  externalDecoder = null
  fetchReferer = null
}

/** Test-only — seed a tile directly without going through fetch/decode. */
export function _seedTile(z: number, x: number, y: number, data: Uint8ClampedArray | null): void {
  tileCache.set(tileKey(z, x, y), data)
}
