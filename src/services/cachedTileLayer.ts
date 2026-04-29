/**
 * Custom Leaflet TileLayer with IndexedDB stale-while-revalidate.
 *
 * Reads tiles from `baseTileCache` first; if we have a fresh blob,
 * we paint it instantly (no network round-trip). In parallel we
 * still kick off a network fetch in the background to keep the
 * cache fresh — that update lands silently in IDB so the NEXT
 * visit gets the latest tile.
 *
 * On a cache miss, falls back to plain network fetch and stores
 * the result for next time.
 *
 * This makes the second-visit map paint sub-second: the browser
 * has all the tile imagery locally and never blocks on the tile
 * server. The service worker (`public/sw.js`) layers on top —
 * if registered, it intercepts the network refresh too, and a
 * cold-start with no IDB cache still gets HTTP-cache hits.
 */

import L from 'leaflet'
import { loadTile, storeTile, getFetchedAt } from './baseTileCache'

/**
 * Refresh cached tiles from network in the background only if the
 * cached tile is older than this. Avoids burning network on every
 * page view when the cache is fresh.
 */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

// Track which URLs we've already refreshed this session so we don't
// double-fire on tile re-renders within the same visit.
const refreshedThisSession = new Set<string>()

/**
 * Leaflet TileLayer subclass. Override only `createTile` — the rest of
 * the GridLayer machinery (zoom transitions, fade-in, error handling,
 * retain-zoom) keeps working as if this were a plain TileLayer.
 */
export class CachedTileLayer extends L.TileLayer {
  createTile(coords: L.Coords, done: L.DoneCallback): HTMLImageElement {
    const tile = document.createElement('img')

    // Standard TileLayer wiring — onload / onerror triggers Leaflet's
    // internal tile lifecycle. We delegate to _tileOnLoad / _tileOnError
    // so error tiles, fade-in, and retain-zoom work as expected.
    const onLoad = () => {
      ;(this as unknown as { _tileOnLoad: (done: L.DoneCallback, tile: HTMLImageElement) => void })
        ._tileOnLoad(done, tile)
    }
    const onError = (e: Event) => {
      ;(this as unknown as { _tileOnError: (done: L.DoneCallback, tile: HTMLImageElement, err: unknown) => void })
        ._tileOnError(done, tile, e)
    }
    tile.addEventListener('load', onLoad)
    tile.addEventListener('error', onError)

    if (this.options.crossOrigin || this.options.crossOrigin === '') {
      tile.crossOrigin = this.options.crossOrigin === true ? '' : (this.options.crossOrigin as string)
    }
    if (typeof this.options.referrerPolicy === 'string') {
      tile.referrerPolicy = this.options.referrerPolicy as ReferrerPolicy
    }
    tile.alt = ''

    const url = this.getTileUrl(coords)

    // Try IDB first. The promise resolves in ~1 ms for warm DBs;
    // Leaflet doesn't paint until tile.src is set, so the load
    // event lifecycle just waits a frame longer than a plain TileLayer
    // would on a cache hit (and skips a network round-trip entirely).
    void loadTile(url).then((blob) => {
      if (blob) {
        // Cache hit — paint immediately from local data.
        const objectUrl = URL.createObjectURL(blob)
        tile.src = objectUrl
        // Free the blob URL once the image has decoded so we don't
        // leak memory across pan + zoom.
        tile.addEventListener('load', () => URL.revokeObjectURL(objectUrl), { once: true })
        tile.addEventListener('error', () => URL.revokeObjectURL(objectUrl), { once: true })

        // Stale-while-revalidate: kick off a background refresh once per
        // session per URL. The fresh blob silently replaces the cached
        // one for next visit. We do NOT swap the on-screen image
        // mid-paint — that would flicker. Joanna's bar is "second load
        // is fast"; freshness on the THIRD load is fine.
        if (!refreshedThisSession.has(url)) {
          refreshedThisSession.add(url)
          void backgroundRefresh(url)
        }
      } else {
        // Cache miss — fetch from network and store.
        void fetchAndStore(url, tile)
      }
    }).catch(() => {
      // Defensive: any IDB error → fall through to plain network.
      tile.src = url
    })

    return tile
  }
}

async function fetchAndStore(url: string, tile: HTMLImageElement): Promise<void> {
  try {
    const resp = await fetch(url, { mode: 'cors' })
    if (!resp.ok) {
      // Surface the error to Leaflet via the standard error pathway.
      tile.src = url
      return
    }
    const blob = await resp.blob()
    const objectUrl = URL.createObjectURL(blob)
    tile.src = objectUrl
    tile.addEventListener('load', () => URL.revokeObjectURL(objectUrl), { once: true })
    tile.addEventListener('error', () => URL.revokeObjectURL(objectUrl), { once: true })
    void storeTile(url, blob)
  } catch {
    // Network failed entirely (offline, DNS, etc.) — fall back
    // to a direct src so Leaflet can show its standard error tile.
    tile.src = url
  }
}

/**
 * Background refresh: re-fetch a tile and write it to IDB. Doesn't
 * touch the on-screen image — only updates the cache for the next
 * visit. Bounded by `REFRESH_AFTER_MS` so we don't burn bandwidth
 * on every repeat view.
 */
async function backgroundRefresh(url: string): Promise<void> {
  try {
    const fetchedAt = await getFetchedAt(url)
    if (fetchedAt != null && Date.now() - fetchedAt < REFRESH_AFTER_MS) {
      return
    }
    const resp = await fetch(url, { mode: 'cors' })
    if (!resp.ok) return
    const fresh = await resp.blob()
    void storeTile(url, fresh)
  } catch {
    // background refresh is best-effort
  }
}
