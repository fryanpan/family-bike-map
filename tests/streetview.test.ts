import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { getStreetViewCoverage } from '../src/services/streetview'

describe('getStreetViewCoverage', () => {
  let originalFetch: typeof fetch

  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('hits the Worker metadata proxy with lat/lng and no API key', async () => {
    let calledUrl = ''
    globalThis.fetch = (async (url: string | URL) => {
      calledUrl = typeof url === 'string' ? url : url.toString()
      return new Response(JSON.stringify({ status: 'OK' }), { status: 200 })
    }) as unknown as typeof fetch

    await getStreetViewCoverage(52.52, 13.405)
    expect(calledUrl.startsWith('/api/streetview/metadata')).toBe(true)
    expect(calledUrl.includes('lat=52.52')).toBe(true)
    expect(calledUrl.toLowerCase().includes('key')).toBe(false)
  })

  it("returns 'ok' when Google reports status OK", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 'OK' }), { status: 200 })) as unknown as typeof fetch
    expect(await getStreetViewCoverage(52.52, 13.405)).toBe('ok')
  })

  it("returns 'none' on ZERO_RESULTS (no coverage → caller falls back to Mapillary)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 'ZERO_RESULTS' }), { status: 200 })) as unknown as typeof fetch
    expect(await getStreetViewCoverage(52.52, 13.405)).toBe('none')
  })

  it("returns 'none' when the Worker is unconfigured (HTTP 503)", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: 'UNCONFIGURED' }), { status: 503 })) as unknown as typeof fetch
    expect(await getStreetViewCoverage(52.52, 13.405)).toBe('none')
  })

  it("returns 'none' on a network error", async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await getStreetViewCoverage(52.52, 13.405)).toBe('none')
  })
})
