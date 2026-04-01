import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'

// We test the internal helpers and the fetch-branching logic by mocking globalThis.fetch.

// Helper to build a Nominatim-style result
function makeResult(overrides: {
  display_name?: string
  name?: string
  lat?: string
  lon?: string
  address?: { road?: string; house_number?: string }
}) {
  return {
    display_name: 'Dresdener Straße 112, Kreuzberg, Berlin',
    name: undefined,
    lat: '52.5010',
    lon: '13.4097',
    ...overrides,
  }
}

// ── shortLabel formatting ─────────────────────────────────────────────────────
// We test the label mapping logic in isolation by importing the module and
// observing the Place objects returned from mocked fetch calls.

describe('searchPlaces — shortLabel formatting', () => {
  let originalFetch: typeof fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  function stubFetch(results: unknown[]) {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(results), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ) as unknown as typeof fetch
  }

  it('uses road + house_number as shortLabel when address details are present', async () => {
    stubFetch([makeResult({ address: { road: 'Dresdener Straße', house_number: '112' } })])
    const { searchPlaces } = await import('../src/services/geocoding')
    const [place] = await searchPlaces('Dresdener Str 112')
    expect(place.shortLabel).toBe('Dresdener Straße 112')
  })

  it('uses road alone when no house_number', async () => {
    stubFetch([makeResult({ address: { road: 'Dresdener Straße' } })])
    const { searchPlaces } = await import('../src/services/geocoding')
    const [place] = await searchPlaces('Dresdener Str')
    expect(place.shortLabel).toBe('Dresdener Straße')
  })

  it('falls back to name when no address', async () => {
    stubFetch([makeResult({ name: 'Tiergarten', address: undefined })])
    const { searchPlaces } = await import('../src/services/geocoding')
    const [place] = await searchPlaces('Tiergarten')
    expect(place.shortLabel).toBe('Tiergarten')
  })

  it('falls back to first display_name segment when no name or address', async () => {
    stubFetch([makeResult({ name: undefined, address: undefined, display_name: 'Alexanderplatz, Mitte, Berlin' })])
    const { searchPlaces } = await import('../src/services/geocoding')
    const [place] = await searchPlaces('Alexanderplatz')
    expect(place.shortLabel).toBe('Alexanderplatz')
  })
})

// ── structured vs free-text branching ────────────────────────────────────────
describe('searchPlaces — structured address search', () => {
  let originalFetch: typeof fetch
  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(() => { globalThis.fetch = originalFetch })

  it('issues a structured search for address-like queries and returns those results', async () => {
    const addressResult = makeResult({ address: { road: 'Dresdener Straße', house_number: '112' } })
    const calls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = input.toString()
      calls.push(url)
      return new Response(JSON.stringify([addressResult]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const { searchPlaces } = await import('../src/services/geocoding')
    const results = await searchPlaces('Dresdener Str 112')

    // First call should be structured (contains street= param)
    expect(calls[0]).toContain('street=')
    expect(calls[0]).toContain('city=Berlin')
    // Should return without falling through to free-text
    expect(calls).toHaveLength(1)
    expect(results).toHaveLength(1)
    expect(results[0].shortLabel).toBe('Dresdener Straße 112')
  })

  it('falls through to free-text when structured search returns no results', async () => {
    const freeTextResult = makeResult({ address: { road: 'Dresdener Straße', house_number: '112' } })
    let callCount = 0
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      callCount++
      const url = input.toString()
      // First call (structured) returns empty; second (free-text) returns result
      const body = url.includes('street=') ? [] : [freeTextResult]
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const { searchPlaces } = await import('../src/services/geocoding')
    const results = await searchPlaces('Dresdener Str 112')

    expect(callCount).toBe(2)
    expect(results).toHaveLength(1)
  })

  it('uses free-text with bounded=1 for non-address queries', async () => {
    const calls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      calls.push(input.toString())
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const { searchPlaces } = await import('../src/services/geocoding')
    await searchPlaces('Tiergarten')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('q=Tiergarten')
    expect(calls[0]).toContain('bounded=1')
  })

  it('uses bounded=0 for address free-text fallback', async () => {
    const calls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      calls.push(input.toString())
      // structured returns empty, free-text returns result
      const url = input.toString()
      const body = url.includes('street=') ? [] : [makeResult({})]
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    const { searchPlaces } = await import('../src/services/geocoding')
    await searchPlaces('Unter den Linden 1')

    const freeTextCall = calls.find((c) => c.includes('q='))
    expect(freeTextCall).toContain('bounded=0')
  })

  it('returns empty array for queries shorter than 2 chars', async () => {
    const { searchPlaces } = await import('../src/services/geocoding')
    expect(await searchPlaces('')).toEqual([])
    expect(await searchPlaces('A')).toEqual([])
  })
})
