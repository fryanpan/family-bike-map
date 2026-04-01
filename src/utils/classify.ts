import type { SafetyClass, SafetyInfo, ValhallaEdge, RouteSegment } from './types'

// 5-color palette: bright green → sky blue → violet → amber → red
// Chosen to be distinguishable against OSM base map and against each other.
export const SAFETY: Record<SafetyClass, SafetyInfo> = {
  great:      { label: 'Fahrradstrasse / Car-free path', color: '#22c55e', icon: '🚴', textColor: '#fff' },
  good:       { label: 'Separated bike path',            color: '#0ea5e9', icon: '🛤️', textColor: '#fff' },
  ok:         { label: 'Dedicated bike lane',            color: '#a855f7', icon: '〰️', textColor: '#fff' },
  acceptable: { label: 'Quiet street / Bus lane',        color: '#f59e0b', icon: '🏘️', textColor: '#fff' },
  caution:    { label: 'Road with bike marking',         color: '#f97316', icon: '⚡', textColor: '#fff' },
  avoid:      { label: 'Busy road — no infra',           color: '#ef4444', icon: '⚠️', textColor: '#fff' },
}

// ── Profile-aware legend ────────────────────────────────────────────────────
// Each profile defines how route types map to "great / ok / bad" levels,
// with per-route-type icons so users can distinguish infrastructure visually.

export type LegendLevel = 'great' | 'ok' | 'bad'

export interface LegendItem { icon: string; name: string; safetyClass: SafetyClass }

export interface LegendGroup {
  level: LegendLevel
  label: string
  items: LegendItem[]
}

// Each item carries its safetyClass so the Legend can show the exact map color
// (from the SAFETY palette) per item — keeping legend and overlay in sync.
export const PROFILE_LEGEND: Record<string, LegendGroup[]> = {
  toddler: [
    { level: 'great', label: 'Great', items: [
      { icon: '🚴', name: 'Recreational path (car free)', safetyClass: 'great' },
      { icon: '🚲', name: 'Fahrradstrasse',               safetyClass: 'great' },
      { icon: '🛤️', name: 'Separated bike path',          safetyClass: 'good'  },
    ]},
    { level: 'ok', label: 'OK', items: [
      { icon: '🏘️', name: 'Quiet street', safetyClass: 'acceptable' },
    ]},
    { level: 'bad', label: 'Avoid', items: [
      { icon: '〰️', name: 'Painted bike lane', safetyClass: 'avoid' },
      { icon: '⚠️', name: 'Busy road',         safetyClass: 'avoid' },
    ]},
  ],
  trailer: [
    { level: 'great', label: 'Great', items: [
      { icon: '🚴', name: 'Recreational path (car free) / Fahrradstrasse', safetyClass: 'great' },
      { icon: '🛤️', name: 'Separated bike path',                           safetyClass: 'good'  },
    ]},
    { level: 'ok', label: 'OK', items: [
      { icon: '🏘️', name: 'Quiet street',     safetyClass: 'acceptable' },
      { icon: '〰️', name: 'Roadside bike lane', safetyClass: 'ok'       },
      { icon: '🚌', name: 'Bus lane',           safetyClass: 'acceptable' },
    ]},
    { level: 'bad', label: 'Avoid', items: [
      { icon: '⚠️', name: 'Busy road', safetyClass: 'avoid' },
    ]},
  ],
  training: [
    { level: 'great', label: 'Great', items: [
      { icon: '🚴', name: 'Recreational path (car free) / Fahrradstrasse', safetyClass: 'great' },
      { icon: '🛤️', name: 'Separated path',                                safetyClass: 'good'  },
    ]},
    { level: 'ok', label: 'OK', items: [
      { icon: '〰️', name: 'Bike lane',    safetyClass: 'ok'         },
      { icon: '🏘️', name: 'Quiet street', safetyClass: 'acceptable' },
      { icon: '🚌', name: 'Bus lane',     safetyClass: 'acceptable' },
    ]},
    { level: 'bad', label: 'Avoid', items: [
      { icon: '⚠️', name: 'Busy road', safetyClass: 'avoid' },
    ]},
  ],
}

