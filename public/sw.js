/**
 * Hand-rolled service worker for sub-second second-load and offline support.
 *
 * Caches three classes of resources:
 *
 *   1. App shell — HTML, JS bundles, CSS, fonts, marker images.
 *      Strategy: cache-first. The shell rarely changes within a deploy
 *      and we want it to paint instantly on a return visit. We bust
 *      the cache when the SW version constants below bump (any deploy
 *      that needs to invalidate cached assets), via the activate cleanup.
 *
 *   2. OpenStreetMap / MapTiler base tiles.
 *      Strategy: stale-while-revalidate. Serve cached tiles
 *      immediately if present, kick off a fresh fetch in the
 *      background. The CachedTileLayer in Leaflet has its own
 *      IndexedDB layer too — both are belt-and-suspenders so
 *      that whichever path runs first paints fast.
 *
 *   3. Overpass tiles via /api/overpass (we only see them as GETs
 *      if a future change adds a GET endpoint; the current POST
 *      path bypasses SW caching, which is correct since IndexedDB
 *      already handles that data).
 *
 * Anything not matched is passed through to network unchanged.
 * Route compute (POST /api/overpass) is intentionally NOT cached:
 * bike-path data needs to come from a live Overpass call, and
 * offline routing isn't a goal — Joanna explicitly OK'd that.
 *
 * Versioning: bump the version constants below when the cache shape
 * changes in a non-backwards-compatible way. Vite content-hashes
 * bundle URLs, so new shells naturally appear as fresh cache keys
 * and don't collide with prior versions; we just need to evict the
 * old ones in `activate`.
 */

// Bumped to v2 (2026-05-05) along with the network-first switch for HTML
// — the v1 cache holds shells with dead chunk-hash references that fire
// "Strict MIME type", "X is not defined", and "Failed to fetch
// dynamically imported module" errors in Sentry. Activate cleanup
// drops v1 entirely on first install of v2.
const APP_SHELL_CACHE = 'family-bike-map-shell-v2'
const TILE_CACHE = 'family-bike-map-tiles-v1'

const ALL_CACHES = [APP_SHELL_CACHE, TILE_CACHE]

self.addEventListener('install', (_event) => {
  // Activate immediately on first install — don't wait for the user
  // to close every tab. The new SW takes over on next page load.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop old caches that don't match the current version constants.
    const keys = await caches.keys()
    await Promise.all(
      keys
        .filter((k) => k.startsWith('family-bike-map-') && !ALL_CACHES.includes(k))
        .map((k) => caches.delete(k))
    )
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // Base map tiles — stale-while-revalidate.
  if (
    url.hostname === 'tile.openstreetmap.org' ||
    url.hostname.endsWith('.tile.openstreetmap.org') ||
    url.hostname.endsWith('.tile.osm.org') ||
    url.hostname === 'api.maptiler.com'
  ) {
    event.respondWith(staleWhileRevalidate(request, TILE_CACHE))
    return
  }

  // App shell — same-origin GETs that look like static assets.
  // The HTML document goes network-first: a deploy ships a fresh
  // index.html that references new content-hashed chunk URLs, and
  // serving the stale cached shell produces the now-classic "Strict
  // MIME type checking is enforced for module scripts" + "X is not
  // defined" errors when the old HTML tries to load chunks that no
  // longer exist on the CDN. Network-first keeps offline working
  // (falls back to cache when offline) and guarantees deploys are
  // picked up on the next pageload.
  //
  // /assets/* and other content-hashed files keep cache-first since
  // their URLs are unique per build and never collide.
  if (url.origin === self.location.origin) {
    if (isHtmlDocument(url)) {
      event.respondWith(networkFirst(request, APP_SHELL_CACHE))
      return
    }
    if (isAppShell(url)) {
      event.respondWith(cacheFirst(request, APP_SHELL_CACHE))
      return
    }
  }

  // Everything else: bypass the SW entirely.
})

/**
 * The HTML document — handled network-first so deploys are picked up
 * immediately. Cached as a fallback for offline.
 */
function isHtmlDocument(url) {
  const path = url.pathname
  if (path === '/' || path === '/index.html') return true
  return false
}

/**
 * Decide whether a same-origin GET should be cached as part of the app
 * shell with a cache-first strategy. Content-hashed assets only —
 * the HTML document is handled separately via isHtmlDocument +
 * networkFirst.
 */
function isAppShell(url) {
  const path = url.pathname
  if (path.startsWith('/api/')) return false
  // Vite-emitted bundles live under /assets/ with a content hash —
  // safe to cache aggressively.
  if (path.startsWith('/assets/')) return true
  // Static files at the root
  if (
    path.endsWith('.js') ||
    path.endsWith('.css') ||
    path.endsWith('.png') ||
    path.endsWith('.svg') ||
    path.endsWith('.ico') ||
    path.endsWith('.woff') ||
    path.endsWith('.woff2') ||
    path.endsWith('.json') // version.json, etc.
  ) {
    return true
  }
  return false
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)
  if (cached) {
    // Refresh in background but don't await — the cache is good
    // enough to ship right now.
    refreshInBackground(request, cache)
    return cached
  }
  try {
    const response = await fetch(request)
    if (response.ok) {
      // Clone before stashing — Response bodies are one-shot streams.
      cache.put(request, response.clone()).catch(() => {})
    }
    return response
  } catch (err) {
    // Offline + nothing in cache. Best we can do is rethrow so the
    // browser shows its standard offline error.
    throw err
  }
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const fresh = await fetch(request)
    if (fresh.ok) {
      cache.put(request, fresh.clone()).catch(() => {})
    }
    return fresh
  } catch (err) {
    // Offline: fall back to cache. If we have nothing, rethrow so the
    // browser shows its own offline error rather than a 504.
    const cached = await cache.match(request)
    if (cached) return cached
    throw err
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request)

  const network = fetch(request).then((response) => {
    if (response.ok) {
      cache.put(request, response.clone()).catch(() => {})
    }
    return response
  }).catch(() => null)

  if (cached) {
    // Don't await the network fetch — let it run in background.
    return cached
  }

  // No cache — wait on network. If the network fails the caller
  // sees the rejection, which is correct (we have nothing to serve).
  const fresh = await network
  if (fresh) return fresh
  // Last resort: synthesize a 504 so the caller knows it failed
  // for a network reason rather than a bug in our SW.
  return new Response('', { status: 504, statusText: 'Offline' })
}

async function refreshInBackground(request, cache) {
  try {
    const response = await fetch(request)
    if (response.ok) {
      await cache.put(request, response)
    }
  } catch {
    // Stay quiet — the user already has a working response.
  }
}
