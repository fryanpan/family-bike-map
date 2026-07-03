/**
 * Elevation lookup via encoded-elevation PNG tiles (pluggable DEM source).
 *
 * Two DEM sources are supported (see `setElevationSource`):
 *
 * - `'mapbox-terrain-rgb'` (DEFAULT): Mapbox terrain-RGB v1 via the
 *   Raster Tiles API. Requires `VITE_MAPBOX_TOKEN`; the production token
 *   is URL-restricted, so non-browser callers must also register a
 *   Referer via `setElevationReferer`.
 *   Reference: https://docs.mapbox.com/data/tilesets/reference/mapbox-terrain-rgb-v1/
 *     height (m) = -10000 + ((R*256*256 + G*256 + B) * 0.1)
 *
 * - `'terrarium'`: AWS Terrain Tiles (Mapzen terrarium encoding) on S3.
 *   Free open data — no token, no Referer.
 *   Reference: https://github.com/tilezen/joerd/blob/master/docs/formats.md
 *     height (m) = (R * 256 + G + B / 256) - 32768
 *
 * Tiles are fetched once per session and cached in memory as decoded
 * pixel arrays (keyed per source, so switching sources can never decode
 * one encoding with the other's formula). `prefetchElevation(bbox)` is
 * awaited up-front by the router before graph construction;
 * `lookupElevation(lat, lng)` is then a synchronous nearest-pixel read
 * inside the graph builder.
 *
 * Fails soft: if the Mapbox token is missing, or a tile 404s, the
 * lookup returns null for any coord it can't resolve. Callers (the
 * gradient gate in clientRouter) skip the cap when elevation is null,
 * so the absence of elevation degrades gracefully to "no gradient
 * filter" rather than blocking routes.
 *
 * History: started on MapTiler terrain-rgb at z=12, swapped to Mapbox
 * 2026-05-26 because MapTiler caps at z=12 and the ±10 m inter-pixel
 * noise faked 12% gradients on flat Berlin streets. Mapbox supports
 * up to z=15 (~5 m/pixel at equator), which gives smoother interpolation
 * between SRTM samples and less spurious-gradient noise. Terrarium
 * support added 2026-07-03 for the enriched-tiles pipeline bake; the
 * runtime default flips to terrarium only behind the routing benchmark
 * gate (enriched-tiles plan, scope item 2).
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

// Coarse fallback zoom for wide viewports (e.g. the whole Bay Area at
// browse zoom). A z=10 tile covers 16 z=12 tiles, so a bbox that would
// blow past MAX_PREFETCH_TILES at z=12 usually fits comfortably at z=10.
// z=10 pixels are ~4× coarser (~100-120 m at SF), so the OVERLAY consumes
// this data with 4×-scaled noise floors (see overlayGradientPct). The
// ROUTER never reads z=10 — lookupElevation stays z=12-only.
const COARSE_TILE_ZOOM = 10

// z=10 pixels are 2^(12-10) = 4× the size of z=12 pixels; the overlay's
// noise floors scale by the same factor when coarse data supplied the
// elevations.
const COARSE_FLOOR_SCALE = 4

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

// Cache keys embed the active DEM source so that pixel data encoded one
// way is never decoded with the other formula: switching sources simply
// makes the old source's tiles invisible (lookup → null, fail-soft)
// until a fresh prefetch fills the new source's cache.
function tileKey(z: number, x: number, y: number): string {
  return `${elevationSource}:${z}/${x}/${y}`
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

/** Mapbox terrain-RGB pixel → metres above sea level. */
export function decodeTerrainRgb(r: number, g: number, b: number): number {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1
}

/**
 * Terrarium pixel → metres above sea level (Mapzen / AWS Terrain Tiles).
 * Spec: https://github.com/tilezen/joerd/blob/master/docs/formats.md
 *   height = (R * 256 + G + B / 256) - 32768
 * Vertical resolution is 1/256 m (B carries the fraction), vs the 0.1 m
 * steps of Mapbox terrain-RGB.
 */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768
}

