import { describe, it, expect, beforeEach } from 'bun:test'
import {
  tileQueued, tileLoading, tileDone, tileError,
  __getTileLoadSnapshot, __resetTileLoadStatus,
} from '../src/services/tileLoadStatus'

describe('tileLoadStatus store', () => {
  beforeEach(() => __resetTileLoadStatus())

  it('starts inactive and empty', () => {
    const s = __getTileLoadSnapshot()
    expect(s.active).toBe(false)
    expect(s.totalCount).toBe(0)
  })

  it('tracks a tile through queued → loading → done', () => {
    tileQueued(377, -1225)
    let s = __getTileLoadSnapshot()
    expect(s.active).toBe(true)
    expect(s.queued.map((t) => t.key)).toEqual(['377:-1225'])
    expect(s.totalCount).toBe(1)

    tileLoading(377, -1225, 8_000_000)
    s = __getTileLoadSnapshot()
    expect(s.queued).toHaveLength(0)
    expect(s.loading).toHaveLength(1)
    expect(s.loading[0].totalBytes).toBe(8_000_000)

    tileDone(377, -1225, 7_900_000)
    s = __getTileLoadSnapshot()
    expect(s.loading).toHaveLength(0)
    expect(s.doneCount).toBe(1)
    expect(s.active).toBe(false)
    expect(s.loadedBytes).toBe(7_900_000)
  })

  it('distinguishes queued from loading when concurrency caps fetches', () => {
    tileQueued(1, 1)
    tileQueued(1, 2)
    tileQueued(1, 3)
    tileLoading(1, 1, null) // only one slot acquired so far
    const s = __getTileLoadSnapshot()
    expect(s.loading.map((t) => t.key)).toEqual(['1:1'])
    expect(s.queued.map((t) => t.key)).toEqual(['1:2', '1:3'])
    expect(s.totalCount).toBe(3)
  })

  it('counts errors and stays active while others load', () => {
    tileQueued(2, 1)
    tileQueued(2, 2)
    tileLoading(2, 1, null)
    tileError(2, 2)
    const s = __getTileLoadSnapshot()
    expect(s.errorCount).toBe(1)
    expect(s.active).toBe(true) // 2:1 still loading
  })

  it('starts a fresh burst once the previous one has fully settled', () => {
    tileQueued(3, 1)
    tileDone(3, 1, 100)
    expect(__getTileLoadSnapshot().active).toBe(false)
    // New burst — settled entries from the prior burst are cleared.
    tileQueued(4, 1)
    const s = __getTileLoadSnapshot()
    expect(s.totalCount).toBe(1)
    expect(s.queued.map((t) => t.key)).toEqual(['4:1'])
  })

  it('keeps tiles sorted by key for stable display', () => {
    tileQueued(5, 3)
    tileQueued(5, 1)
    tileQueued(5, 2)
    expect(__getTileLoadSnapshot().queued.map((t) => t.key)).toEqual(['5:1', '5:2', '5:3'])
  })
})
