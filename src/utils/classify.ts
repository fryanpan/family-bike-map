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

export interface LegendItem { icon: string; name: string }

export interface LegendGroup {
  level: LegendLevel
  label: string
  color: string
  items: LegendItem[]
}

// Legend level → representative color from the SAFETY palette:
//   great → green  (#22c55e, matching SAFETY.great)
//   ok    → violet (#a855f7, matching SAFETY.ok — the more visible of ok+acceptable)
//   bad   → orange (#f97316, matching SAFETY.caution — the entry point to "avoid" territory)
export const PROFILE_LEGEND: Record<string, LegendGroup[]> = {
  toddler: [
    { level: 'great', label: 'Great', color: '#22c55e', items: [
      { icon: '🚴', name: 'Car-free path' },
      { icon: '🚲', name: 'Fahrradstrasse' },
      { icon: '🛤️', name: 'Separated bike path' },
    ]},
    { level: 'ok', label: 'OK', color: '#a855f7', items: [
      { icon: '🏘️', name: 'Quiet street' },
    ]},
    { level: 'bad', label: 'Avoid', color: '#f97316', items: [
      { icon: '〰️', name: 'Painted bike lane' },
      { icon: '⚠️', name: 'Busy road' },
    ]},
  ],
  trailer: [
    { level: 'great', label: 'Great', color: '#22c55e', items: [
      { icon: '🚴', name: 'Car-free path / Fahrradstrasse' },
      { icon: '🛤️', name: 'Separated bike path' },
    ]},
    { level: 'ok', label: 'OK', color: '#a855f7', items: [
      { icon: '🏘️', name: 'Quiet street' },
      { icon: '〰️', name: 'Roadside bike lane' },
      { icon: '🚌', name: 'Bus lane' },
    ]},
    { level: 'bad', label: 'Avoid', color: '#f97316', items: [
      { icon: '⚠️', name: 'Busy road' },
    ]},
  ],
  training: [
    { level: 'great', label: 'Great', color: '#22c55e', items: [
      { icon: '🚴', name: 'Car-free path / Fahrradstrasse' },
      { icon: '🛤️', name: 'Separated path' },
    ]},
    { level: 'ok', label: 'OK', color: '#a855f7', items: [
      { icon: '〰️', name: 'Bike lane' },
      { icon: '🏘️', name: 'Quiet street' },
      { icon: '🚌', name: 'Bus lane' },
    ]},
    { level: 'bad', label: 'Avoid', color: '#f97316', items: [
      { icon: '⚠️', name: 'Busy road' },
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

/**
 * Classify a Valhalla edge into our family safety model.
 *
 * Classification is PROFILE-AWARE because safety priorities differ:
 *
 * toddler:
 *   - GREAT: Fahrradstrasse (bicycle_road=yes), car-free cycleway
 *   - GOOD:  Separated/elevated path alongside road (cycleway=track)
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
 *   - GOOD:  Separated path, bus lane
 *   - OK:    Painted road lane, quiet residential
 *   - ACCEPTABLE: Tertiary with low speed limit
 *   - AVOID: Primary/secondary without infra
 *
 * Key fix vs previous version: uses edge.bicycle_road (the Fahrradstrasse flag,
 * OSM: bicycle_road=yes) instead of edge.bicycle_network. The bicycle_network
 * field tracks cycling route memberships (NCN/RCN/LCN), which is orthogonal to
 * bicycle_road=yes. Most Berlin Fahrradstrassen are NOT in a named cycling network.
 */
export function classifyEdge(
  edge: ValhallaEdge | null | undefined,
  profileKey?: string,
): SafetyClass {
  if (!edge) return 'acceptable'

  const use         = edge.use         ?? 0
  const cycleLane   = edge.cycle_lane  ?? 0
  const roadClass   = edge.road_class  ?? 5
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
  use: number,
  cycleLane: number,
  roadClass: number,
  bicycleRoad: boolean,
  profileKey?: string,
): SafetyClass {
  // ── GREAT for all profiles ──────────────────────────────────────────────
  // Car-free dedicated cycleway (Radweg, Mauerweg, greenways)
  if (use === 20 || use === 25) return 'great'

  // Fahrradstrasse (bicycle_road=yes) — the priority infrastructure in Berlin.
  // Correctly detected via edge.bicycle_road (NOT bicycle_network which is for NCN/RCN/LCN).
  if (bicycleRoad) return 'great'

  // ── Separated/elevated bike track alongside road (cycleway=track) ───────
  // GOOD for all profiles (this is the elevated-on-sidewalk path the user mentions)
  if (cycleLane === 3) return 'good'

  // ── Painted road bike lane (cycleway=lane) ───────────────────────────────
  // Profile-specific: for toddler this is "no better than a road without a bike path"
  if (cycleLane === 2) {
    if (profileKey === 'toddler') return 'avoid'
    return 'ok'  // trailer and training: a dedicated lane is still better than nothing
  }

  // ── Living street (Spielstraße / Wohnstraße) ────────────────────────────
  if (use === 18) return 'acceptable'

  // ── Shared bus lane (cycleway=share_busway) ─────────────────────────────
  if (cycleLane === 4) {
    if (profileKey === 'toddler') return 'caution'  // not suitable with small child
    return 'acceptable'  // ok for trailer, good for training
  }

  // ── Shared road marking (sharrow) ──────────────────────────────────────
  if (cycleLane === 1) {
    if (profileKey === 'toddler') return 'avoid'
    return roadClass >= 4 ? 'caution' : 'avoid'
  }

  // ── Quiet residential or service road ──────────────────────────────────
  if (roadClass >= 6) return 'acceptable'

  // ── Tertiary / unclassified ─────────────────────────────────────────────
  if (roadClass >= 4) return 'caution'

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
