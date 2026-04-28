/**
 * Unified Cloudflare Worker for Berlin Bike Route Finder
 *
 * Handles API routes (Overpass / Mapillary / Street View / Nominatim
 * proxies + D1 route logging). Static assets are served automatically by
 * the [assets] binding for non-API paths.
 *
 * Routes:
 *   /api/overpass        → proxy to overpass-api.de with 30-day edge cache
 *   /api/mapillary/*     → proxy to graph.mapillary.com with server-injected
 *                          token + 7-day edge cache
 *   /api/streetview      → proxy to Google Street View Static with server-
 *                          injected key + 7-day edge cache
 *   /api/nominatim/*     → proxy to nominatim.openstreetmap.org
 *   /api/route-log POST  → write a routing event to D1
 *
 * Endpoints removed for the public launch (2026-04-28):
 *   /api/valhalla/*    — unused (benchmark scripts hit upstream directly)
 *   /api/brouter       — unused (admin compare-links go to brouter.de directly)
 *   /api/rules/:region — unauthenticated KV write surface; never made it
 *                        useful in practice; classifier rules now compile-time only
 *   /api/feedback      — replaced by Userback widget
 *   /api/route-logs GET — exposed every logged trip unauthenticated;
 *                         inspection now via `wrangler d1 execute`
 *
 * Error reporting goes to the same Sentry project as the frontend, with
 * `tags.runtime = 'worker'` so the two stacks are filterable but cross-
 * correlatable on a shared release tag.
 */

import * as Sentry from '@sentry/cloudflare'

// Cloudflare Workers extends the standard CacheStorage interface with a `default`
// cache instance. This is not in the DOM lib types, so we declare it here.
declare const caches: CacheStorage & { default: Cache }

interface D1Database {
  prepare(query: string): D1PreparedStatement
}
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement
  run(): Promise<{ success: boolean }>
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>
}

type Env = {
  MAPILLARY_TOKEN?: string
  GOOGLE_MAPS_API_KEY?: string
  /** Sentry DSN for the Worker. Same project as the frontend; the
   *  `tags.runtime = 'worker'` set in withSentry() distinguishes them. */
  SENTRY_DSN?: string
  /** Release version, set per-deploy by CI (`0.1.<run_number>`). Lines
   *  up with the frontend's APP_VERSION so a regression shows up under
   *  the same Sentry release across both stacks. */
  APP_VERSION?: string
  /** 'production' on prod; absent or 'development' for `wrangler dev`. */
  SENTRY_ENV?: string
  ROUTE_LOGS: D1Database
  ASSETS: { fetch: (request: Request) => Promise<Response> }
}

