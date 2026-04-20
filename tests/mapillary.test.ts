import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'

// Stub IDB cache: the browser IDB is absent in bun, and we want tests to
// exercise the network-path logic (not a real cache). These stubs make
// readCache always miss and writeCache a no-op so existing tests pass
// unchanged.
mock.module('../src/services/mapillaryCache', () => ({
  readCache: async () => undefined,
  writeCache: async () => {},
}))

describe('getStreetImage', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    // Clear rate-limit state between tests.
    const mod = await import('../src/services/mapillary')
    mod.__resetRateLimitForTests()
  })

  it('returns null when no token is configured', async () => {
    const saved = import.meta.env.VITE_MAPILLARY_TOKEN
    import.meta.env.VITE_MAPILLARY_TOKEN = ''

    const { getStreetImage } = await import('../src/services/mapillary')
    const result = await getStreetImage(52.52, 13.405)
    expect(result).toBeNull()

    import.meta.env.VITE_MAPILLARY_TOKEN = saved
  })

  it('returns null on API error', async () => {
    // Temporarily set the env var so the function proceeds to fetch
    import.meta.env.VITE_MAPILLARY_TOKEN = 'test-token'

    globalThis.fetch = mock(async () =>
      new Response('Internal Server Error', { status: 500 })
    ) as unknown as typeof fetch

    // Re-import to pick up the env change within the module scope
    const { getStreetImage } = await import('../src/services/mapillary')
    const result = await getStreetImage(52.52, 13.405)
    expect(result).toBeNull()

    delete import.meta.env.VITE_MAPILLARY_TOKEN
  })

  it('returns null when API returns empty data array', async () => {
    import.meta.env.VITE_MAPILLARY_TOKEN = 'test-token'

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch

    const { getStreetImage } = await import('../src/services/mapillary')
    const result = await getStreetImage(52.52, 13.405)
    expect(result).toBeNull()

    delete import.meta.env.VITE_MAPILLARY_TOKEN
  })

  it('returns a MapillaryImage on success', async () => {
    import.meta.env.VITE_MAPILLARY_TOKEN = 'test-token'

    const mockData = {
      data: [
        {
          id: '12345',
          thumb_1024_url: 'https://example.com/thumb.jpg',
          computed_geometry: { coordinates: [13.405, 52.52] },
        },
      ],
    }

    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify(mockData), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    ) as unknown as typeof fetch

    const { getStreetImage } = await import('../src/services/mapillary')
    const result = await getStreetImage(52.52, 13.405)

    expect(result).toEqual({
      id: '12345',
      thumbUrl: 'https://example.com/thumb.jpg',
      lat: 52.52,
      lng: 13.405,
    })

    delete import.meta.env.VITE_MAPILLARY_TOKEN
  })

  it('returns null on HTTP 429 and skips subsequent calls during cooldown', async () => {
    import.meta.env.VITE_MAPILLARY_TOKEN = 'test-token'

    let fetchCalls = 0
    globalThis.fetch = mock(async () => {
      fetchCalls++
      return new Response('Too Many Requests', {
        status: 429,
        headers: { 'Retry-After': '60' },
      })
    }) as unknown as typeof fetch

    const { getStreetImage } = await import('../src/services/mapillary')
    const first = await getStreetImage(52.52, 13.405)
    expect(first).toBeNull()
    expect(fetchCalls).toBe(1)

    // Second call in cooldown window — must not hit the network.
    const second = await getStreetImage(52.53, 13.41)
    expect(second).toBeNull()
    expect(fetchCalls).toBe(1)

    delete import.meta.env.VITE_MAPILLARY_TOKEN
  })
})
