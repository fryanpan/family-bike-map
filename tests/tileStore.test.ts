import { describe, test, expect } from 'bun:test'
import { isExpired, pickEvictionVictims, type StoredTile } from '../src/services/tileStore'

// Helper: build a StoredTile fixture with sensible defaults.
function tile(overrides: Partial<StoredTile> & { key: string }): StoredTile {
  return {
    ways: [],
    fetchedAt: 0,
    lastAccessed: 0,
    ...overrides,
  }
}

// 30-day TTL matching src/services/tileStore.ts MAX_AGE_MS.
const DAY = 24 * 60 * 60 * 1000
const MAX_AGE = 30 * DAY
const NOW = 1_700_000_000_000 // fixed reference time

describe('isExpired', () => {
  test('fresh tile (just fetched) is not expired', () => {
    expect(isExpired(tile({ key: 'a', fetchedAt: NOW }), NOW, MAX_AGE)).toBe(false)
  })

  test('tile fetched 29 days ago is not expired', () => {
    expect(isExpired(tile({ key: 'a', fetchedAt: NOW - 29 * DAY }), NOW, MAX_AGE)).toBe(false)
  })

  test('tile fetched exactly 30 days ago is not expired (boundary)', () => {
    // Boundary: now - fetchedAt == maxAge → not expired (> not >=)
    expect(isExpired(tile({ key: 'a', fetchedAt: NOW - 30 * DAY }), NOW, MAX_AGE)).toBe(false)
  })

  test('tile fetched 31 days ago is expired', () => {
    expect(isExpired(tile({ key: 'a', fetchedAt: NOW - 31 * DAY }), NOW, MAX_AGE)).toBe(true)
  })

  test('checks fetchedAt, not lastAccessed (access-recency does not reset TTL)', () => {
    // Tile was fetched 40 days ago but touched yesterday — still expired.
    const stale = tile({ key: 'a', fetchedAt: NOW - 40 * DAY, lastAccessed: NOW - DAY })
    expect(isExpired(stale, NOW, MAX_AGE)).toBe(true)
  })

  test('uses provided maxAge parameter', () => {
    const tenDays = 10 * DAY
    const justOverTenDays = tile({ key: 'a', fetchedAt: NOW - 11 * DAY })
    expect(isExpired(justOverTenDays, NOW, tenDays)).toBe(true)
    expect(isExpired(justOverTenDays, NOW, MAX_AGE)).toBe(false)
  })
})