/**
 * DEM sources the module can read. Both serve 256×256 encoded-elevation
 * PNGs over the same Web-Mercator z/x/y scheme; they differ in URL,
 * auth, and per-pixel decode formula.
 */
export type ElevationSourceKind = 'mapbox-terrain-rgb' | 'terrarium'

const DEFAULT_ELEVATION_SOURCE: ElevationSourceKind = 'mapbox-terrain-rgb'

let elevationSource: ElevationSourceKind = DEFAULT_ELEVATION_SOURCE

/**
 * Switch the module's DEM source. The DEFAULT is 'mapbox-terrain-rgb'
 * (the router's current runtime source); the enriched-tiles pipeline
 * sets 'terrarium' for the offline bake. Flipping the runtime default
 * to terrarium is a routing change gated on the benchmark
 * (enriched-tiles plan, scope item 2) — do not change the default here
 * without that gate.
 *
 * Cached tiles are keyed per source, so switching never mixes encodings;
 * lookups against the new source miss (null, fail-soft) until its tiles
 * are prefetched.
 */
export function setElevationSource(kind: ElevationSourceKind): void {
  elevationSource = kind
}

/** The currently active DEM source. */
export function getElevationSource(): ElevationSourceKind {
  return elevationSource
}

/** Decode a pixel of the ACTIVE source's encoding. */
function decodePixel(r: number, g: number, b: number): number {
  return elevationSource === 'terrarium' ? decodeTerrarium(r, g, b) : decodeTerrainRgb(r, g, b)
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

/**
 * Tile URL for the given source, or null when the source can't be
 * fetched in this runtime (missing Mapbox token, or no PNG decoder
 * available — no point burning bandwidth on tiles we'd discard).
 */
function tileUrl(kind: ElevationSourceKind, z: number, x: number, y: number): string | null {
  if (kind === 'terrarium') {
    // AWS Terrain Tiles: open data, no token, no Referer requirement.
    if (!canDecodeTiles()) return null
    return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`
  }
  // Mapbox Raster Tiles API. `pngraw` returns a non-color-managed PNG
  // so the RGB values are the encoded elevation bytes — required for
  // accurate decode. The standard `.png` variant goes through Mapbox's
  // sRGB pipeline and shifts the bytes.
  const apiKey = getMapboxToken()
  if (!apiKey) return null
  return `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${x}/${y}.pngraw?access_token=${apiKey}`
}

async function fetchTile(z: number, x: number, y: number): Promise<void> {
  const source = elevationSource
  const key = tileKey(z, x, y)
  if (tileCache.has(key)) return
  const existing = inflight.get(key)
  if (existing) return existing

  const url = tileUrl(source, z, x, y)
  if (!url) {
    tileCache.set(key, null)
    return
  }

  const p = (async () => {
    try {
      // The Referer exists only to satisfy Mapbox's URL-restricted token
      // (see setElevationReferer); terrarium is unauthenticated, so its
      // requests go out bare.
      const init: RequestInit =
        source === 'mapbox-terrain-rgb' && fetchReferer
          ? { headers: { Referer: fetchReferer } }
          : {}
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

// Integer tile range covering `bbox` at zoom `z`, plus the tile count.
function tileRangeForBBox(
  bbox: BBox,
  z: number,
): { minX: number; maxX: number; minY: number; maxY: number; count: number } {
  const { x: xA, y: yA } = lngLatToTile(bbox.west, bbox.north, z)
  const { x: xB, y: yB } = lngLatToTile(bbox.east, bbox.south, z)
  const minX = Math.min(xA, xB)
  const maxX = Math.max(xA, xB)
  const minY = Math.min(yA, yB)
  const maxY = Math.max(yA, yB)
  return { minX, maxX, minY, maxY, count: (maxX - minX + 1) * (maxY - minY + 1) }
}

/**
 * Pre-fetch the terrain-RGB tiles covering `bbox`, at zoom 12 when the
 * bbox fits under the tile cap, else at the coarse zoom 10 fallback (for
 * wide browse-map viewports like the full Bay Area, which needs ~300+
 * z=12 tiles). Called once per route request before graph construction
 * and per overlay viewport change. Awaiting this before
 * `buildRoutingGraph` lets the gradient check inside the graph builder
 * stay synchronous.
 *
 * z=12 is ~24 m/pixel at Berlin latitude, ~30 m at SF — matches the SRTM
 * source resolution that the data is ultimately derived from. For a
 * typical urban corridor that's ~9–25 tiles per request; for a city-wide
 * overlay viewport ~30-50 tiles. Mapbox's free tier (200K tile reads/
 * month) covers a personal-scale deployment with room to spare.
 *
 * Only the overlay path (`lookupElevationOverlay` / `overlayGradientPct`)
 * ever reads z=10 data; the router's `lookupElevation` stays z=12-only,
 * so a coarse prefetch degrades routing to "no elevation" fail-soft
 * exactly as an over-cap skip did before.
 */
export async function prefetchElevation(bbox: BBox): Promise<void> {
  let zoom = TILE_ZOOM
  let range = tileRangeForBBox(bbox, zoom)
  if (range.count > MAX_PREFETCH_TILES) {
    // Too wide for z=12 — retry the same bbox at the coarse zoom (16×
    // fewer tiles).
    zoom = COARSE_TILE_ZOOM
    range = tileRangeForBBox(bbox, zoom)
  }
  // Backstop: a viewport-sized bbox is a few dozen tiles even at z=12.
  // Past the cap at BOTH zooms means the caller passed a pathological
  // bbox (an outlier node, a bbox spanning regions) — skip rather than
  // fire thousands of fetches and hang the page. The gradient gate fails
  // soft (null → shown).
  if (range.count > MAX_PREFETCH_TILES) {
    console.warn(`[elevation] prefetch bbox spans ${range.count} tiles at z=${zoom} (> ${MAX_PREFETCH_TILES}) — skipping to avoid a request storm`)
    return
  }
  const tasks: Promise<void>[] = []
  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) {
      tasks.push(fetchTile(zoom, x, y))
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
  return lookupElevationAtZoom(lat, lng, TILE_ZOOM)
}

/**
 * Overlay-only elevation lookup (metres): prefers the z=12 tile, falls
 * back to the z=10 coarse tile when a wide-viewport prefetch supplied
 * only coarse data, else null.
 *
 * The ROUTER must keep using `lookupElevation` — it is deliberately
 * z=12-only so a coarse browse-map prefetch can never change routing
 * cost (the router-isolation guarantee: routing results are identical
 * whether or not z=10 tiles happen to be cached).
 */
export function lookupElevationOverlay(lat: number, lng: number): number | null {
  const fine = lookupElevationAtZoom(lat, lng, TILE_ZOOM)
  if (fine != null) return fine
  return lookupElevationAtZoom(lat, lng, COARSE_TILE_ZOOM)
}

/**
 * Whether fine (z=12) elevation data covers this point. Lets overlay
 * callers that cache gradient results tell a fine-derived value (stable
 * for the session) from a coarse z=10-derived one that should be
 * recomputed once a later prefetch loads the covering z=12 tile.
 */
export function hasFineElevationAt(lat: number, lng: number): boolean {
  return hasTileData(lat, lng, TILE_ZOOM)
}

function lookupElevationAtZoom(lat: number, lng: number, z: number): number | null {
  const { tx, ty, fpx, fpy } = lngLatToTileSubPixel(lng, lat, z)
  const data = tileCache.get(tileKey(z, tx, ty))
  if (!data) return null
  const px = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(fpx)))
  const py = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(fpy)))
  const i = (py * TILE_SIZE + px) * 4
  return decodePixel(data[i], data[i + 1], data[i + 2])
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
// When z=10 coarse data supplied the elevations, both floors scale by
// COARSE_FLOOR_SCALE (40→160 m, 2→8 m) — same reasoning at 4× the pixel
// size. Coarse data must not invent phantom grades on short ways; short
// ways at wide zoom simply stay ungated (null) until finer data loads.
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

// True when tileCache holds decoded pixel data (not a fetched-and-failed
// null) for the tile covering (lat, lng) at zoom z.
function hasTileData(lat: number, lng: number, z: number): boolean {
  const { x, y } = lngLatToTile(lng, lat, z)
  return tileCache.get(tileKey(z, x, y)) != null
}

/**
 * Gross gradient (%) for overlay display: the steeper of the two
 * traversal climbs over the way's horizontal length, minus the noise
 * cutoff. Returns null when the way is shorter than the resolution
 * floor or no covering elevation tile is loaded — callers treat null as
 * "unknown, show it" (fail-soft, matching the router's gradient handling).
 *
 * Elevation defaults to `lookupElevationOverlay` (z=12 preferred, z=10
 * coarse fallback). When the z=12 tile covering the way's midpoint is
 * absent and a z=10 tile supplied the elevations, the noise floors scale
 * ×4 so coarse pixels can't fake gradients on short ways.
 */
export function overlayGradientPct(
  coords: Array<[number, number]>,
  elevationFn: (lat: number, lng: number) => number | null = lookupElevationOverlay,
): number | null {
  // Coarse-data detection at the way's midpoint: z=12 data absent there
  // AND z=10 data present ⇒ the coarse tile is what fed the elevations.
  // (Custom elevationFns with nothing cached keep the fine floors.)
  const [midLat, midLng] = coords[Math.floor(coords.length / 2)] ?? [0, 0]
  const coarse =
    !hasTileData(midLat, midLng, TILE_ZOOM) && hasTileData(midLat, midLng, COARSE_TILE_ZOOM)
  const floorScale = coarse ? COARSE_FLOOR_SCALE : 1
  return computeWayGradientPct(coords, elevationFn, floorScale)
}

/**
 * The pure per-way gradient formula — the SINGLE implementation behind
 * `overlayGradientPct` (which adds only the coarse-tile floorScale
 * detection) and the enriched-tiles pipeline bake (which passes its own
 * DEM-backed elevationFn and the fine floorScale of 1). Pure over its
 * arguments: no tile-cache reads, no module state.
 *
 * Gross gradient (%): the steeper of the two traversal climbs over the
 * way's horizontal length, minus the noise cutoff. Returns null when the
 * way is shorter than the resolution floor (scaled by `floorScale`) or
 * every vertex elevation is null — callers treat null as "unknown, show
 * it" (fail-soft, matching the router's gradient handling).
 */
export function computeWayGradientPct(
  coords: Array<[number, number]>,
  elevationFn: (lat: number, lng: number) => number | null,
  floorScale = 1,
): number | null {
  let lengthM = 0
  for (let i = 1; i < coords.length; i++) {
    lengthM += segMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
  }
  if (lengthM < MIN_GRADED_LEN_M * floorScale) return null
  const { forwardM, reverseM, elevations } = wayAscentMeters(coords, elevationFn)
  if (elevations.every((e) => e == null)) return null
  const gross = Math.max(0, Math.max(forwardM, reverseM) - OVERLAY_GRADIENT_CUTOFF_M * floorScale)
  return (gross / lengthM) * 100
}

/** Test-only — wipe caches and clear module-level registrations between runs. */
export function _resetElevationCache(): void {
  tileCache.clear()
  inflight.clear()
  externalDecoder = null
  fetchReferer = null
  elevationSource = DEFAULT_ELEVATION_SOURCE
}

/**
 * Test-only — seed a tile directly without going through fetch/decode.
 * Seeds under the ACTIVE elevation source (cache keys are per-source).
 */
export function _seedTile(z: number, x: number, y: number, data: Uint8ClampedArray | null): void {
  tileCache.set(tileKey(z, x, y), data)
}

/**
 * Test-only — whether the cache has ANY entry (data or fetched-and-failed
 * null) for a tile under the ACTIVE source. Lets tests observe which zoom
 * a prefetch targeted.
 */
export function _hasTileEntry(z: number, x: number, y: number): boolean {
  return tileCache.has(tileKey(z, x, y))
}