// ── Route quality stats ─────────────────────────────────────────────────────
// Maps safety classes to 3 display levels for the compact route summary bar.

const SAFETY_LEVEL: Record<SafetyClass, LegendLevel> = {
  great:      'great',
  good:       'great',
  ok:         'ok',
  acceptable: 'ok',
  caution:    'bad',
  avoid:      'bad',
}

export interface RouteQuality { great: number; ok: number; bad: number }

/** Compute the fraction of route (by coordinate count) in each quality level. */
export function computeRouteQuality(segments: RouteSegment[]): RouteQuality {
  if (!segments.length) return { great: 0, ok: 0, bad: 0 }
  let great = 0, ok = 0, bad = 0
  for (const seg of segments) {
    const count = Math.max(1, seg.coordinates.length - 1)
    const level = SAFETY_LEVEL[seg.safetyClass]
    if (level === 'great') great += count
    else if (level === 'ok') ok += count
    else bad += count
  }
  const total = great + ok + bad || 1
  return { great: great / total, ok: ok / total, bad: bad / total }
}

const BAD_SURFACES = new Set([
  'cobblestone', 'paving_stones', 'sett', 'unhewn_cobblestone',
  'cobblestone:flattened', 'gravel', 'unpaved',
])

// Maps road_class string values returned by Valhalla API to a numeric rank
// (lower = bigger/faster road). Used for fallback road-class comparisons.
const ROAD_CLASS_RANK: Record<string, number> = {
  motorway:     0,
  trunk:        1,
  primary:      2,
  secondary:    3,
  tertiary:     4,
  unclassified: 5,
  residential:  6,
  service_other: 7,
}

/**
 * Classify a Valhalla edge into our family safety model.
 *
 * Classification is PROFILE-AWARE because safety priorities differ:
 *
 * toddler:
 *   - GREAT: Fahrradstrasse (bicycle_road=yes), car-free cycleway/path/trail
 *   - GOOD:  Separated/elevated path alongside road (cycleway=track),
 *            shared footway/pedestrian path (park paths, Tiergarten trails)
 *   - ACCEPTABLE: Quiet residential, living streets
 *   - AVOID: Painted road bike lane (cycleway=lane) — "no better than road without a bike path"
 *   - AVOID: Primary/secondary/tertiary without protected infra
 *
 * trailer (more lenient than toddler):
 *   - GREAT: Fahrradstrasse, car-free cycleway
 *   - GOOD:  Separated path (cycleway=track)
 *   - OK:    Roadside bike lane (cycleway=lane), bus lane (cycleway=share_busway)
 *   - ACCEPTABLE: Quiet residential, living streets
 *   - AVOID: Major roads without infra
 *
 * training:
 *   - GREAT: Fahrradstrasse, car-free cycleway/paths
 *   - GOOD:  Separated path, bus lane (share_busway — e.g. Sonnenallee)
 *   - OK:    Painted road lane, quiet residential
 *   - ACCEPTABLE: Tertiary with low speed limit
 *   - AVOID: Primary/secondary without infra
 *
 * NOTE: The public Valhalla API (valhalla1.openstreetmap.de) returns STRING values
 * for use, cycle_lane, and road_class — NOT the numeric codes found in older docs.
 * All comparisons in this function use the string form.
 */
export function classifyEdge(
  edge: ValhallaEdge | null | undefined,
  profileKey?: string,
): SafetyClass {
  if (!edge) return 'acceptable'

  const use         = edge.use         ?? ''
  const cycleLane   = edge.cycle_lane  ?? ''
  const roadClass   = edge.road_class  ?? ''
  const bicycleRoad = edge.bicycle_road ?? false
  const surface     = edge.surface     ?? ''

  const badSurface = BAD_SURFACES.has(surface)
  if (badSurface && profileKey !== 'training') {
    // Cobblestones / bad surfaces: treat as one class worse for toddler + trailer
    // (training profile tolerates rough surfaces more)
    const base = classifyBase(use, cycleLane, roadClass, bicycleRoad)
    return worsen(base)
  }

  return classifyBase(use, cycleLane, roadClass, bicycleRoad, profileKey)
}

