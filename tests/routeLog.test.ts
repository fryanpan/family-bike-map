import { describe, it, expect, mock, beforeEach } from 'bun:test'
import { logRoute } from '../src/services/routeLog'

describe('logRoute', () => {
  beforeEach(() => {
    // Reset global fetch mock between tests
  })

  it('sends a POST request to /api/route-log with the correct body', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('{"ok":true}', { status: 200 })
    }) as typeof fetch

    const params = {
      startLat: 52.5,
      startLng: 13.4,
      startLabel: 'Home',
      endLat: 52.51,
      endLng: 13.42,
      endLabel: 'School',
      travelMode: 'kid-starting-out',
      engine: 'valhalla',
      distanceM: 2500,
      durationS: 600,
      preferredPct: 0.75,
    }

    await logRoute(params)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/route-log')
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(calls[0].init.body as string)).toEqual(params)

    globalThis.fetch = originalFetch
  })

  it('does not throw when fetch fails', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error('Network error')
    }) as unknown as typeof fetch

    // Should not throw
    await logRoute({
      startLat: 52.5,
      startLng: 13.4,
      endLat: 52.51,
      endLng: 13.42,
      travelMode: 'kid-starting-out',
      engine: 'valhalla',
    })

    globalThis.fetch = originalFetch
  })
})
