import type { SafetyClass, SafetyInfo, ValhallaEdge, RouteSegment } from './types'

// Three-color display palette: teal-green / orange / rose
// Chosen for high contrast against OpenStreetMap tile backgrounds (sage park greens,
// beige/gray roads, light-blue water). 'great' and 'good' both show teal-green.
export const STATUS_COLOR = {
  green: '#10b981',
  amber: '#f97316',
  red:   '#e11d48',
} as const

export const SAFETY: Record<SafetyClass, SafetyInfo> = {
  great: { label: 'Car-free path / Fahrradstrasse', color: STATUS_COLOR.green, icon: '🚴', textColor: '#fff' },
  good:  { label: 'Shared footway / Pedestrian path', color: STATUS_COLOR.green, icon: '🛤️', textColor: '#fff' },
  ok:    { label: 'Separated track / Living street', color: STATUS_COLOR.amber, icon: '〰️', textColor: '#fff' },
  bad:   { label: 'Road without protection', color: STATUS_COLOR.red, icon: '⚠️', textColor: '#fff' },
}

// ── Profile-aware legend ────────────────────────────────────────────────────
// Each profile defines how route types map to "good / ok / avoid" levels.

export type LegendLevel = 'good' | 'ok' | 'bad'

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
    { level: 'good', label: 'Good', items: [
      { icon: '🚴', name: 'Car-free path / Radweg',    safetyClass: 'great' },
      { icon: '🚲', name: 'Fahrradstrasse',             safetyClass: 'great' },
      { icon: '🛤️', name: 'Shared footway (park path)', safetyClass: 'good'  },
    ]},
    { level: 'ok', label: 'OK', items: [
      { icon: '🛡️', name: 'Separated bike track',       safetyClass: 'ok' },
      { icon: '🏘️', name: 'Living street',              safetyClass: 'ok' },
    ]},
    { level: 'bad', label: 'Avoid', items: [
      { icon: '〰️', name: 'Painted bike lane',          safetyClass: 'bad' },
      { icon: '🚌', name: 'Shared bus lane',            safetyClass: 'bad' },
      { icon: '🏠', name: 'Residential road',           safetyClass: 'bad' },
    ]},
  ],
  trailer: [
    { level: 'good', label: 'Good', items: [
      { icon: '🚴', name: 'Car-free path / Radweg',    safetyClass: 'great' },
      { icon: '🚲', name: 'Fahrradstrasse',             safetyClass: 'great' },
      { icon: '🛤️', name: 'Shared footway (park path)', safetyClass: 'good'  },
      { icon: '🚌', name: 'Shared bus lane',            safetyClass: 'good'  },
    ]},
    { level: 'ok', label: 'OK', items: [
      { icon: '〰️', name: 'Painted bike lane',          safetyClass: 'ok' },
      { icon: '🏘️', name: 'Living street',              safetyClass: 'ok' },
      { icon: '🏠', name: 'Residential road',           safetyClass: 'ok' },
    ]},
    { level: 'bad', label: 'Avoid', items: [
      { icon: '🛡️', name: 'Separated bike track (narrow)', safetyClass: 'bad' },
    ]},
  ],
  training: [
    { level: 'good', label: 'Good', items: [
      { icon: '🚴', name: 'Car-free path / Radweg',    safetyClass: 'great' },
      { icon: '🚲', name: 'Fahrradstrasse',             safetyClass: 'great' },
      { icon: '🛤️', name: 'Shared footway (park path)', safetyClass: 'good'  },
      { icon: '〰️', name: 'Painted bike lane',          safetyClass: 'good'  },
      { icon: '🚌', name: 'Shared bus lane',            safetyClass: 'good'  },
    ]},
    { level: 'ok', label: 'OK', items: [
      { icon: '🏘️', name: 'Living street',              safetyClass: 'ok' },
      { icon: '🏠', name: 'Residential road',           safetyClass: 'ok' },
    ]},
    { level: 'bad', label: 'Avoid', items: [
      { icon: '🛡️', name: 'Separated bike track (slow)', safetyClass: 'bad' },
    ]},
  ],
}

// ── Route quality stats ─────────────────────────────────────────────────────
// Maps safety classes to 3 display levels for the compact route summary bar.

