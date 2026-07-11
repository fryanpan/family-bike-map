// Deterministic zoom/viewport policy for the bike-infra overlay.
//
// Everything here is a PURE function of (viewport, zoom) — never of
// navigation history. Two clients that arrive at the same viewport+zoom by
// different routes (one panned in from a neighbour, one deep-linked straight
// to it) MUST fetch the same tiles and paint the same simplification. The
// old behaviour gated fetch on a tile-count cliff: below it nothing fetched,
// so a zoomed-out user saw whatever tiles they had happened to load while
// zoomed in. That history-dependence is the bug this module removes.

/** A 0.1° tile identified by its row/col (see overpass.ts latLngToTile). */
export interface Tile { row: number; col: number }

// Upper bound on tiles fetched (and therefore painted) for one viewport.
// Sized from measurement over real SF R2 tiles: a phone citywide view (z11)
// spans ~24 tiles, a laptop ~66; 64 covers both and every z12+ viewport in
// full. It also bounds the per-render classify + deck.gl rebuild cost, which
// scales with painted-way count. Beyond this (desktop z11 outer ring, z10 and
// further out) the central subset is covered and the rest is a deterministic
// gap — full coverage at those zooms wants baked overview tiles (B2).
export const MAX_FETCH_TILES = 64

// At or above this zoom the overlay paints exactly as it did before this
// change: full halos, full-width finger-tap hit layer, full stroke weight.
// Below it the view is a city/metro OVERVIEW where those per-way extras are
// visual noise AND triple the deck.gl work (three layers per way instead of
// one), so overviewStyle strips them. 12 is chosen so metro zooms (z12-13,
// which already worked under the old 30-tile cap) are untouched — the change
// only adds the previously-ungated z11-and-below overview band.
export const OVERVIEW_MAX_ZOOM = 12

export interface OverviewStyle {
  /** Draw the white halo under bike-infra tiers? Off at overview zoom
   *  (halos fatten the whole grid into blobs and cost a second deck layer). */
  drawHalo: boolean
  /** Draw the invisible wide finger-tap hit layer (and thus allow segment
   *  popups)? Off at overview zoom — a 24px tap target spans kilometres
   *  there, so a precise per-segment tap is meaningless, and it costs a
   *  third deck layer plus picking. */
  interactive: boolean
  /** Multiplier on stroke weight. Thinner at overview zoom so the network
   *  reads as fine lines rather than a solid colour wash. */
  strokeScale: number
}

/**
 * Per-zoom render policy. Pure function of zoom — no data, no history.
 * At z >= OVERVIEW_MAX_ZOOM returns the identity style (paint as before);
 * below it returns the stripped overview style.
 */
export function overviewStyle(zoom: number): OverviewStyle {
  if (zoom >= OVERVIEW_MAX_ZOOM) {
    return { drawHalo: true, interactive: true, strokeScale: 1 }
  }
  return { drawHalo: false, interactive: false, strokeScale: 0.6 }
}

/**
 * Deterministically pick which visible tiles to fetch+paint when the
 * viewport spans more than `max`. The chosen set is the `max` tiles whose
 * centres are nearest the viewport centre, with a stable row/col tiebreak —
 * so the result depends ONLY on (tiles, centre, max), never on the order the
 * tiles arrived or were discovered. When `tiles.length <= max` every tile is
 * returned unchanged (order preserved).
 *
 * @param tiles   all tiles intersecting the viewport (getVisibleTiles output)
 * @param center  viewport centre [lat, lng]
 * @param max     tile budget (defaults to MAX_FETCH_TILES)
 */
export function selectFetchTiles(
  tiles: Tile[],
  center: [number, number],
  max: number = MAX_FETCH_TILES,
): Tile[] {
  if (tiles.length <= max) return tiles
  const [clat, clng] = center
  // Longitude degrees shrink toward the poles; scale dlng by cos(lat) so
  // "nearest to centre" is true geographic distance, not an oblong that
  // over-favours same-latitude tiles (at SF's 37.8° a lng degree is ~0.79×
  // a lat degree). Deterministic — depends only on the viewport centre.
  const cosLat = Math.cos((clat * Math.PI) / 180)
  // Tile centre in the same 0.1° grid units used by latLngToTile.
  const dist2 = (t: Tile): number => {
    const tlat = (t.row + 0.5) * 0.1
    const tlng = (t.col + 0.5) * 0.1
    const dlat = tlat - clat
    const dlng = (tlng - clng) * cosLat
    return dlat * dlat + dlng * dlng
  }
  return [...tiles]
    .sort((a, b) => {
      const da = dist2(a), db = dist2(b)
      if (da !== db) return da - db
      // Stable, history-independent tiebreak.
      if (a.row !== b.row) return a.row - b.row
      return a.col - b.col
    })
    .slice(0, max)
}
