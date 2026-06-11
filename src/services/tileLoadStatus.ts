/**
 * Observable store for live Overpass tile-load status, so the browse map can
 * show the user what's happening while the overlay loads: which tiles are
 * queued, which are downloading right now, and how many bytes have arrived.
 *
 * The single fetch choke point (`fetchBikeInfraForTile` in overpass.ts) reports
 * per-tile transitions here. Cache hits (in-memory / IndexedDB) never touch this
 * store — they're instant and need no indicator. Only network fetches register.
 *
 * Consumers subscribe via the `useTileLoadStatus()` hook (useSyncExternalStore),
 * matching the adminSettings store pattern.
 */
import { useSyncExternalStore } from 'react'

export type TileState = 'queued' | 'loading' | 'done' | 'error'

export interface TileStatus {
  key: string // `row:col`
  row: number
  col: number
  state: TileState
  loadedBytes: number
  totalBytes: number | null // from Content-Length when the proxy sets it
}

export interface TileLoadSnapshot {
  /** True while any tile is queued or actively loading. */
  active: boolean
  queued: TileStatus[]
  loading: TileStatus[]
  doneCount: number
  errorCount: number
  /** Tiles in the current load burst (queued + loading + done + error). */
  totalCount: number
  /** Bytes downloaded so far across loading + done tiles in this burst. */
  loadedBytes: number
}

const tiles = new Map<string, TileStatus>()
const listeners = new Set<() => void>()

function buildSnapshot(): TileLoadSnapshot {
  const queued: TileStatus[] = []
  const loading: TileStatus[] = []
  let doneCount = 0
  let errorCount = 0
  let loadedBytes = 0
  for (const t of tiles.values()) {
    if (t.state === 'queued') queued.push(t)
    else if (t.state === 'loading') { loading.push(t); loadedBytes += t.loadedBytes }
    else if (t.state === 'done') { doneCount++; loadedBytes += t.loadedBytes }
    else errorCount++
  }
  const byKey = (a: TileStatus, b: TileStatus) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  queued.sort(byKey)
  loading.sort(byKey)
  return {
    active: queued.length + loading.length > 0,
    queued,
    loading,
    doneCount,
    errorCount,
    totalCount: tiles.size,
    loadedBytes,
  }
}

let snapshot: TileLoadSnapshot = buildSnapshot()

function emit(): void {
  snapshot = buildSnapshot()
  for (const l of listeners) l()
}

function anyActive(): boolean {
  for (const t of tiles.values()) {
    if (t.state === 'queued' || t.state === 'loading') return true
  }
  return false
}

let pruneTimer: ReturnType<typeof setTimeout> | null = null
function clearPrune(): void {
  if (pruneTimer) { clearTimeout(pruneTimer); pruneTimer = null }
}
function schedulePruneIfSettled(): void {
  if (anyActive()) return
  clearPrune()
  // Linger briefly after everything settles so the bar can show 100%, then
  // clear so the indicator disappears.
  pruneTimer = setTimeout(() => { pruneTimer = null; tiles.clear(); emit() }, 1500)
}

// Progress events fire per network chunk (many per tile). Coalesce them to one
// emit per frame-ish so a 8 MB tile doesn't trigger hundreds of re-renders.
let progressDirty = false
let progressTimer: ReturnType<typeof setTimeout> | null = null
function scheduleProgressEmit(): void {
  if (progressTimer) return
  progressTimer = setTimeout(() => {
    progressTimer = null
    if (progressDirty) { progressDirty = false; emit() }
  }, 150)
}

/** A tile entered the fetch queue (waiting on the concurrency semaphore). */
export function tileQueued(row: number, col: number): void {
  clearPrune()
  // If nothing is active, this queued tile starts a fresh burst — clear the
  // settled entries from the previous burst so counts reflect the new pan/zoom.
  if (!anyActive()) tiles.clear()
  const key = `${row}:${col}`
  tiles.set(key, { key, row, col, state: 'queued', loadedBytes: 0, totalBytes: null })
  emit()
}

/** A tile acquired a fetch slot and is now downloading. */
export function tileLoading(row: number, col: number, totalBytes: number | null): void {
  const t = tiles.get(`${row}:${col}`)
  if (!t) return
  t.state = 'loading'
  if (totalBytes != null) t.totalBytes = totalBytes
  emit()
}

/** Download progress for an actively-loading tile (coalesced). */
export function tileProgress(row: number, col: number, loadedBytes: number): void {
  const t = tiles.get(`${row}:${col}`)
  if (!t || t.state !== 'loading') return
  t.loadedBytes = loadedBytes
  progressDirty = true
  scheduleProgressEmit()
}

/** A tile finished downloading successfully. */
export function tileDone(row: number, col: number, loadedBytes: number): void {
  const t = tiles.get(`${row}:${col}`)
  if (!t) return
  t.state = 'done'
  t.loadedBytes = loadedBytes
  if (t.totalBytes == null) t.totalBytes = loadedBytes
  emit()
  schedulePruneIfSettled()
}

/** A tile failed (network error, HTTP error, or timeout after retries). */
export function tileError(row: number, col: number): void {
  const t = tiles.get(`${row}:${col}`)
  if (!t) return
  t.state = 'error'
  emit()
  schedulePruneIfSettled()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function getSnapshot(): TileLoadSnapshot {
  return snapshot
}

/** React hook — re-renders the consumer whenever tile-load status changes. */
export function useTileLoadStatus(): TileLoadSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Test-only: read the current snapshot without the React hook. */
export function __getTileLoadSnapshot(): TileLoadSnapshot {
  return snapshot
}

/** Test-only: wipe all state between cases. */
export function __resetTileLoadStatus(): void {
  tiles.clear()
  clearPrune()
  if (progressTimer) { clearTimeout(progressTimer); progressTimer = null }
  progressDirty = false
  snapshot = buildSnapshot()
}
