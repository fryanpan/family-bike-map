import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'
import { NominatimGeocoder } from '../src/services/geocoder/NominatimGeocoder'
import type { Place } from '../src/utils/types'

// These tests exercise the Nominatim engine specifically (mocked fetch
// + Nominatim response shapes). The previous version called through
// `searchPlaces()` which routes via the active geocoder; that broke
// when the default flipped to Google because Bun's test env has no
// `window`. Calling NominatimGeocoder directly is closer to what
// we're actually testing anyway.

// `searchPlaces` is a one-liner over `autocomplete + placeDetails`.
// We replicate it here so the test still asserts end-to-end Place
// shape. Nominatim's `placeDetails` is a passthrough so this is the
// same logic the production facade runs.
async function searchPlacesNominatim(query: string): Promise<Place[]> {
  const engine = new NominatimGeocoder()
  const hits = await engine.autocomplete(query)
  const places = await Promise.all(hits.map((h) => engine.placeDetails(h)))
  return places.filter((p): p is Place => p !== null)
}

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
// We test the label mapping logic in isolation by mocking globalThis.fetch
// and observing the Place objects returned.

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
    const [place] = await searchPlacesNominatim('Dresdener Str 112')
    expect(place.shortLabel).toBe('Dresdener Straße 112')
  })

  it('uses road alone when no house_number', async () => {
    stubFetch([makeResult({ address: { road: 'Dresdener Straße' } })])
    const [place] = await searchPlacesNominatim('Dresdener Str')
    expect(place.shortLabel).toBe('Dresdener Straße')
  })

  it('uses POI name even when address.road is also present', async () => {
    // Regression: POI results (e.g. "Humboldt Forum") have both name and address.road.
    // shortLabel must be the POI name, not the road it sits on.
    stubFetch([makeResult({ name: 'Humboldt Forum', address: { road: 'Schloßplatz' } })])
    const [place] = await searchPlacesNominatim('Humboldt Forum')
    expect(place.shortLabel).toBe('Humboldt Forum')
  })

  it('uses name when no address', async () => {
    stubFetch([makeResult({ name: 'Tiergarten', address: undefined })])
    const [place] = await searchPlacesNominatim('Tiergarten')
    expect(place.shortLabel).toBe('Tiergarten')
  })

  it('falls back to first display_name segment when no name or address', async () => {
    stubFetch([makeResult({ name: undefined, address: undefined, display_name: 'Alexanderplatz, Mitte, Berlin' })])
    const [place] = await searchPlacesNominatim('Alexanderplatz')
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

    const results = await searchPlacesNominatim('Dresdener Str 112')

    // First call should be structured (contains street= param)
    expect(calls[0]).toContain('street=')
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

    const results = await searchPlacesNominatim('Dresdener Str 112')

    expect(callCount).toBe(2)
    expect(results).toHaveLength(1)
  })

  it('uses free-text (not structured) for non-address queries', async () => {
    const calls: string[] = []
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      calls.push(input.toString())
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch

    await searchPlacesNominatim('Tiergarten')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('q=Tiergarten')
  })

  it('falls back to free-text (q=) for address queries when structured returns nothing', async () => {
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

    await searchPlacesNominatim('Unter den Linden 1')

    const freeTextCall = calls.find((c) => c.includes('q='))
    expect(freeTextCall).toBeDefined()
  })

  it('returns empty array for queries shorter than 2 chars', async () => {
    expect(await searchPlacesNominatim('')).toEqual([])
    expect(await searchPlacesNominatim('A')).toEqual([])
  })
})