export const SAFETY_LEVEL: Record<SafetyClass, LegendLevel> = {
  great: 'good',
  good:  'good',
  ok:    'ok',
  bad:   'bad',
}

export interface RouteQuality { good: number; ok: number; bad: number }

/**
 * Compute the fraction of route (by coordinate count) in each quality level.
 *
 * If `preferredClasses` is provided, uses a preferred/other model:
 *   - preferred class → "good" bucket
 *   - non-preferred class → "bad" bucket
 *   - "ok" bucket is always 0 in this mode
 *
 * Without `preferredClasses`, falls back to the default good/ok/bad mapping.
 */
export function computeRouteQuality(
  segments: RouteSegment[],
  preferredClasses?: Set<SafetyClass>,
): RouteQuality {
  if (!segments.length) return { good: 0, ok: 0, bad: 0 }
  let good = 0, ok = 0, bad = 0
  for (const seg of segments) {
    const count = Math.max(1, seg.coordinates.length - 1)
    if (preferredClasses) {
      if (preferredClasses.has(seg.safetyClass)) good += count
      else bad += count
    } else {
      const level = SAFETY_LEVEL[seg.safetyClass]
      if (level === 'good') good += count
      else if (level === 'ok') ok += count
      else bad += count
    }
  }
  const total = good + ok + bad || 1
  return { good: good / total, ok: ok / total, bad: bad / total }
}

// ── Preferred item helpers ──────────────────────────────────────────────────

/**
 * Returns the set of item names that are "preferred" by default for a profile.
 * Default: all items from 'good' and 'ok' legend groups.
 */
export function getDefaultPreferredItems(profileKey: string): Set<string> {
  const groups = PROFILE_LEGEND[profileKey]
  if (!groups) return new Set()
  const names = new Set<string>()
  for (const group of groups) {
    if (group.level === 'good' || group.level === 'ok') {
      group.items.forEach((item) => names.add(item.name))
    }
  }
  return names
}

/**
 * Returns the SafetyClasses that are "preferred" given a set of preferred item names.
 * A class is preferred if AT LEAST ONE of its items (for the profile) is preferred.
 */
export function getPreferredSafetyClasses(
  preferredNames: Set<string>,
  profileKey: string,
): Set<SafetyClass> {
  const groups = PROFILE_LEGEND[profileKey]
  if (!groups) return new Set()
  const preferred = new Set<SafetyClass>()
  for (const group of groups) {
    for (const item of group.items) {
      if (preferredNames.has(item.name)) {
        preferred.add(item.safetyClass)
      }
    }
  }
  return preferred
}

// Surfaces that always classify as avoid — rough/uncomfortable for family biking.
// NOTE: This set is mirrored in overpass.ts. Both must be kept in sync.
export const BAD_SURFACES = new Set([
  'cobblestone', 'paving_stones', 'sett', 'unhewn_cobblestone',
  'cobblestone:flattened', 'gravel', 'unpaved',
])

// Maps road_class string values returned by Valhalla API to a numeric rank
// (lower = bigger/faster road). Used for road-class fallback comparisons.
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

// ── Valhalla edge → OSM tag correlation ────────────────────────────────────
// Valhalla trace_attributes returns simplified edge attributes. Here is how
// they map to the underlying OSM tags used in overpass.ts:
//
//   edge.use=cycleway        ↔  highway=cycleway
//   edge.bicycle_road=true   ↔  bicycle_road=yes (Fahrradstrasse)
//   edge.use=path            ↔  highway=path
//   edge.use=footway         ↔  highway=footway
//   edge.use=pedestrian      ↔  highway=pedestrian
//   edge.use=mountain_bike   ↔  highway=track + bicycle=designated
//   edge.use=living_street   ↔  highway=living_street
//   edge.cycle_lane=separated   ↔  cycleway=track / cycleway:*=track
//   edge.cycle_lane=dedicated   ↔  cycleway=lane / cycleway:*=lane
//                                   (overpass.ts also checks hasSeparation for bollards/buffer
//                                    and upgrades to 'ok' for toddler, overriding plain lane)
//   edge.cycle_lane=share_busway ↔ cycleway=share_busway
//   edge.cycle_lane=shared      ↔  sharrow markings
//   edge.road_class=residential  ↔  highway=residential
//
// NOTE: Valhalla does NOT expose cycleway:separation or cycleway:buffer tags in
// edge attributes, so it cannot distinguish plain painted lanes from bollard-protected
// ones. The overpass.ts overlay checks these directly from OSM and handles them via
// hasSeparation(). This is a known Valhalla limitation for the classify path.

