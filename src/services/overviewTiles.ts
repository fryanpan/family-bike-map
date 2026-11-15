/**
 * Baked 1.0° OVERVIEW tiles — the coarse level of the overlay's zoom pyramid,
 * used below OVERVIEW_MAX_ZOOM (docs/product/plans/2026-07-12-overlay-zoom-scale-plan.md).
 *
 * DISPLAY ONLY. The router keeps using 0.1° tiles via fetchBikeInfraForTile();
 * nothing here is reachable from clientRouter.ts / routeScorer.ts. An overview
 * tile is a REDUCTION of the detail tiles it covers, so it must never be fed to
 * anything that needs the complete network:
 *
 *   1. bike-infrastructure network only (classifyEdge → carFree || bikePriority
 *      || bikeInfra); plain quiet residential is dropped
 *   2. geometry simplified (Douglas-Peucker ~0.001°) and sub-200 m ways dropped
 *
 * Both reductions are baked in scripts/pipeline/bake-overview.ts. Ways keep
 * their FULL tags + enriched fields, so the client runs the SAME classifier and
 * the SAME visibility gates as on a detail tile — no parallel classification.
 *
 * 404 = "this region has no overview bake" (Berlin today). The caller then
 * falls back to the 0.1° path for exactly the cells that 404'd, which is
 * byte-for-byte today's behaviour in an un-baked region. That fallback is
 * load-bearing: without it Berlin's overlay goes blank below z12.
 */

import type { OsmWay } from '../utils/types'
import { isEnrichedTilePayload, parseEnrichedTileResponse, type BoundsLike } from './overpass'
import { OVERVIEW_TILE_DEGREES, type Tile } from '../utils/overlayZoom'
import { tileQueued, tileLoading, tileDone } from './tileLoadStatus'

const OVERVIEW_URL = '/api/overview'

// Cache keyed by cell coords, in its OWN namespace (the detail level's
// _tileCache in overpass.ts is keyed `row:col` on the 0.1° grid — cell (37,-123)
// and detail tile (37,-123) are different places on Earth and must not collide).
// A `null` entry is a REMEMBERED 404: the region isn't baked, so don't re-probe
// it on every pan. Only 404s are cached negative — a transient 5xx/network error
// returns null without caching, so it retries on the next load.
const _overviewCache = new Map<string, OsmWay[] | null>()

// In-flight requests, so two overlapping loads of the same cell (a pan that
// re-enters before the previous fetch resolved) share ONE request and BOTH
// callers see the same verdict — which matters because a caller that missed
// the "not baked" answer would skip the 0.1° fallback for that cell.
const _inflight = new Map<string, Promise<OsmWay[] | null>>()

/** Canonical key for a 1.0° overview cell. Namespaced away from tileKey(). */
export function overviewCellKey(row: number, col: number): string {
  return `ov:${row}:${col}`
}

/** True for keys minted by overviewCellKey (vs overpass.ts's `row:col` tileKey). */
export function isOverviewCellKey(key: string): boolean {
  return key.startsWith('ov:')
}

/** Overview cell (integer degrees) containing a lat/lng. */
export function latLngToOverviewCell(lat: number, lng: number): Tile {
  return {
    row: Math.floor(lat / OVERVIEW_TILE_DEGREES),
    col: Math.floor(lng / OVERVIEW_TILE_DEGREES),
  }
}

/** The overview cell that contains a 0.1° detail tile (10 × 10 detail tiles per cell). */
export function overviewCellForTile(row: number, col: number): Tile {
  return { row: Math.floor(row / 10), col: Math.floor(col / 10) }
}

/** Every overview cell intersecting the given bounds. */
export function getVisibleOverviewCells(bounds: BoundsLike): Tile[] {
  const minRow = Math.floor(bounds.getSouth() / OVERVIEW_TILE_DEGREES)
  const maxRow = Math.floor(bounds.getNorth() / OVERVIEW_TILE_DEGREES)
  const minCol = Math.floor(bounds.getWest() / OVERVIEW_TILE_DEGREES)
  const maxCol = Math.floor(bounds.getEast() / OVERVIEW_TILE_DEGREES)
  const cells: Tile[] = []
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) cells.push({ row: r, col: c })
  }
  return cells
}

/** Cached overview cell, or undefined when never fetched. `null` = known-unbaked (404). */
export function getCachedOverviewCell(row: number, col: number): OsmWay[] | null | undefined {
  return _overviewCache.get(overviewCellKey(row, col))
}

/** Test hook — drops the overview cache (including remembered 404s). */
export function _resetOverviewCache(): void {
  _overviewCache.clear()
  _inflight.clear()
}

/**
 * Fetch one baked overview cell.
 *
 * Returns the cell's ways, or **null** when the region has no overview bake —
 * the caller must then fall back to the 0.1° detail path for this cell.
 * Never throws: any error is a fail-soft null (fall back), because the detail
 * path is a strictly-better-data fallback, not a degraded one.
 *
 * The tile-status indicator is fed with the cell's CENTRE detail-tile coords
 * (row*10+5, col*10+5) so the loading UI + render-check settle signal work at
 * overview zoom without inventing a second status store.
 */
export function fetchOverviewTile(row: number, col: number): Promise<OsmWay[] | null> {
  const key = overviewCellKey(row, col)
  const cached = _overviewCache.get(key)
  if (cached !== undefined) return Promise.resolve(cached)

  const pending = _inflight.get(key)
  if (pending) return pending

  const req = fetchOverviewCell(row, col, key).finally(() => _inflight.delete(key))
  _inflight.set(key, req)
  return req
}

async function fetchOverviewCell(row: number, col: number, key: string): Promise<OsmWay[] | null> {
  const statusRow = row * 10 + 5
  const statusCol = col * 10 + 5
  tileQueued(statusRow, statusCol)
  tileLoading(statusRow, statusCol, null)
  try {
    const resp = await fetch(`${OVERVIEW_URL}?row=${row}&col=${col}`)
    if (resp.status === 404) {
      // Not baked. Remember it — an un-baked region must not re-probe every pan.
      _overviewCache.set(key, null)
      return null
    }
    if (!resp.ok) {
      console.warn(`[Overview] Cell ${row}:${col} HTTP ${resp.status} — falling back to 0.1° tiles`)
      return null
    }
    const data = await resp.json()
    if (!isEnrichedTilePayload(data)) {
      console.warn(`[Overview] Cell ${row}:${col} returned a non-enriched payload — falling back`)
      return null
    }
    const ways = parseEnrichedTileResponse(data)
    _overviewCache.set(key, ways)
    console.debug(`[Overview] Cell ${row}:${col} → ${ways.length} ways`)
    return ways
  } catch (err) {
    // Network error / bad JSON: fail soft to the detail path, and DON'T cache —
    // a transient failure must not permanently mark a baked region as unbaked.
    console.warn(`[Overview] Cell ${row}:${col} failed — falling back to 0.1° tiles:`, err)
    return null
  } finally {
    // Always 'done', never 'error': a miss here is a designed fallback, not a
    // failure the user should see a red tile box for.
    tileDone(statusRow, statusCol, 0)
  }
}
