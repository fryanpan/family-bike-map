import { describe, test, expect } from 'bun:test'
import { isExpired, pickEvictionVictims, type StoredBaseTile } from '../src/services/baseTileCache'

// Helper: build a StoredBaseTile fixture with sensible defaults.
function tile(overrides: Partial<StoredBaseTile> & { key: string }): StoredBaseTile {
  return {
    blob: new Blob(),
    fetchedAt: 0,
    lastAccessed: 0,
    ...overrides,
  }
}

// 30-day TTL matching src/services/baseTileCache.ts MAX_AGE_MS.
const DAY = 24 * 60 * 60 * 1000
const MAX_AGE = 30 * DAY
const NOW = 1_700_000_000_000 // fixed reference time

describe('baseTileCache.isExpired', () => {
  test('fresh tile (just fetched) is not expired', () => {
    expect(isExpired(tile({ key: 'a', fetchedAt: NOW }), NOW, MAX_AGE)).toBe(false)
  })

  test('tile fetched 29 days ago is not expired', () => {
    expect(isExpired(tile({ key: 'a', fetchedAt: NOW - 29 * DAY }), NOW, MAX_AGE)).toBe(false)
  })

  test('tile fetched exactly 30 days ago is not expired (boundary, > not >=)', () => {
    expect(isExpired(tile({ key: 'a', fetchedAt: NOW - 30 * DAY }), NOW, MAX_AGE)).toBe(false)
  })

  test('tile fetched 31 days ago is expired', () => {
    expect(isExpired(tile({ key: 'a', fetchedAt: NOW - 31 * DAY }), NOW, MAX_AGE)).toBe(true)
  })

  test('checks fetchedAt, not lastAccessed (access-recency does not reset TTL)', () => {
    const stale = tile({ key: 'a', fetchedAt: NOW - 40 * DAY, lastAccessed: NOW - DAY })
    expect(isExpired(stale, NOW, MAX_AGE)).toBe(true)
  })
})

describe('baseTileCache.pickEvictionVictims', () => {
  test('empty input returns empty', () => {
    expect(pickEvictionVictims([], NOW, MAX_AGE, 100)).toEqual([])
  })

  test('all fresh + under cap → nothing evicted', () => {
    const tiles: StoredBaseTile[] = [
      tile({ key: 'a', fetchedAt: NOW - DAY, lastAccessed: NOW }),
      tile({ key: 'b', fetchedAt: NOW - 2 * DAY, lastAccessed: NOW - DAY }),
    ]
    expect(pickEvictionVictims(tiles, NOW, MAX_AGE, 10)).toEqual([])
  })

  test('expired tiles are evicted even if under cap', () => {
    const tiles: StoredBaseTile[] = [
      tile({ key: 'fresh', fetchedAt: NOW - DAY, lastAccessed: NOW }),
      tile({ key: 'expired', fetchedAt: NOW - 60 * DAY, lastAccessed: NOW }),
    ]
    expect(pickEvictionVictims(tiles, NOW, MAX_AGE, 10)).toEqual(['expired'])
  })

  test('LRU eviction trims the surviving set to maxTiles', () => {
    // 5 fresh, cap 3 → evict the 2 least-recently-accessed.
    const tiles: StoredBaseTile[] = [
      tile({ key: 'recent-1', fetchedAt: NOW - DAY, lastAccessed: NOW - 100 }),
      tile({ key: 'recent-2', fetchedAt: NOW - DAY, lastAccessed: NOW - 200 }),
      tile({ key: 'recent-3', fetchedAt: NOW - DAY, lastAccessed: NOW - 300 }),
      tile({ key: 'stale-a',  fetchedAt: NOW - DAY, lastAccessed: NOW - 10_000 }),
      tile({ key: 'stale-b',  fetchedAt: NOW - DAY, lastAccessed: NOW - 20_000 }),
    ]
    const victims = pickEvictionVictims(tiles, NOW, MAX_AGE, 3)
    expect(victims.sort()).toEqual(['stale-a', 'stale-b'])
  })

  test('expired + LRU compose: expired are dropped first, then LRU on the survivors', () => {
    const tiles: StoredBaseTile[] = [
      tile({ key: 'expired-1', fetchedAt: NOW - 40 * DAY, lastAccessed: NOW }),
      tile({ key: 'fresh-new',    fetchedAt: NOW - DAY, lastAccessed: NOW - 100 }),
      tile({ key: 'fresh-mid',    fetchedAt: NOW - DAY, lastAccessed: NOW - 500 }),
      tile({ key: 'fresh-oldest', fetchedAt: NOW - DAY, lastAccessed: NOW - 5000 }),
    ]
    const victims = pickEvictionVictims(tiles, NOW, MAX_AGE, 2)
    expect(victims.sort()).toEqual(['expired-1', 'fresh-oldest'])
  })
})
