import { describe, it, expect, afterEach } from 'bun:test'
import { fetchOverpass, OVERPASS_ENDPOINTS } from '../src/worker'

// The 2026-10-16 Boston outage: Cloudflare's Worker-to-overpass-api.de fetch
// returned a synthesized 521 and the proxy passed it straight through, so every
// tile outside the baked California region failed. These cover the fallback.

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const BODY = new TextEncoder().encode('[out:json];out;').buffer as ArrayBuffer

/** Stub fetch with a per-endpoint-host reply. `reply` may throw to simulate a
 *  connect failure. Records call order so we can assert we stopped early. */
function stubFetch(reply: (url: string) => Response) {
  const calls: string[] = []
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    calls.push(url)
    return reply(url)
  }) as any
  return calls
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('OVERPASS_ENDPOINTS', () => {
  it('lists more than one instance, so a single unreachable host is not an outage', () => {
    expect(OVERPASS_ENDPOINTS.length).toBeGreaterThan(1)
  })

  it('excludes overpass.osm.ch — it answers non-Swiss bboxes 200 with zero elements', () => {
    // A regional instance is the worst fallback: an empty elements array is
    // indistinguishable from "no bike infrastructure here" at every layer
    // above the proxy, so the map paints nothing and reports success.
    expect(OVERPASS_ENDPOINTS.some((e) => e.includes('osm.ch'))).toBe(false)
  })
})

describe('fetchOverpass', () => {
  it('uses the primary and does not call the fallback when the primary succeeds', async () => {
    const calls = stubFetch(() => json({ elements: [{ type: 'way', id: 1 }] }))
    const r = await fetchOverpass(BODY)

    expect(r.resp.status).toBe(200)
    expect(r.endpoint).toBe(OVERPASS_ENDPOINTS[0])
    expect(calls).toHaveLength(1)
    expect(r.attempts).toEqual([{ endpoint: OVERPASS_ENDPOINTS[0], status: 200 }])
  })

  it('falls back when the primary returns a Cloudflare 521 — the actual outage', async () => {
    const calls = stubFetch((url) =>
      url === OVERPASS_ENDPOINTS[0]
        ? new Response('error code: 521', { status: 521 })
        : json({ elements: [{ type: 'way', id: 7 }] }),
    )
    const r = await fetchOverpass(BODY)

    expect(r.resp.status).toBe(200)
    expect(r.endpoint).toBe(OVERPASS_ENDPOINTS[1])
    expect(calls).toHaveLength(2)
    expect(r.attempts[0]).toEqual({ endpoint: OVERPASS_ENDPOINTS[0], status: 521 })

    const payload = JSON.parse(new TextDecoder().decode(r.respBody))
    expect(payload.elements).toHaveLength(1)
  })

  it('falls back when the primary throws a connect error rather than responding', async () => {
    const calls = stubFetch((url) => {
      if (url === OVERPASS_ENDPOINTS[0]) throw new TypeError('Network connection lost')
      return json({ elements: [] })
    })
    const r = await fetchOverpass(BODY)

    expect(r.resp.status).toBe(200)
    expect(r.endpoint).toBe(OVERPASS_ENDPOINTS[1])
    expect(calls).toHaveLength(2)
    expect(r.attempts[0]).toEqual({ endpoint: OVERPASS_ENDPOINTS[0], status: 'TypeError' })
  })

  it('treats an empty elements array as a real answer, not a failure', async () => {
    // A tile with no bike infrastructure is common (ocean, rural). Retrying it
    // on every instance would double upstream load for no gain.
    const calls = stubFetch(() => json({ elements: [] }))
    const r = await fetchOverpass(BODY)

    expect(r.resp.status).toBe(200)
    expect(r.endpoint).toBe(OVERPASS_ENDPOINTS[0])
    expect(calls).toHaveLength(1)
  })

  it('returns a partial (remark) response without retrying it', async () => {
    // Overpass answers 200 + top-level "remark" when the query times out. The
    // caller declines to cache those; retrying mostly buys another timeout.
    const calls = stubFetch(() => json({ elements: [], remark: 'runtime error: Query timed out' }))
    const r = await fetchOverpass(BODY)

    expect(r.resp.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(new TextDecoder().decode(r.respBody)).toContain('"remark"')
  })

  it('passes through the last upstream status when every instance fails', async () => {
    const calls = stubFetch(() => new Response('gateway timeout', { status: 504 }))
    const r = await fetchOverpass(BODY)

    expect(r.resp.status).toBe(504)
    expect(calls).toHaveLength(OVERPASS_ENDPOINTS.length)
    expect(r.attempts.every((a) => a.status === 504)).toBe(true)
  })

  it('returns 502 with the attempt trail when every instance throws', async () => {
    // No upstream response exists to pass through, so the proxy answers for
    // itself. 502 says "my upstreams are broken", not "your request was bad".
    stubFetch(() => { throw new TypeError('Network connection lost') })
    const r = await fetchOverpass(BODY)

    expect(r.resp.status).toBe(502)
    expect(r.endpoint).toBe('none')
    expect(r.attempts).toHaveLength(OVERPASS_ENDPOINTS.length)

    const payload = JSON.parse(new TextDecoder().decode(r.respBody))
    expect(payload.error).toContain('unreachable')
    expect(payload.attempts).toHaveLength(OVERPASS_ENDPOINTS.length)
  })

  it('sends the same body to each instance it tries', async () => {
    const bodies: ArrayBuffer[] = []
    globalThis.fetch = (async (_u: any, init: any) => {
      bodies.push(init.body)
      return new Response('', { status: 521 })
    }) as any

    await fetchOverpass(BODY)
    expect(bodies).toHaveLength(OVERPASS_ENDPOINTS.length)
    for (const b of bodies) expect(new TextDecoder().decode(b)).toBe('[out:json];out;')
  })

  it('caps each attempt with an abort signal so one hung instance cannot eat the budget', async () => {
    const signals: (AbortSignal | undefined)[] = []
    globalThis.fetch = (async (_u: any, init: any) => {
      signals.push(init.signal)
      return new Response('{}', { status: 200 })
    }) as any

    await fetchOverpass(BODY)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
  })
})
