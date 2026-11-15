import { describe, it, expect } from 'bun:test'
import { TileFetchClaims } from '../src/services/tileFetchClaims'

describe('TileFetchClaims', () => {
  it('records a claim and reports it in flight', () => {
    const claims = new TileFetchClaims()
    expect(claims.has('377:-1225')).toBe(false)
    const c = claims.claim('377:-1225')
    expect(claims.has('377:-1225')).toBe(true)
    expect(claims.size).toBe(1)
    expect(c.signal.aborted).toBe(false)
  })

  it('aborts only the keys the viewport no longer wants', () => {
    const claims = new TileFetchClaims()
    const keep = claims.claim('a')
    const drop1 = claims.claim('b')
    const drop2 = claims.claim('c')

    expect(claims.abandonSuperseded(['a']).sort()).toEqual(['b', 'c'])

    expect(keep.signal.aborted).toBe(false)
    expect(drop1.signal.aborted).toBe(true)
    expect(drop2.signal.aborted).toBe(true)
  })

  // Aborting does not stop a fetch that already holds a gate slot, and
  // dropping its claim would let a rider who panned away and back start a
  // second fetch for a tile already downloading, taking another of the two
  // slots. A started fetch is therefore left strictly alone.
  it('leaves a started fetch alone, claim and all', () => {
    const claims = new TileFetchClaims()
    const c = claims.claim('a')
    claims.markStarted('a')

    expect(claims.abandonSuperseded([])).toEqual([])

    expect(c.signal.aborted).toBe(false) // aborting it would do nothing anyway
    expect(claims.has('a')).toBe(true)   // still downloading — do not re-request
    claims.releaseIfCurrent('a', c)
    expect(claims.has('a')).toBe(false)
  })

  // The other half of that split: a waiter still in the gate's queue is dead
  // the moment it is aborted, and has to be re-requestable at once. Holding
  // its claim is what made the return leg paint 35.6% of a cold load.
  it('drops a queued waiter immediately so the tile can be re-requested', () => {
    const claims = new TileFetchClaims()
    const c = claims.claim('a')

    expect(claims.abandonSuperseded([])).toEqual(['a'])

    expect(c.signal.aborted).toBe(true)
    expect(claims.has('a')).toBe(false)
    expect(claims.size).toBe(0)
  })

  it('reports nothing the second time, having already dropped the waiter', () => {
    const claims = new TileFetchClaims()
    claims.claim('a')
    expect(claims.abandonSuperseded([])).toEqual(['a'])
    expect(claims.abandonSuperseded([])).toEqual([])
  })

  it('ignores markStarted for a key it never claimed', () => {
    const claims = new TileFetchClaims()
    claims.markStarted('ghost')
    expect(claims.has('ghost')).toBe(false)
  })

  it('keeps a desired key that has no claim without inventing one', () => {
    const claims = new TileFetchClaims()
    claims.claim('a')
    expect(claims.abandonSuperseded(['a', 'never-claimed'])).toEqual([])
    expect(claims.size).toBe(1)
  })

  // A reset bumps the generation, so a started fetch's result is discarded
  // on arrival. Holding its claim would only stop the new generation from
  // requesting that tile at all.
  it('drops every claim on reset, started fetches included', () => {
    const claims = new TileFetchClaims()
    const queued = claims.claim('a')
    const started = claims.claim('b')
    claims.markStarted('b')

    claims.abandonAll()

    expect(queued.signal.aborted).toBe(true)
    expect(claims.size).toBe(0)
    // the started fetch settles later and must not disturb the new generation
    expect(claims.releaseIfCurrent('b', started)).toBe(false)
  })

  it('releases a claim when its own fetch settles', () => {
    const claims = new TileFetchClaims()
    const c = claims.claim('a')
    expect(claims.releaseIfCurrent('a', c)).toBe(true)
    expect(claims.has('a')).toBe(false)
  })

  // The regression this class exists for: an abandoned fetch settles AFTER
  // the rider has come back and a new fetch for the same tile is already in
  // flight. Retracting the claim unconditionally there left the new fetch
  // unclaimed, and the next viewport event fetched the same tile twice.
  it('does not let a late abandoned fetch retract a newer claim', () => {
    const claims = new TileFetchClaims()
    const first = claims.claim('377:-1225')

    claims.abandonSuperseded([])            // rider pans away
    expect(first.signal.aborted).toBe(true)

    const second = claims.claim('377:-1225') // rider comes back, refetch starts
    expect(claims.has('377:-1225')).toBe(true)

    // a second settlement from the abandoned fetch must not touch the new claim
    expect(claims.releaseIfCurrent('377:-1225', first)).toBe(false)
    expect(claims.has('377:-1225')).toBe(true)
    expect(second.signal.aborted).toBe(false)

    // and the live fetch can still retract its own claim
    expect(claims.releaseIfCurrent('377:-1225', second)).toBe(true)
    expect(claims.has('377:-1225')).toBe(false)
  })

  it('ignores a release for a key it never held', () => {
    const claims = new TileFetchClaims()
    expect(claims.releaseIfCurrent('nope', new AbortController())).toBe(false)
  })
})
