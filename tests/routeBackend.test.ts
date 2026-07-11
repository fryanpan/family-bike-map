/**
 * Routing-backend setting plumbing (enriched-tiles plan, scope update
 * item 3): client default, server URL used when set, graceful fallback to
 * client routing on any server error.
 */
import { describe, test, expect, spyOn, afterEach } from 'bun:test'
import { serverRoute, routeLegViaBackend, type RouteLegRequest, type FetchLike } from '../src/services/routeBackend'
import { DEFAULT_SETTINGS } from '../src/services/adminSettings'
import type { Route } from '../src/utils/types'

const REQ: RouteLegRequest = {
  start: { lat: 52.5, lng: 13.4 },
  end: { lat: 52.51, lng: 13.41 },
  travelMode: 'kid-confident',
  preferredItemNames: new Set(['Bike path', 'Fahrradstrasse']),
}

const ROUTE: Route = {
  coordinates: [
    [52.5, 13.4],
    [52.51, 13.41],
  ],
  maneuvers: [],
  summary: { distance: 1.4, duration: 500 },
  engine: 'client',
}

interface RecordedCall {
  url: string
  init?: RequestInit
}

/** fetch stub recording calls and returning a canned Response. */
function fetchStub(respond: () => Response | Promise<Response>) {
  const calls: RecordedCall[] = []
  const fn: FetchLike = async (input, init) => {
    calls.push({ url: String(input), init })
    return respond()
  }
  return { fn, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Silence + observe the fallback warning without polluting test output.
let warnSpy: ReturnType<typeof spyOn> | null = null
function muteWarn() {
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
  return warnSpy
}
afterEach(() => {
  warnSpy?.mockRestore()
  warnSpy = null
})

// ── Default setting ─────────────────────────────────────────────────────────

describe('routingBackend setting', () => {
  test('defaults to empty string (client routing)', () => {
    expect(DEFAULT_SETTINGS.routingBackend).toBe('')
  })
})

// ── serverRoute contract ────────────────────────────────────────────────────

describe('serverRoute', () => {
  test('POSTs {start, end, travelMode, preferredItemNames[]} to <url>/route', async () => {
    const { fn, calls } = fetchStub(() => jsonResponse(ROUTE))
    await serverRoute('http://localhost:8787', REQ, fn)

    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('http://localhost:8787/route')
    expect(calls[0].init?.method).toBe('POST')
    expect((calls[0].init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    const body = JSON.parse(String(calls[0].init?.body))
    expect(body).toEqual({
      start: { lat: 52.5, lng: 13.4 },
      end: { lat: 52.51, lng: 13.41 },
      travelMode: 'kid-confident',
      preferredItemNames: ['Bike path', 'Fahrradstrasse'],
    })
  })

  test('sends avoidedWayIds on the wire when the avoid set is non-empty', async () => {
    // "Reroute around this" must reach the server — App.tsx passes the same
    // set to the clientRoute fallback, and the server mirrors it into its
    // own clientRoute call (identical-behavior contract).
    const { fn, calls } = fetchStub(() => jsonResponse(ROUTE))
    await serverRoute(
      'http://localhost:8787',
      { ...REQ, avoidedWayIds: new Set([42, 7]) },
      fn,
    )
    const body = JSON.parse(String(calls[0].init?.body))
    expect(body.avoidedWayIds).toEqual([42, 7])
  })

  test('omits avoidedWayIds from the wire when empty or absent', async () => {
    const { fn, calls } = fetchStub(() => jsonResponse(ROUTE))
    await serverRoute('http://x', { ...REQ, avoidedWayIds: new Set() }, fn)
    await serverRoute('http://x', REQ, fn)
    expect('avoidedWayIds' in JSON.parse(String(calls[0].init?.body))).toBe(false)
    expect('avoidedWayIds' in JSON.parse(String(calls[1].init?.body))).toBe(false)
  })

  test('strips trailing slashes from the backend URL', async () => {
    const { fn, calls } = fetchStub(() => jsonResponse(ROUTE))
    await serverRoute('http://localhost:8787///', REQ, fn)
    expect(calls[0].url).toBe('http://localhost:8787/route')
  })

  test('returns the route tagged engine "server"', async () => {
    const { fn } = fetchStub(() => jsonResponse(ROUTE))
    const result = await serverRoute('http://x', REQ, fn)
    expect(result).not.toBeNull()
    expect(result!.engine).toBe('server')
    expect(result!.coordinates).toEqual(ROUTE.coordinates)
    expect(result!.summary).toEqual(ROUTE.summary)
  })

  test('200 null passes through as null (server "no route", not an error)', async () => {
    const { fn } = fetchStub(() => jsonResponse(null))
    expect(await serverRoute('http://x', REQ, fn)).toBeNull()
  })

  test('throws on non-2xx status', async () => {
    const { fn } = fetchStub(() => jsonResponse({ error: 'end is outside the loaded tile region' }, 422))
    await expect(serverRoute('http://x', REQ, fn)).rejects.toThrow('422')
  })

  test('throws on a payload that is not route-shaped', async () => {
    const { fn } = fetchStub(() => jsonResponse({ hello: 'world' }))
    await expect(serverRoute('http://x', REQ, fn)).rejects.toThrow('unexpected payload')
  })

  test('throws on an unparseable body', async () => {
    const { fn } = fetchStub(() => new Response('<html>gateway error</html>', { status: 200 }))
    await expect(serverRoute('http://x', REQ, fn)).rejects.toThrow()
  })
})

// ── routeLegViaBackend branch + fallback ────────────────────────────────────

describe('routeLegViaBackend', () => {
  test('empty backend URL routes on the client and never touches the network', async () => {
    const { fn, calls } = fetchStub(() => jsonResponse(ROUTE))
    let clientCalls = 0
    const result = await routeLegViaBackend('', REQ, async () => { clientCalls++; return ROUTE }, fn)
    expect(result).toBe(ROUTE)
    expect(clientCalls).toBe(1)
    expect(calls.length).toBe(0)
  })

  test('whitespace-only backend URL counts as unset', async () => {
    const { fn, calls } = fetchStub(() => jsonResponse(ROUTE))
    let clientCalls = 0
    await routeLegViaBackend('   ', REQ, async () => { clientCalls++; return ROUTE }, fn)
    expect(clientCalls).toBe(1)
    expect(calls.length).toBe(0)
  })

  test('backend URL set: uses the server and skips client routing', async () => {
    const { fn } = fetchStub(() => jsonResponse(ROUTE))
    let clientCalls = 0
    const result = await routeLegViaBackend('http://x', REQ, async () => { clientCalls++; return ROUTE }, fn)
    expect(result!.engine).toBe('server')
    expect(clientCalls).toBe(0)
  })

  test('server 200 null passes through without client fallback (same "no route" semantics)', async () => {
    const { fn } = fetchStub(() => jsonResponse(null))
    let clientCalls = 0
    const result = await routeLegViaBackend('http://x', REQ, async () => { clientCalls++; return ROUTE }, fn)
    expect(result).toBeNull()
    expect(clientCalls).toBe(0)
  })

  test('falls back to client routing on network failure (with a console.warn)', async () => {
    const warn = muteWarn()
    const fn: FetchLike = async () => { throw new TypeError('fetch failed') }
    let clientCalls = 0
    const result = await routeLegViaBackend('http://x', REQ, async () => { clientCalls++; return ROUTE }, fn)
    expect(result).toBe(ROUTE)
    expect(clientCalls).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  test('falls back to client routing on a non-2xx response', async () => {
    muteWarn()
    const { fn } = fetchStub(() => jsonResponse({ error: 'internal server error' }, 500))
    let clientCalls = 0
    const result = await routeLegViaBackend('http://x', REQ, async () => { clientCalls++; return ROUTE }, fn)
    expect(result).toBe(ROUTE)
    expect(clientCalls).toBe(1)
  })

  test('falls back to client routing on a malformed payload', async () => {
    muteWarn()
    const { fn } = fetchStub(() => jsonResponse({ notARoute: true }))
    let clientCalls = 0
    const result = await routeLegViaBackend('http://x', REQ, async () => { clientCalls++; return ROUTE }, fn)
    expect(result).toBe(ROUTE)
    expect(clientCalls).toBe(1)
  })

  test('client fallback result is returned as-is (including null)', async () => {
    muteWarn()
    const { fn } = fetchStub(() => jsonResponse({ error: 'boom' }, 500))
    const result = await routeLegViaBackend('http://x', REQ, async () => null, fn)
    expect(result).toBeNull()
  })
})
