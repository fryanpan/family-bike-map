/**
 * IndexedDB cache for base-map raster tiles (OpenStreetMap PNGs).
 *
 * Mirrors the design of `tileStore.ts` (Overpass tile data) but stores
 * binary tile imagery (Blob) instead of OSM way arrays. Used by the
 * custom Leaflet TileLayer in `cachedTileLayer.ts` to paint cached
 * tiles immediately on a return visit, then refresh from network in
 * the background (stale-while-revalidate).
 *
 * Goal: when a returning user opens the app, the map paints from IDB
 * before any HTTP request to the tile server starts. Network tiles
 * are still fetched in the background to keep the cache fresh, but
 * the user never WAITS for them on a return visit.
 *
 * Key design decisions:
 *
 *   - Per-tile URL key. The full tile URL (with z/x/y/subdomain) is
 *     the primary key — no collisions between tile providers.
 *   - 30-day TTL. OSM Carto and MapTiler raster tiles re-render on
 *     a sliding schedule but rarely change visibly; monthly freshness
 *     is plenty for our use case.
 *   - Soft cap with LRU eviction by lastAccessed. Heavy panners
 *     shouldn't blow out the IDB quota. ~10,000 tiles × ~20 KB ≈
 *     200 MB ceiling.
 *   - Fail-safe. If IndexedDB is unavailable (private browsing,
 *     storage disabled, etc.) the cache silently no-ops and the
 *     TileLayer falls back to plain network loading.
 *   - Fire-and-forget writes. A failed write doesn't break the
 *     network fetch path — the user still sees the live tile.
 */

const DB_NAME = 'bike-base-tiles'
const STORE_NAME = 'tiles'
const DB_VERSION = 1

// 30 days. Matches the Overpass tile TTL.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

// Soft cap on stored tile count. ~10,000 tiles × ~20 KB ≈ 200 MB.
// At zoom 14 a city covers ~1,000 tiles; this leaves room for
// multi-city pan history.
const MAX_TILES = 10_000

let evictionCheckedThisSession = false

export interface StoredBaseTile {
  /** Full tile URL — the primary key. */
  key: string
  /** Raw image bytes (PNG / JPEG). */
  blob: Blob
  /** Date.now() at fetch time. */
  fetchedAt: number
  /** Date.now(), updated on every read. */
  lastAccessed: number
}

// ── Pure helpers (exported for tests) ──────────────────────────────────────

export function isExpired(tile: StoredBaseTile, now: number, maxAgeMs: number = MAX_AGE_MS): boolean {
  return now - tile.fetchedAt > maxAgeMs
}

/**
 * Given a snapshot of all stored tiles, return keys to evict.
 * Two passes:
 *   1. Every expired tile (fetchedAt older than maxAgeMs)
 *   2. If the surviving set is still over maxTiles, LRU-evict by
 *      lastAccessed ascending.
 *
 * Pure function — no IDB I/O. Same shape as
 * `tileStore.pickEvictionVictims` so the unit test pattern is shared.
 */
export function pickEvictionVictims(
  tiles: StoredBaseTile[],
  now: number,
  maxAgeMs: number = MAX_AGE_MS,
  maxTiles: number = MAX_TILES,
): string[] {
  const toDelete: string[] = []

  for (const tile of tiles) {
    if (isExpired(tile, now, maxAgeMs)) {
      toDelete.push(tile.key)
    }
  }

  const expiredSet = new Set(toDelete)
  const surviving = tiles.filter((t) => !expiredSet.has(t.key))
  if (surviving.length > maxTiles) {
    surviving.sort((a, b) => a.lastAccessed - b.lastAccessed)
    const excess = surviving.length - maxTiles
    for (let i = 0; i < excess; i++) {
      toDelete.push(surviving[i].key)
    }
  }

  return toDelete
}

// ── IDB setup ──────────────────────────────────────────────────────────────

function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined'
  } catch {
    return false
  }
}

let _dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise
  _dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      _dbPromise = null
      reject(request.error)
    }
  })
  return _dbPromise
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Load a tile blob by URL. Returns null on miss / expiry / IDB error.
 * Touches lastAccessed on hit (fire-and-forget).
 */
export async function loadTile(url: string): Promise<Blob | null> {
  if (!idbAvailable()) return null
  try {
    const db = await openDB()
    const result = await new Promise<StoredBaseTile | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(url)
      req.onsuccess = () => resolve((req.result as StoredBaseTile | undefined) ?? null)
      req.onerror = () => reject(req.error)
    })
    if (!result) return null
    if (isExpired(result, Date.now())) return null

    void touchTile(url)
    return result.blob
  } catch {
    return null
  }
}

/**
 * Inspect the raw `fetchedAt` timestamp from IDB. Used by the
 * background-refresh path in `cachedTileLayer.ts` so we don't
 * burn network on a tile we just fetched a few hours ago.
 */
export async function getFetchedAt(url: string): Promise<number | null> {
  if (!idbAvailable()) return null
  try {
    const db = await openDB()
    return await new Promise<number | null>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(url)
      req.onsuccess = () => {
        const r = req.result as StoredBaseTile | undefined
        resolve(r?.fetchedAt ?? null)
      }
      req.onerror = () => resolve(null)
    })
  } catch {
    return null
  }
}

/**
 * Store a tile blob by URL. Fire-and-forget — IDB errors are swallowed.
 * Triggers eviction once per session after the first successful write.
 */
export async function storeTile(url: string, blob: Blob): Promise<void> {
  if (!idbAvailable()) return
  const now = Date.now()
  const tile: StoredBaseTile = { key: url, blob, fetchedAt: now, lastAccessed: now }
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(tile)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })

    if (!evictionCheckedThisSession) {
      evictionCheckedThisSession = true
      void evictOldTiles()
    }
  } catch {
    // non-critical
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────

async function touchTile(key: string): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const getReq = store.get(key)
      getReq.onsuccess = () => {
        const existing = getReq.result as StoredBaseTile | undefined
        if (existing) {
          existing.lastAccessed = Date.now()
          store.put(existing)
        }
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // non-critical
  }
}

async function evictOldTiles(): Promise<void> {
  try {
    const db = await openDB()
    const rows = await new Promise<StoredBaseTile[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).getAll()
      req.onsuccess = () => resolve(req.result as StoredBaseTile[])
      req.onerror = () => reject(req.error)
    })

    const toDelete = pickEvictionVictims(rows, Date.now())
    if (toDelete.length === 0) return

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      for (const key of toDelete) store.delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } catch {
    // non-critical
  }
}

// Exposed for tests
export const _internals = { MAX_AGE_MS, MAX_TILES }
