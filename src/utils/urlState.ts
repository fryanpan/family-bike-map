// Shareable-URL state: one canonical serialize/parse for ALL app state that a
// cold load should reproduce (map view, travel mode, search marker, route).
//
// This module is intentionally DOM-free and pure so serialize/parse can be
// unit-tested without a browser. App.tsx owns the wiring (reading the URL on
// load, writing it debounced on state changes); this file owns the string
// format only.
//
// Canonical format guarantees: given identical state, `serializeMapState`
// always produces the same string — the key order is fixed, coordinates are
// always 5 decimal places, and zoom is normalized. String equality of two
// serialized states therefore means the states are equivalent, which is what
// deterministic render tests and A/B comparisons rely on.

/** Managed query-param keys. App.tsx preserves any param NOT in this set
 *  (e.g. `admin`, `mobile`) when it rewrites the URL. */
export const MANAGED_PARAM_KEYS = [
  'travelMode',
  'center',
  'zoom',
  'place',
  'placeLabel',
  'start',
  'end',
  'via',
] as const

/** Decimal places for every lat/lng in the URL. ~1 m precision — plenty for a
 *  shareable map view, and short enough to keep URLs compact. */
const COORD_DP = 5

export interface UrlCoord {
  lat: number
  lng: number
}

export interface UrlSearchPlace extends UrlCoord {
  /** Display label for the search marker, if one was known. */
  label: string | null
}

/**
 * The full slice of app state a URL encodes. Every field is optional/null —
 * a malformed or partial URL fails soft to nulls, never throws.
 */
export interface MapUrlState {
  center: UrlCoord | null
  /** Map zoom. Normalized to at most 2 decimals on serialize. */
  zoom: number | null
  /** Travel-mode / profile key. Not validated here — App.tsx checks it against
   *  the known profiles and falls back to the default if unknown. */
  travelMode: string | null
  /** Active search marker (coords + optional display label). */
  search: UrlSearchPlace | null
  start: UrlCoord | null
  end: UrlCoord | null
  waypoints: UrlCoord[]
}

/** Empty state — the fail-soft default when nothing parses. */
export function emptyMapUrlState(): MapUrlState {
  return {
    center: null,
    zoom: null,
    travelMode: null,
    search: null,
    start: null,
    end: null,
    waypoints: [],
  }
}

// ── Formatting (state → string) ────────────────────────────────────────────

function formatCoord(c: UrlCoord): string {
  return `${c.lat.toFixed(COORD_DP)},${c.lng.toFixed(COORD_DP)}`
}

/** Normalize zoom to ≤2 decimals, dropping trailing zeros so integer zooms
 *  serialize as "13", not "13.00". */
function formatZoom(z: number): string {
  return String(Math.round(z * 100) / 100)
}

/**
 * Serialize state to a canonical query string (no leading `?`). Keys appear in
 * MANAGED_PARAM_KEYS order; only present fields are emitted. Coordinate and
 * `via` separators (`,` and `;`) are left literal for readability; labels and
 * mode keys are percent-encoded so arbitrary text round-trips.
 */
export function serializeMapState(state: MapUrlState): string {
  const parts: string[] = []

  if (state.travelMode) {
    parts.push(`travelMode=${encodeURIComponent(state.travelMode)}`)
  }
  if (state.center && isValidCoord(state.center)) {
    parts.push(`center=${formatCoord(state.center)}`)
  }
  if (state.zoom != null && Number.isFinite(state.zoom)) {
    parts.push(`zoom=${formatZoom(state.zoom)}`)
  }
  if (state.search && isValidCoord(state.search)) {
    parts.push(`place=${formatCoord(state.search)}`)
    if (state.search.label) {
      parts.push(`placeLabel=${encodeURIComponent(state.search.label)}`)
    }
  }
  if (state.start && isValidCoord(state.start)) {
    parts.push(`start=${formatCoord(state.start)}`)
  }
  if (state.end && isValidCoord(state.end)) {
    parts.push(`end=${formatCoord(state.end)}`)
  }
  const validWaypoints = state.waypoints.filter(isValidCoord)
  if (validWaypoints.length > 0) {
    parts.push(`via=${validWaypoints.map(formatCoord).join(';')}`)
  }

  return parts.join('&')
}

// ── Parsing (string → state) ───────────────────────────────────────────────

function isValidCoord(c: UrlCoord | null): c is UrlCoord {
  return (
    c != null &&
    Number.isFinite(c.lat) &&
    Number.isFinite(c.lng) &&
    c.lat >= -90 && c.lat <= 90 &&
    c.lng >= -180 && c.lng <= 180
  )
}

/** Parse "lat,lng" → coord, or null if malformed / out of range. */
function parseCoord(raw: string | null): UrlCoord | null {
  if (!raw) return null
  const bits = raw.split(',')
  if (bits.length !== 2) return null
  const lat = Number(bits[0])
  const lng = Number(bits[1])
  const coord = { lat, lng }
  return isValidCoord(coord) ? coord : null
}

function parseZoom(raw: string | null): number | null {
  if (!raw) return null
  const z = Number(raw)
  // Guard against garbage and absurd values; Web-Mercator tiling tops out
  // around 22-24 in practice.
  if (!Number.isFinite(z) || z < 0 || z > 24) return null
  return Math.round(z * 100) / 100
}

function parseWaypoints(raw: string | null): UrlCoord[] {
  if (!raw) return []
  return raw
    .split(';')
    .map((s) => parseCoord(s))
    .filter((c): c is UrlCoord => c != null)
}

/**
 * Parse a query string (or URLSearchParams) into state. Every field fails soft
 * independently: a garbage `center` doesn't stop a valid `zoom` from parsing.
 */
export function parseMapState(search: string | URLSearchParams): MapUrlState {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search

  const place = parseCoord(params.get('place'))
  const label = params.get('placeLabel')

  return {
    center: parseCoord(params.get('center')),
    zoom: parseZoom(params.get('zoom')),
    // Raw pass-through; App validates against the known profiles.
    travelMode: params.get('travelMode') || null,
    search: place ? { ...place, label: label || null } : null,
    start: parseCoord(params.get('start')),
    end: parseCoord(params.get('end')),
    waypoints: parseWaypoints(params.get('via')),
  }
}

/**
 * Merge managed state with the existing query string, preserving any
 * non-managed params (e.g. `admin`, `mobile`) and dropping legacy ones
 * (`preferred`, `showOther`). Preserved params come first (in their existing
 * order), then the canonical managed block — so managed serialization stays
 * deterministic regardless of what else is on the URL.
 *
 * Returns a query string WITHOUT a leading `?` (empty string if no params).
 */
export function mergeManagedParams(existingSearch: string, state: MapUrlState): string {
  const current = new URLSearchParams(existingSearch)
  const managed = new Set<string>(MANAGED_PARAM_KEYS)
  const LEGACY = new Set(['preferred', 'showOther'])

  const preservedParts: string[] = []
  for (const [k, v] of current) {
    if (managed.has(k) || LEGACY.has(k)) continue
    preservedParts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  }

  const managedStr = serializeMapState(state)
  return [preservedParts.join('&'), managedStr].filter(Boolean).join('&')
}