describe('pickEvictionVictims', () => {
  test('empty input returns empty', () => {
    expect(pickEvictionVictims([], NOW, MAX_AGE, 2000)).toEqual([])
  })

  test('all fresh + under cap → nothing evicted', () => {
    const tiles: StoredTile[] = [
      tile({ key: 'a', fetchedAt: NOW - DAY, lastAccessed: NOW }),
      tile({ key: 'b', fetchedAt: NOW - 2 * DAY, lastAccessed: NOW - DAY }),
      tile({ key: 'c', fetchedAt: NOW - 5 * DAY, lastAccessed: NOW - 3 * DAY }),
    ]
    expect(pickEvictionVictims(tiles, NOW, MAX_AGE, 10)).toEqual([])
  })

  test('expired tiles are evicted even if under cap', () => {
    const tiles: StoredTile[] = [
      tile({ key: 'fresh', fetchedAt: NOW - DAY, lastAccessed: NOW }),
      tile({ key: 'expired-a', fetchedAt: NOW - 40 * DAY, lastAccessed: NOW - 40 * DAY }),
      tile({ key: 'expired-b', fetchedAt: NOW - 60 * DAY, lastAccessed: NOW }),
    ]
    const victims = pickEvictionVictims(tiles, NOW, MAX_AGE, 10)
    expect(victims.sort()).toEqual(['expired-a', 'expired-b'])
  })

  test('over-cap set triggers LRU eviction by lastAccessed ascending', () => {
    // 5 fresh tiles, cap is 3 → evict the 2 least-recently-accessed.
    const tiles: StoredTile[] = [
      tile({ key: 'recent-1', fetchedAt: NOW - DAY, lastAccessed: NOW - 100 }),
      tile({ key: 'recent-2', fetchedAt: NOW - DAY, lastAccessed: NOW - 200 }),
      tile({ key: 'recent-3', fetchedAt: NOW - DAY, lastAccessed: NOW - 300 }),
      tile({ key: 'stale-a',  fetchedAt: NOW - DAY, lastAccessed: NOW - 10_000 }),
      tile({ key: 'stale-b',  fetchedAt: NOW - DAY, lastAccessed: NOW - 20_000 }),
    ]
    const victims = pickEvictionVictims(tiles, NOW, MAX_AGE, 3)
    expect(victims.sort()).toEqual(['stale-a', 'stale-b'])
  })

  test('expired + LRU both trigger: expired counted first, remaining subject to cap', () => {
    // 2 expired, 4 fresh, cap is 3 → evict both expired, then LRU-evict 1 fresh.
    const tiles: StoredTile[] = [
      tile({ key: 'expired-1', fetchedAt: NOW - 40 * DAY, lastAccessed: NOW }),
      tile({ key: 'expired-2', fetchedAt: NOW - 50 * DAY, lastAccessed: NOW }),
      tile({ key: 'fresh-new',    fetchedAt: NOW - DAY, lastAccessed: NOW - 100 }),
      tile({ key: 'fresh-mid-1',  fetchedAt: NOW - DAY, lastAccessed: NOW - 500 }),
      tile({ key: 'fresh-mid-2',  fetchedAt: NOW - DAY, lastAccessed: NOW - 1000 }),
      tile({ key: 'fresh-oldest', fetchedAt: NOW - DAY, lastAccessed: NOW - 5000 }),
    ]
    const victims = pickEvictionVictims(tiles, NOW, MAX_AGE, 3)
    // Expected: both expired + the oldest fresh one.
    expect(victims.sort()).toEqual(['expired-1', 'expired-2', 'fresh-oldest'])
  })

  test('LRU evicts correct count when surviving equals cap', () => {
    // 3 fresh, cap 3 → nothing evicted (boundary, not >).
    const tiles: StoredTile[] = [
      tile({ key: 'a', fetchedAt: NOW - DAY, lastAccessed: NOW - 100 }),
      tile({ key: 'b', fetchedAt: NOW - DAY, lastAccessed: NOW - 200 }),
      tile({ key: 'c', fetchedAt: NOW - DAY, lastAccessed: NOW - 300 }),
    ]
    expect(pickEvictionVictims(tiles, NOW, MAX_AGE, 3)).toEqual([])
  })

  test('LRU eviction preserves most-recently-accessed tiles', () => {
    // The tile touched most recently must survive regardless of fetchedAt age.
    const tiles: StoredTile[] = [
      tile({ key: 'fresh-fetch-old-access', fetchedAt: NOW - DAY, lastAccessed: NOW - 9999 }),
      tile({ key: 'old-fetch-new-access',   fetchedAt: NOW - 20 * DAY, lastAccessed: NOW }),
    ]
    const victims = pickEvictionVictims(tiles, NOW, MAX_AGE, 1)
    expect(victims).toEqual(['fresh-fetch-old-access'])
  })

  test('does not include expired tiles in LRU ranking', () => {
    // 3 fresh + 1 expired, cap 3 → evict the expired one, no LRU pressure.
    const tiles: StoredTile[] = [
      tile({ key: 'expired',  fetchedAt: NOW - 40 * DAY, lastAccessed: NOW }),
      tile({ key: 'fresh-1',  fetchedAt: NOW - DAY, lastAccessed: NOW - 100 }),
      tile({ key: 'fresh-2',  fetchedAt: NOW - DAY, lastAccessed: NOW - 200 }),
      tile({ key: 'fresh-3',  fetchedAt: NOW - DAY, lastAccessed: NOW - 300 }),
    ]
    const victims = pickEvictionVictims(tiles, NOW, MAX_AGE, 3)
    expect(victims).toEqual(['expired'])
  })

  test('custom maxAge and maxTiles honored together', () => {
    // 7-day TTL, 2-tile cap.
    const tiles: StoredTile[] = [
      tile({ key: 'expired', fetchedAt: NOW - 10 * DAY, lastAccessed: NOW }),
      tile({ key: 'fresh-old-access', fetchedAt: NOW - DAY, lastAccessed: NOW - 1000 }),
      tile({ key: 'fresh-mid-access', fetchedAt: NOW - DAY, lastAccessed: NOW - 500 }),
      tile({ key: 'fresh-new-access', fetchedAt: NOW - DAY, lastAccessed: NOW - 100 }),
    ]
    const victims = pickEvictionVictims(tiles, NOW, 7 * DAY, 2)
    // Expired first, then LRU-evict the oldest-accessed among survivors.
    expect(victims.sort()).toEqual(['expired', 'fresh-old-access'])
  })
})
