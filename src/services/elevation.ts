/**
 * Elevation lookup via MapTiler terrain-RGB tiles.
 *
 * Tiles are fetched once per session and cached in memory as decoded
 * pixel arrays. `prefetchElevation(bbox)` is awaited up-front by the
 * router before graph construction; `lookupElevation(lat, lng)` is then
 * a synchronous nearest-pixel read inside the graph builder.
 *
 * Fails soft: if the MapTiler key is missing, or a tile 404s, the
 * lookup returns null for any coord it can't resolve. Callers (the
 * gradient gate in clientRouter) skip the cap when elevation is null,
 * so the absence of elevation degrades gracefully to "no gradient
 * filter" rather than blocking routes.
 *
 * Reference: https://docs.maptiler.com/cloud/api/elevation/
 *   height (m) = -10000 + ((R*256*256 + G*256 + B) * 0.1)
 */

const TILE_ZOOM = 12
const TILE_SIZE = 256

// In-memory cache. `null` means "fetched and failed" — don't retry this
// session. A `Uint8ClampedArray` is the decoded RGBA pixel data (length
// 256*256*4).
const tileCache = new Map<string, Uint8ClampedArray | null>()
const inflight = new Map<string, Promise<void>>()

function getMapTilerKey(): string | undefined {
  return import.meta.env?.VITE_MAPTILER_KEY || undefined
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

// Full tile + sub-tile pixel position (nearest pixel) for a lat/lng.
function lngLatToTilePixel(
  lng: number,
  lat: number,
  z: number,
): { tx: number; ty: number; px: number; py: number } {
  const n = 2 ** z
  const fx = ((lng + 180) / 360) * n
  const latRad = (lat * Math.PI) / 180
  const fy =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  const tx = Math.floor(fx)
  const ty = Math.floor(fy)
  const px = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor((fx - tx) * TILE_SIZE)))
  const py = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor((fy - ty) * TILE_SIZE)))
  return { tx, ty, px, py }
}

/** terrain-RGB pixel → metres above sea level. */
export function decodeTerrainRgb(r: number, g: number, b: number): number {
  return -10000 + (r * 65536 + g * 256 + b) * 0.1
}

async function decodeImageBlob(blob: Blob): Promise<Uint8ClampedArray | null> {
  // OffscreenCanvas + createImageBitmap works in modern browsers and
  // Workers. In a non-browser test environment these will throw; the
  // catch in fetchTile turns the failure into a soft null.
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return null
  }
  const bitmap = await createImageBitmap(blob)
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(bitmap, 0, 0)
  return ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data
}

async function fetchTile(z: number, x: number, y: number): Promise<void> {
  const key = tileKey(z, x, y)
  if (tileCache.has(key)) return
  const existing = inflight.get(key)
  if (existing) return existing

  const apiKey = getMapTilerKey()
  if (!apiKey) {
    tileCache.set(key, null)
    return
  }

  const p = (async () => {
    try {
      const url = `https://api.maptiler.com/tiles/terrain-rgb/${z}/${x}/${y}.png?key=${apiKey}`
      const res = await fetch(url)
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
 * z=12 gives roughly 9.5 m/pixel at the equator; for a typical urban
 * corridor that's ~9–25 tiles per request, well under any rate ceiling.
 */
export async function prefetchElevation(bbox: BBox): Promise<void> {
  const { x: xA, y: yA } = lngLatToTile(bbox.west, bbox.north, TILE_ZOOM)
  const { x: xB, y: yB } = lngLatToTile(bbox.east, bbox.south, TILE_ZOOM)
  const minX = Math.min(xA, xB)
  const maxX = Math.max(xA, xB)
  const minY = Math.min(yA, yB)
  const maxY = Math.max(yA, yB)
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
 */
export function lookupElevation(lat: number, lng: number): number | null {
  const { tx, ty, px, py } = lngLatToTilePixel(lng, lat, TILE_ZOOM)
  const data = tileCache.get(tileKey(TILE_ZOOM, tx, ty))
  if (!data) return null
  const i = (py * TILE_SIZE + px) * 4
  return decodeTerrainRgb(data[i], data[i + 1], data[i + 2])
}

/** Test-only — wipe caches between runs. */
export function _resetElevationCache(): void {
  tileCache.clear()
  inflight.clear()
}

/** Test-only — seed a tile directly without going through fetch/decode. */
export function _seedTile(z: number, x: number, y: number, data: Uint8ClampedArray | null): void {
  tileCache.set(tileKey(z, x, y), data)
}