const handler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // ── Overpass proxy with Cloudflare edge cache ─────────────────────
    // Proxying through the Worker (same-origin) avoids iOS content blockers
    // that block direct requests to overpass-api.de (a third-party domain).
    //
    // The Overpass API usage policy asks public-facing apps to avoid hitting
    // the public API on every user request. We comply by caching tile responses
    // at the Cloudflare edge (shared across ALL users, global) for 30 days.
    // First visitor pays the Overpass cost; everyone else gets the cached response.
    //
    // ?row=&col= query params identify the tile for the cache key.
    // Profile is intentionally excluded — the Overpass query is profile-independent
    // so one cache entry serves all travel modes.
    if (path === '/api/overpass') {
      const row = url.searchParams.get('row') ?? ''
      const col = url.searchParams.get('col') ?? ''

      // Synthetic GET URL used as Cloudflare cache key (POST responses aren't cacheable).
      const cacheKey = new Request(
        `https://overpass-tile-cache.internal/v1/${row}/${col}`,
      )

      const cached = await caches.default.match(cacheKey)
      if (cached) {
        return new Response(cached.body, {
          headers: {
            'Content-Type': 'application/json',
            'X-Cache': 'HIT',
          },
        })
      }

      const body = await request.arrayBuffer()
      const resp = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'FamilyBikeMap/0.1 (github.com/fryanpan/family-bike-map)',
        },
        body,
      })

      const respBody = await resp.arrayBuffer()

      // Only cache successful responses. Non-200 (429, 504) should not be cached
      // so the client can retry against a fresh Overpass response later.
      if (resp.ok) {
        const toCache = new Response(respBody, {
          headers: {
            'Content-Type': 'application/json',
            // 30-day TTL: OSM cycling edits are infrequent enough that monthly refresh is fine.
            'Cache-Control': 'public, max-age=2592000',
          },
        })
        await caches.default.put(cacheKey, toCache)
      }

      return new Response(respBody, {
        status: resp.status,
        headers: {
          'Content-Type': resp.headers.get('Content-Type') ?? 'application/json',
          'X-Cache': 'MISS',
        },
      })
    }

    // ── Mapillary proxy ───────────────────────────────────────────────
    // Mapillary tokens can NOT be referrer-locked — they're scoped by
    // permission (read/write/upload) but not by domain. Shipping the token
    // in the client bundle would let anyone copy it. So we proxy through
    // the Worker and inject the token server-side.
    //
    // Currently only `/api/mapillary/images` is consumed (from
    // src/services/mapillary.ts), but the proxy forwards anything under
    // /api/mapillary/* to graph.mapillary.com so future Mapillary endpoints
    // don't need a new route.
    //
    // Edge-cached for 7 days — Mapillary image metadata is stable (image
    // IDs, thumbnails, locations don't change once indexed) and the client
    // already caches in IndexedDB on top of this. Two layers of cache keeps
    // the Mapillary API well below its fair-use limits as the user base
    // grows.
    if (path.startsWith('/api/mapillary/')) {
      if (!env.MAPILLARY_TOKEN) {
        return new Response(JSON.stringify({ error: 'Mapillary token not configured' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const upstreamPath = path.replace(/^\/api\/mapillary/, '')
      // Rebuild query string, injecting the token. Strip any client-supplied
      // access_token to avoid token-spoofing that bypasses our server secret.
      const upstreamParams = new URLSearchParams(url.search)
      upstreamParams.delete('access_token')
      upstreamParams.set('access_token', env.MAPILLARY_TOKEN)
      const target = `https://graph.mapillary.com${upstreamPath}?${upstreamParams}`

      // Cache key excludes the token so the shared edge cache is keyed only
      // on request shape (bbox, fields, limit). Without this, each user's
      // proxied request would be a distinct cache entry because the query
      // string differs per user.
      const cacheKeyParams = new URLSearchParams(url.search)
      cacheKeyParams.delete('access_token')
      const cacheKeyUrl = `${url.origin}${path}?${cacheKeyParams}`
      const cacheKey = new Request(cacheKeyUrl, { method: 'GET' })
      const edgeCache = caches.default
      const cached = await edgeCache.match(cacheKey)
      if (cached) {
        return new Response(cached.body, {
          status: cached.status,
          headers: { ...Object.fromEntries(cached.headers), 'X-Cache': 'HIT' },
        })
      }

      const resp = await fetch(target, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
      const body = await resp.arrayBuffer()

      const response = new Response(body, {
        status: resp.status,
        headers: {
          'Content-Type': resp.headers.get('Content-Type') ?? 'application/json',
          'Cache-Control': 'public, max-age=604800', // 7 days
          'X-Cache': 'MISS',
        },
      })

      // Only cache successful responses — don't pollute the cache with
      // 429s or 5xxs.
      if (resp.ok) {
        // clone() because we need to consume the response body again below
        const toCache = response.clone()
        // waitUntil would be nicer, but we don't have ctx here; fire-and-forget is fine
        edgeCache.put(cacheKey, toCache).catch(() => {})
      }

      return response
    }

// ── Google Street View Static proxy ───────────────────────────────
    // Used by single-image popovers (routing-mode segment click, overlay
    // way click). Bulk image grids in the admin audit still use Mapillary
    // because Street View is $7/1000 and audit scans pull thousands.
    //
    // Pattern mirrors the Mapillary proxy: server-side API key, long edge
    // cache, strip any client-supplied key to prevent spoofing.
    //
    // Accepts: lat, lng, size (default 400x300), heading, pitch, fov.
    // Anything else in the query string is passed through.
    if (path === '/api/streetview') {
      if (!env.GOOGLE_MAPS_API_KEY) {
        return new Response(JSON.stringify({ error: 'Google Maps API key not configured' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      }

      const params = new URLSearchParams(url.search)
      params.delete('key')
      const lat = params.get('lat')
      const lng = params.get('lng')
      if (!lat || !lng) {
        return new Response(JSON.stringify({ error: 'lat and lng required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      params.delete('lat')
      params.delete('lng')
      params.set('location', `${lat},${lng}`)
      if (!params.get('size')) params.set('size', '400x300')
      params.set('key', env.GOOGLE_MAPS_API_KEY)
      const target = `https://maps.googleapis.com/maps/api/streetview?${params}`

      // Cache key: strip the key so the edge cache is shared across requests
      // with identical visible parameters.
      const cacheKeyParams = new URLSearchParams(url.search)
      cacheKeyParams.delete('key')
      const cacheKeyUrl = `${url.origin}${path}?${cacheKeyParams}`
      const cacheKey = new Request(cacheKeyUrl, { method: 'GET' })
      const edgeCache = caches.default
      const cached = await edgeCache.match(cacheKey)
      if (cached) {
        return new Response(cached.body, {
          status: cached.status,
          headers: { ...Object.fromEntries(cached.headers), 'X-Cache': 'HIT' },
        })
      }

      const resp = await fetch(target)
      const body = await resp.arrayBuffer()
      const response = new Response(body, {
        status: resp.status,
        headers: {
          'Content-Type': resp.headers.get('Content-Type') ?? 'image/jpeg',
          // Street View imagery is indexed; re-shoots happen every few
          // years in Berlin/SF. 30-day edge cache is safe and keeps our
          // per-viewer Google cost close to zero.
          'Cache-Control': 'public, max-age=2592000', // 30 days
          'X-Cache': 'MISS',
        },
      })

      if (resp.ok) {
        const toCache = response.clone()
        edgeCache.put(cacheKey, toCache).catch(() => {})
      }

      return response
    }

    // ── Nominatim proxy ───────────────────────────────────────────────
    if (path.startsWith('/api/nominatim/')) {
      const upstream = path.replace(/^\/api\/nominatim/, '')
      const target = `https://nominatim.openstreetmap.org${upstream}${url.search}`

      const resp = await fetch(target, {
        method: 'GET',
        headers: {
          'User-Agent': 'FamilyBikeMap/0.1 (github.com/fryanpan/family-bike-map)',
          'Accept': 'application/json',
        },
      })

      return new Response(await resp.arrayBuffer(), {
        status: resp.status,
        headers: { 'Content-Type': resp.headers.get('Content-Type') ?? 'application/json' },
      })
    }

    // ── Route logging (D1) ───────────────────────────────────────────
    if (path === '/api/route-log' && request.method === 'POST') {
      try {
        const body = await request.json() as Record<string, unknown>
        const id = (body.id as string) ?? crypto.randomUUID()
        await env.ROUTE_LOGS.prepare(
          `INSERT INTO route_logs (id, timestamp, start_lat, start_lng, start_label, end_lat, end_lng, end_label, travel_mode, engine, distance_m, duration_s, preferred_pct)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          id, body.timestamp ?? new Date().toISOString(),
          body.startLat, body.startLng, body.startLabel ?? null,
          body.endLat, body.endLng, body.endLabel ?? null,
          body.travelMode, body.engine,
          body.distanceM ?? null, body.durationS ?? null, body.preferredPct ?? null,
        ).run()
        return Response.json({ ok: true, id })
      } catch (err) {
        // D1 schema mismatches and connection failures are silent
        // otherwise — capture so /api/route-log breakage shows up in
        // Sentry rather than only in `wrangler tail`.
        Sentry.captureException(err, { extra: { route: '/api/route-log' } })
        return Response.json({ error: String(err) }, { status: 500 })
      }
    }

    // ── All other paths: serve static assets via [assets] binding ─────
    return env.ASSETS.fetch(request)
  },
}

export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    release: env.APP_VERSION ?? '0.0.0-unknown',
    environment: env.SENTRY_ENV ?? 'development',
    initialScope: { tags: { runtime: 'worker' } },
    // Errors only — no perf tracing.
    tracesSampleRate: 0,
    // If SENTRY_DSN isn't set (local `wrangler dev`), the SDK no-ops
    // gracefully and the Worker behaves identically.
  }),
  handler,
)

