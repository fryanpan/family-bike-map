/**
 * Per-tile IndexedDB store for silent lazy-persistence of Overpass tile data.
 *
 * Separate from src/services/tileCache.ts, which stores whole *named regions*
 * (Berlin, Copenhagen, etc.) on demand via an explicit user action. This store
 * silently accumulates every tile the client ever fetches, keyed by row:col,
 * with an age-based TTL. Users never see it; the overlay just becomes instant
 * on repeat visits to areas they've explored before.
 *
 * Key design decisions:
 *
 *   - Per-tile keys (not per-region). Accumulates naturally as the user pans,
 *     no prompts, no explicit save step.
 *   - 30-day TTL to match the Cloudflare edge cache. OSM bike edits are
 *     infrequent; monthly freshness is plenty.
 *   - Soft storage cap (MAX_TILES) with LRU eviction by access time, not
 *     oldest-fetched. Users who pan heavily in one area don't lose their
 *     recent data in favour of a one-time overseas trip from last week.
 *   - Fire-and-forget writes. A failed write to IDB is non-critical — the
 *     in-memory cache still has the data for the current session.
 *   - Bulk prime API so startup can inject many cached tiles at once.
 *
 * Not in scope for this file:
 *   - Service Worker cache (adds offline support; separate feature)
 *   - Cache invalidation on OSM diff pipeline (far future)
 *   - User-visible "cached areas" UI (already handled by tileCache.ts for
 *     named regions)
 */

import type { OsmWay } from '../utils/types'

const DB_NAME = 'bike-tile-store'
const STORE_NAME = 'tiles'
const DB_VERSION = 1

// 30 days in milliseconds. Matches the Cloudflare edge cache TTL.
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

// Soft cap on stored tile count. At ~50 KB per tile, 2000 tiles ≈ 100 MB
// max on disk, which is well under the typical IndexedDB quota but high
// enough that most users never hit it.
const MAX_TILES = 2000

// How often to run eviction. We only bother checking once per session because
// the map is going to be doing other I/O anyway and LRU precision doesn't
// matter much for a 30-day TTL.
let evictionCheckedThisSession = false

export interface StoredTile {
  key: string // `row:col`
  ways: OsmWay[]
  /**
   * Traffic-signal node coords for this tile. Used by the routing graph to
   * apply the unsignalized-intersection penalty. Optional for backwards
   * compatibility — old IDB rows written before the field existed will
   * lack it; consumers should treat absence as "no signal data" (penalty
   * never fires, same as the empty-array case).
   */
  signals?: [number, number][]
  fetchedAt: number // Date.now()
  lastAccessed: number // Date.now(), updated on every read
}

// ── Pure helpers (exported for tests) ──────────────────────────────────────

/**
 * Is this tile older than the TTL cutoff?
 * Compared against `fetchedAt`, not `lastAccessed` — TTL is freshness of the
 * source data, not recency of access.
 */
export function isExpired(tile: StoredTile, now: number, maxAgeMs: number = MAX_AGE_MS): boolean {
  return now - tile.fetchedAt > maxAgeMs
}

/**
 * Given a snapshot of all stored tiles, return the set of keys that should
 * be evicted. Two passes:
 *   1. Every expired tile (fetchedAt older than maxAgeMs)
 *   2. If the surviving set is still larger than maxTiles, LRU-evict by
 *      `lastAccessed` ascending until the count is at cap.
 *
 * Pure function — no IDB I/O. Used by evictOldTiles() at runtime and by
 * tileStore.test.ts for unit coverage.
 */
export function pickEvictionVictims(
  tiles: StoredTile[],
  now: number,
  maxAgeMs: number = MAX_AGE_MS,
  maxTiles: number = MAX_TILES,
): string[] {
  const toDelete: string[] = []

  // Pass 1: expired
  for (const tile of tiles) {
    if (isExpired(tile, now, maxAgeMs)) {
      toDelete.push(tile.key)
    }
  }

  // Pass 2: LRU overflow
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

// Fail-safe: if IndexedDB isn't available (private browsing, Safari iframe,
// etc.) we short-circuit and become a no-op. The in-memory _tileCache in
// overpass.ts still works.
function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined'
  } catch {
    return false
  }
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Use the tile key as the primary key so lookups are O(1).
        db.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Load a single tile from IndexedDB. Returns null if not stored, expired,
 * or on any IDB error (silently — this is a cache, not an authoritative
 * source). Updates the tile's lastAccessed timestamp on successful read.
 */
export async function loadTile(
  row: number,
  col: number,
): Promise<{ ways: OsmWay[]; signals: [number, number][] | undefined } | null> {
  if (!idbAvailable()) return null
  const key = `${row}:${col}`
  try {
    const db = await openDB()
    const result = await new Promise<StoredTile | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(key)
      req.onsuccess = () => resolve((req.result as StoredTile | undefined) ?? null)
      req.onerror = () => reject(req.error)
    })
    if (!result) return null

    // Expired — treat as miss and let the caller refetch. We don't delete
    // expired entries on read (too much write amplification); they'll be
    // cleaned up by the next eviction pass.
    if (isExpired(result, Date.now())) return null

    // Update lastAccessed (fire-and-forget — don't block the read on the write).
    void touchTile(key)

    return { ways: result.ways, signals: result.signals }
  } catch {
    // IDB failure is non-critical
    return null
  }
}

/**
 * Store a tile in IndexedDB. Fire-and-forget — errors are swallowed because
 * the in-memory cache still has the data for the current session.
 *
 * `signals` is optional — callers without signal data (legacy paths) can
 * omit it. Tiles written without signals will silently miss the
 * unsignalized-intersection penalty until the tile is refreshed.
 */
export async function storeTile(
  row: number,
  col: number,
  ways: OsmWay[],
  signals?: [number, number][],
): Promise<void> {
  if (!idbAvailable()) return
  const key = `${row}:${col}`
  const now = Date.now()
  const tile: StoredTile = { key, ways, signals, fetchedAt: now, lastAccessed: now }
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(tile)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })

    // Run eviction once per session after the first successful write, so we
    // don't pay the cost on every fetch but also don't let the store grow
    // unbounded across sessions.
    if (!evictionCheckedThisSession) {
      evictionCheckedThisSession = true
      void evictOldTiles()
    }
  } catch {
    // IDB failure is non-critical
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
        const existing = getReq.result as StoredTile | undefined
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

/**
 * Evict expired tiles (older than MAX_AGE_MS) and, if still over MAX_TILES,
 * evict the least-recently-accessed until under the cap. Runs at most once
 * per session.
 */
async function evictOldTiles(): Promise<void> {
  try {
    const db = await openDB()
    const rows = await new Promise<StoredTile[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).getAll()
      req.onsuccess = () => resolve(req.result as StoredTile[])
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
