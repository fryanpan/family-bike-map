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

  // Aborting does not stop a fetch that already holds a gate slot, so the
  // claim has to outlive the abort. Dropping it here let a rider who panned
  // away and back start a second fetch for a tile already downloading.
  it('keeps an aborted claim until its fetch settles', () => {
    const claims = new TileFetchClaims()
    const c = claims.claim('a')

    claims.abandonSuperseded([])

    expect(c.signal.aborted).toBe(true)
    expect(claims.has('a')).toBe(true)   // still in flight — do not re-request
    expect(claims.size).toBe(1)

    claims.releaseIfCurrent('a', c)      // the fetch finally settles
    expect(claims.has('a')).toBe(false)
  })

  it('does not re-abort a claim it already abandoned', () => {
    const claims = new TileFetchClaims()
    claims.claim('a')
    expect(claims.abandonSuperseded([])).toEqual(['a'])
    expect(claims.abandonSuperseded([])).toEqual([])
  })

  it('keeps a desired key that has no claim without inventing one', () => {
    const claims = new TileFetchClaims()
    claims.claim('a')
    expect(claims.abandonSuperseded(['a', 'never-claimed'])).toEqual([])
    expect(claims.size).toBe(1)
  })

  it('aborts everything on reset, and the claims clear as they settle', () => {
    const claims = new TileFetchClaims()
    const a = claims.claim('a')
    const b = claims.claim('b')
    claims.abandonAll()
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    expect(claims.size).toBe(2)
    claims.releaseIfCurrent('a', a)
    claims.releaseIfCurrent('b', b)
    expect(claims.size).toBe(0)
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
    claims.releaseIfCurrent('377:-1225', first) // the queued waiter rejects

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