/**
 * Classify a Valhalla edge into the 4-level family safety model.
 *
 * Classification is PROFILE-AWARE. All profiles share the same top levels
 * (great/good for car-free infrastructure) but differ on road infrastructure:
 *
 * toddler (most safety-conscious):
 *   Good:  Car-free paths, Fahrradstrasse, shared footways
 *   OK:    Separated bike track, living streets
 *   Avoid: Painted road lanes, bus lanes, residential roads, bad surfaces
 *
 * trailer (more lenient, but trailers are wide):
 *   Good:  Car-free paths, Fahrradstrasse, footways, bus lanes
 *   OK:    Painted road lanes, living streets, residential roads
 *   Avoid: Separated bike tracks (too narrow for trailer), bad surfaces
 *
 * training (prioritises speed):
 *   Good:  Car-free paths, Fahrradstrasse, footways, painted lanes, bus lanes
 *   OK:    Living streets, residential roads
 *   Avoid: Separated bike tracks (too slow/interrupted), bad surfaces
 */
export function classifyEdge(
  edge: ValhallaEdge | null | undefined,
  profileKey?: string,
): SafetyClass {
  if (!edge) return 'ok'

  const use         = edge.use         ?? ''
  const cycleLane   = edge.cycle_lane  ?? ''
  const roadClass   = edge.road_class  ?? ''
  const bicycleRoad = edge.bicycle_road ?? false
  const surface     = edge.surface     ?? ''

  // Bad surfaces (cobblestones, gravel, sett) → avoid for all profiles
  if (BAD_SURFACES.has(surface)) return 'bad'

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

  // ── Car-free dedicated cycleway or off-road path — great for all ────────
  if (use === 'cycleway' || use === 'path' || use === 'mountain_bike') return 'great'
  if (bicycleRoad) return 'great'

  // ── Shared footway/pedestrian path (park paths, Tiergarten trails) ──────
  // Car-free but shared with pedestrians — good for all profiles
  if (use === 'footway' || use === 'pedestrian') return 'good'

  // ── Separated/elevated bike track alongside road (cycleway=track) ───────
  // Toddler: ok (safe but slow, interrupted at driveways)
  // Trailer: avoid (too narrow, turns are tricky with trailer)
  // Training: avoid (too slow and interrupted for fast riding)
  if (cycleLane === 'separated') {
    return profileKey === 'toddler' ? 'ok' : 'bad'
  }

  // ── Painted road bike lane (cycleway=lane) ───────────────────────────────
  // Toddler: avoid (too close to moving cars)
  // Trailer: ok (acceptable, wide enough)
  // Training: good (on-road, fast, consistent)
  if (cycleLane === 'dedicated') {
    if (profileKey === 'toddler') return 'bad'
    if (profileKey === 'training') return 'good'
    return 'ok'
  }

  // ── Living street (Spielstraße / Wohnstraße) ────────────────────────────
  if (use === 'living_street') return 'ok'

  // ── Shared bus lane (cycleway=share_busway) ─────────────────────────────
  // Toddler: avoid (buses are hazardous with small children)
  // Trailer/training: good (wide, well-maintained, predictable)
  if (cycleLane === 'share_busway') {
    return profileKey === 'toddler' ? 'bad' : 'good'
  }

  // ── Shared road marking (sharrow) — avoid for all ──────────────────────
  if (cycleLane === 'shared') return 'bad'

  // ── Residential / service road ──────────────────────────────────────────
  // Toddler: avoid (cars on street with small child)
  // Trailer/training: ok (low traffic, acceptable)
  if (rcRank >= 6) {
    return profileKey === 'toddler' ? 'bad' : 'ok'
  }

  // ── Everything else (tertiary, unclassified, primary, secondary, trunk) ─
  return 'bad'
}

/** Degrade a safety class by one level. Used for display purposes. */
export function worsen(cls: SafetyClass): SafetyClass {
  const order: SafetyClass[] = ['great', 'good', 'ok', 'bad']
  const idx = order.indexOf(cls)
  return idx < order.length - 1 ? order[idx + 1] : 'bad'
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
