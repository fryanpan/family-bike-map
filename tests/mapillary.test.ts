import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test'

describe('getStreetImage', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns null when no token is configured', async () => {
    // import.meta.env.VITE_MAPILLARY_TOKEN is undefined by default in test env
    const { getStreetImage } = await import('../src/services/mapillary')
    const result = await getStreetImage(52.52, 13.405)
    expect(result).toBeNull()
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
})
