/**
 * IndexedDB cache for Mapillary lookups.
 *
 * Keyed on quantized (lat, lng) so nearby clicks share results and we
 * don't burn rate-limit budget on repeated views of the same segment.
 * Stores null results too — if there are no images within 500m of a
 * point, that's stable information worth caching.
 *
 * Falls back to a no-op if IDB is unavailable (private mode, quota, SSR).
 */

import type { MapillaryImage } from './mapillary'

const DB_NAME = 'mapillary-cache'
const DB_VERSION = 1
const STORE = 'images'

/** ~11m at Berlin latitude — tight enough to be click-accurate, loose enough to share across jitter. */
const QUANT = 10_000

const TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface CacheEntry {
  image: MapillaryImage | null
  expiresAt: number
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.resolve(null)
    return dbPromise
  }
  dbPromise = new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

function cacheKey(lat: number, lng: number): string {
  const qLat = Math.round(lat * QUANT) / QUANT
  const qLng = Math.round(lng * QUANT) / QUANT
  return `${qLat},${qLng}`
}

export async function readCache(lat: number, lng: number): Promise<MapillaryImage | null | undefined> {
  const db = await openDB()
  if (!db) return undefined
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(cacheKey(lat, lng))
      req.onsuccess = () => {
        const entry = req.result as CacheEntry | undefined
        if (!entry) return resolve(undefined)
        if (entry.expiresAt < Date.now()) return resolve(undefined)
        resolve(entry.image)
      }
      req.onerror = () => resolve(undefined)
    } catch {
      resolve(undefined)
    }
  })
}

export async function writeCache(lat: number, lng: number, image: MapillaryImage | null): Promise<void> {
  const db = await openDB()
  if (!db) return
  try {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(
      { image, expiresAt: Date.now() + TTL_MS } satisfies CacheEntry,
      cacheKey(lat, lng),
    )
  } catch {
    // Quota exceeded or disabled — ignore.
  }
}