function classifyBase(
  use: string,
  cycleLane: string,
  roadClass: string,
  bicycleRoad: boolean,
  profileKey?: string,
): SafetyClass {
  const rcRank = ROAD_CLASS_RANK[roadClass] ?? 5

  // ── GREAT for all profiles ──────────────────────────────────────────────
  // Car-free dedicated cycleway (Radweg, Mauerweg, greenways) or off-road path/trail
  if (use === 'cycleway' || use === 'path' || use === 'mountain_bike') return 'great'

  // Fahrradstrasse (bicycle_road=yes) — the priority infrastructure in Berlin.
  // Correctly detected via edge.bicycle_road (NOT bicycle_network which is for NCN/RCN/LCN).
  if (bicycleRoad) return 'great'

  // ── GOOD: shared footway/pedestrian path (park paths, Tiergarten trails) ──
  // These are car-free routes shared with pedestrians — safe and pleasant for toddlers.
  if (use === 'footway' || use === 'pedestrian') return 'good'

  // ── Separated/elevated bike track alongside road (cycleway=track) ───────
  // GOOD for all profiles (this is the elevated-on-sidewalk path the user mentions)
  if (cycleLane === 'separated') return 'good'

  // ── Painted road bike lane (cycleway=lane) ───────────────────────────────
  // Profile-specific: for toddler this is "no better than a road without a bike path"
  //
  // NOTE: Valhalla's cycle_lane="dedicated" always means a painted lane. The public
  // Valhalla instance does NOT expose cycleway:separation or cycleway:buffer tags in
  // edge attributes, so we cannot distinguish a plain painted lane from a bollard-
  // protected one here. The overpass.ts overlay DOES check these separation tags
  // directly from OSM and upgrades such lanes to 'good'. This is a known Valhalla limitation.
  if (cycleLane === 'dedicated') {
    if (profileKey === 'toddler') return 'avoid'
    return 'ok'  // trailer and training: a dedicated lane is still better than nothing
  }

  // ── Living street (Spielstraße / Wohnstraße) ────────────────────────────
  if (use === 'living_street') return 'acceptable'

  // ── Shared bus lane (cycleway=share_busway) ─────────────────────────────
  if (cycleLane === 'share_busway') {
    if (profileKey === 'toddler') return 'caution'   // not suitable with small child
    if (profileKey === 'training') return 'good'     // bus lanes are good for fast riding
    return 'acceptable'                              // trailer: ok in a pinch
  }

  // ── Shared road marking (sharrow) ──────────────────────────────────────
  if (cycleLane === 'shared') {
    if (profileKey === 'toddler') return 'avoid'
    return rcRank >= 4 ? 'caution' : 'avoid'
  }

  // ── Quiet residential or service road ──────────────────────────────────
  if (rcRank >= 6) return 'acceptable'

  // ── Tertiary / unclassified ─────────────────────────────────────────────
  if (rcRank >= 4) return 'caution'

  // ── Primary / secondary / trunk / motorway ──────────────────────────────
  return 'avoid'
}

/** Degrade a safety class by one level (for bad surfaces) */
export function worsen(cls: SafetyClass): SafetyClass {
  const order: SafetyClass[] = ['great', 'good', 'ok', 'acceptable', 'caution', 'avoid']
  const idx = order.indexOf(cls)
  return idx < order.length - 1 ? order[idx + 1] : 'avoid'
}

interface ClassifiedPoint {
  safetyClass: SafetyClass
  coord: [number, number]
}

/**
 * Group an array of { safetyClass, coord } items into contiguous segments of the same class.
 */
export function buildSegments(classified: ClassifiedPoint[]): RouteSegment[] {
  if (!classified.length) return []

  const out: RouteSegment[] = []
  let current: RouteSegment = {
    safetyClass: classified[0].safetyClass,
    coordinates: [classified[0].coord],
  }

  for (let i = 1; i < classified.length; i++) {
    const item = classified[i]
    if (item.safetyClass === current.safetyClass) {
      current.coordinates.push(item.coord)
    } else {
      // Carry over last coord so segments are visually connected
      const bridgeCoord = current.coordinates[current.coordinates.length - 1]
      out.push(current)
      current = { safetyClass: item.safetyClass, coordinates: [bridgeCoord, item.coord] }
    }
  }
  out.push(current)
  return out
}
