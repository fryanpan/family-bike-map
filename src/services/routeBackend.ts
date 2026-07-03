// Routing-backend seam.
//
// The admin setting `routingBackend` selects where a route leg is computed:
// '' (default) = in-browser clientRoute; a URL = the bun route server
// (server/route-server.ts), which runs THE SAME routing code over enriched
// tiles held in memory. This module owns only the transport + fallback
// branch — it contains NO routing, classification, or costing logic
// (one-implementation rule), and App.tsx's waypoint leg loop is its single
// caller.
//
// Contract with the server (see server/route-server.ts):
//   POST <url>/route  {start:{lat,lng}, end:{lat,lng}, travelMode,
//                      preferredItemNames: string[]}
//     → 200 with the exact clientRoute result: a Route JSON, or `null`
//       when no path exists.
//
// Fallback policy: ANY transport or protocol error (network failure,
// non-2xx status, unparseable or malformed payload) falls back to the
// in-browser router with a console.warn — the server is an optimization,
// never a availability dependency. A 200 `null` is NOT an error: it is the
// server's "no route found", the same answer clientRoute would give on the
// same data, and passes through unchanged.

import type { Route } from '../utils/types'

export interface RouteLegRequest {
  start: { lat: number; lng: number }
  end: { lat: number; lng: number }
  /** Ride mode key, e.g. 'kid-confident' — mode stays a client-side concept
   *  sent per request (enriched-tiles plan, scope update item 3). */
  travelMode: string
  preferredItemNames: Set<string>
}

/** The subset of `fetch` this module uses — injectable in tests without
 *  dragging in runtime-specific statics (bun's fetch.preconnect etc.). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

function isRouteLike(data: unknown): data is Route {
  if (data == null || typeof data !== 'object') return false
  const route = data as Partial<Route>
  return Array.isArray(route.coordinates) && route.summary != null && typeof route.summary === 'object'
}

/**
 * Route one leg on the server backend. Throws on any transport/protocol
 * error (the caller decides the fallback); returns null when the server
 * found no route.
 *
 * `fetchFn` is injectable for tests only — production callers omit it.
 */
export async function serverRoute(
  backendUrl: string,
  req: RouteLegRequest,
  fetchFn: FetchLike = (...args) => globalThis.fetch(...args),
): Promise<Route | null> {
  const url = `${backendUrl.replace(/\/+$/, '')}/route`
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      start: req.start,
      end: req.end,
      travelMode: req.travelMode,
      preferredItemNames: [...req.preferredItemNames],
    }),
  })
  if (!res.ok) {
    throw new Error(`route server responded ${res.status}`)
  }
  const data: unknown = await res.json()
  if (data === null) return null
  if (!isRouteLike(data)) {
    throw new Error('route server returned an unexpected payload')
  }
  // Tag the engine so route logs / the audit tab can tell the backends
  // apart (the phone-benchmark deliverable compares them).
  return { ...data, engine: 'server' }
}

/**
 * The single routing branch: server backend when `backendUrl` is set,
 * in-browser routing otherwise, with fallback to in-browser on any server
 * error. `clientRouteFn` is the caller's already-parameterized clientRoute
 * closure — this module never imports clientRouter.
 */
export async function routeLegViaBackend(
  backendUrl: string,
  req: RouteLegRequest,
  clientRouteFn: () => Promise<Route | null>,
  fetchFn?: FetchLike,
): Promise<Route | null> {
  const url = backendUrl.trim()
  if (!url) return clientRouteFn()
  try {
    return await serverRoute(url, req, fetchFn)
  } catch (err) {
    console.warn('[routeBackend] server routing failed — falling back to client routing:', err)
    return clientRouteFn()
  }
}
