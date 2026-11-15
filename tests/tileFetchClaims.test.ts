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

  it('aborts and drops only the keys the viewport no longer wants', () => {
    const claims = new TileFetchClaims()
    const keep = claims.claim('a')
    const drop1 = claims.claim('b')
    const drop2 = claims.claim('c')

    const dropped = claims.abandonSuperseded(['a'])

    expect(dropped.sort()).toEqual(['b', 'c'])
    expect(claims.has('a')).toBe(true)
    expect(keep.signal.aborted).toBe(false)
    expect(drop1.signal.aborted).toBe(true)
    expect(drop2.signal.aborted).toBe(true)
    expect(claims.size).toBe(1)
  })

  it('keeps a desired key that has no claim without inventing one', () => {
    const claims = new TileFetchClaims()
    claims.claim('a')
    expect(claims.abandonSuperseded(['a', 'never-claimed'])).toEqual([])
    expect(claims.size).toBe(1)
  })

  it('abandons everything on reset', () => {
    const claims = new TileFetchClaims()
    const a = claims.claim('a')
    const b = claims.claim('b')
    claims.abandonAll()
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
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

    const second = claims.claim('377:-1225') // rider comes back, refetch starts
    expect(claims.has('377:-1225')).toBe(true)

    // first's cleanup finally runs, one microtask late
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
