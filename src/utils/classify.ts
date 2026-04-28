import type { ValhallaEdge, RouteSegment } from './types'
import type { PathLevel } from './lts'

// Two-tone display palette — preferred paths green, other paths orange.
// Chosen for high contrast against OpenStreetMap tile backgrounds.
//
// These three colors are the SOURCE OF TRUTH for non-tier categorization
// (preferred vs. non-preferred vs. walking). Per-tier colors live in
// PATH_LEVEL_LABELS in utils/lts.ts. CSS rules MUST NOT redeclare these
// values — consumers should import the constants and apply them inline,
// otherwise drift creeps in (the route polyline orange and the quality-
// bar "non-preferred" orange ended up two different shades before this
// was unified, 2026-04-27).
export const PREFERRED_COLOR = '#10b981'  // teal-green
export const OTHER_COLOR     = '#f97316'  // orange
export const WALKING_COLOR   = '#6b7280'  // gray-500 — bridge-walk segments

// ── Profile-aware legend ────────────────────────────────────────────────────
// Each ride mode defines which infrastructure tiers are preferred by default.
// "Preferred" items render in green on the route; non-preferred render orange.
// The picker UX shows these as toggles so users can override.
//
// Modes (see docs/product/plans/2026-04-13-three-layer-scoring-plan.md):
//   kid-starting-out  — kid pilots, fully car-free pathways only (default)
//   kid-confident     — kid pilots, accepts living streets + Fahrradstraßen
//   kid-traffic-savvy — kid pilots, accepts painted lanes on quiet roads
//   carrying-kid      — adult pilots; surface-strict
//   training          — adult fitness; LTS ≤3, secondary mode

export interface LegendItem {
  icon: string
  name: string
  defaultPreferred: boolean
  // The path level this item maps to — used by the Simple legend mode to group
  // items by shared line style (1a=solid, 1b=long-dash, 2a=dots). Items at
  // LTS 2b / 3 / 4 are rendered in the legend as a single "other" tier when
  // they're outside the mode's preferred set.
  level: PathLevel
}

export interface LegendGroup {
  defaultPreferred: boolean
  items: LegendItem[]
}

// Item names are the display labels emitted by `classifyOsmTagsToItem` in
// src/services/overpass.ts — keep in sync. Rough surfaces are represented
// by OsmWay.roughSurface (orthogonal to item name) and are NOT a legend
// row in any profile.
export const PROFILE_LEGEND: Record<string, LegendGroup[]> = {
  // LTS 1a only. Default mode on first launch.
  'kid-starting-out': [
    { defaultPreferred: true, items: [
      { icon: '🚴', name: 'Bike path',                   defaultPreferred: true, level: '1a' },
      { icon: '🛤️', name: 'Shared use path',             defaultPreferred: true, level: '1a' },
      { icon: '🛡️', name: 'Elevated sidewalk path',      defaultPreferred: true, level: '1a' },
    ]},
    { defaultPreferred: false, items: [
      { icon: '🚲', name: 'Fahrradstrasse',              defaultPreferred: false, level: '1b' },
      { icon: '🏘️', name: 'Living street',               defaultPreferred: false, level: '1b' },
      { icon: '🏡', name: 'Bike boulevard',              defaultPreferred: false, level: '1b' },
      { icon: '〰️', name: 'Painted bike lane on quiet street', defaultPreferred: false, level: '2a' },
      { icon: '🚌', name: 'Shared bus lane on quiet street',    defaultPreferred: false, level: '2a' },
      { icon: '🏠', name: 'Quiet street',                defaultPreferred: false, level: '2b' },
      { icon: '🛣️', name: 'Painted bike lane on major road',   defaultPreferred: false, level: '3'  },
      { icon: '🛣️', name: 'Major road',                  defaultPreferred: false, level: '3'  },
    ]},
  ],

  // LTS 1a + 1b.
  'kid-confident': [
    { defaultPreferred: true, items: [
      { icon: '🚴', name: 'Bike path',                   defaultPreferred: true, level: '1a' },
      { icon: '🛤️', name: 'Shared use path',             defaultPreferred: true, level: '1a' },
      { icon: '🛡️', name: 'Elevated sidewalk path',      defaultPreferred: true, level: '1a' },
    ]},
    { defaultPreferred: true, items: [
      { icon: '🚲', name: 'Fahrradstrasse',              defaultPreferred: true, level: '1b' },
      { icon: '🏘️', name: 'Living street',               defaultPreferred: true, level: '1b' },
      { icon: '🏡', name: 'Bike boulevard',              defaultPreferred: true, level: '1b' },
    ]},
    { defaultPreferred: false, items: [
      { icon: '〰️', name: 'Painted bike lane on quiet street', defaultPreferred: false, level: '2a' },
      { icon: '🚌', name: 'Shared bus lane on quiet street',    defaultPreferred: false, level: '2a' },
      { icon: '🏠', name: 'Quiet street',                defaultPreferred: false, level: '2b' },
      { icon: '🛣️', name: 'Painted bike lane on major road',   defaultPreferred: false, level: '3'  },
      { icon: '🛣️', name: 'Major road',                  defaultPreferred: false, level: '3'  },
    ]},
  ],

  // Legend-preferred: 1a/1b/2a only. Router ALSO accepts 2b with a 1.5×
  // cost multiplier (see MODE_RULES), but 2b stays off the legend unless
  // the user opts in via adminSettings.showNonPreferredInLegend.
  'kid-traffic-savvy': [
    { defaultPreferred: true, items: [
      { icon: '🚴', name: 'Bike path',                   defaultPreferred: true, level: '1a' },
      { icon: '🛤️', name: 'Shared use path',             defaultPreferred: true, level: '1a' },
      { icon: '🛡️', name: 'Elevated sidewalk path',      defaultPreferred: true, level: '1a' },
    ]},
    { defaultPreferred: true, items: [
      { icon: '🚲', name: 'Fahrradstrasse',              defaultPreferred: true, level: '1b' },
      { icon: '🏘️', name: 'Living street',               defaultPreferred: true, level: '1b' },
      { icon: '🏡', name: 'Bike boulevard',              defaultPreferred: true, level: '1b' },
    ]},
    { defaultPreferred: true, items: [
      { icon: '〰️', name: 'Painted bike lane on quiet street', defaultPreferred: true, level: '2a' },
      { icon: '🚌', name: 'Shared bus lane on quiet street',    defaultPreferred: true, level: '2a' },
    ]},
    { defaultPreferred: false, items: [
      { icon: '🏠', name: 'Quiet street',                defaultPreferred: false, level: '2b' },
      { icon: '🛣️', name: 'Painted bike lane on major road',   defaultPreferred: false, level: '3' },
      { icon: '🛣️', name: 'Major road',                  defaultPreferred: false, level: '3' },
    ]},
  ],

  // Legend-preferred: 1a/1b/2a. Router accepts 2b at 1.2× cost; LTS 3
  // rejected entirely. 2b stays off the legend unless opted in.
  'carrying-kid': [
    { defaultPreferred: true, items: [
      { icon: '🚴', name: 'Bike path',                   defaultPreferred: true, level: '1a' },
      { icon: '🛤️', name: 'Shared use path',             defaultPreferred: true, level: '1a' },
    ]},
    { defaultPreferred: true, items: [
      { icon: '🚲', name: 'Fahrradstrasse',              defaultPreferred: true, level: '1b' },
      { icon: '🏘️', name: 'Living street',               defaultPreferred: true, level: '1b' },
      { icon: '🏡', name: 'Bike boulevard',              defaultPreferred: true, level: '1b' },
    ]},
    { defaultPreferred: true, items: [
      { icon: '〰️', name: 'Painted bike lane on quiet street', defaultPreferred: true, level: '2a' },
      { icon: '🚌', name: 'Shared bus lane on quiet street',    defaultPreferred: true, level: '2a' },
    ]},
    { defaultPreferred: false, items: [
      { icon: '🛡️', name: 'Elevated sidewalk path',      defaultPreferred: false, level: '1a' },
      { icon: '🏠', name: 'Quiet street',                defaultPreferred: false, level: '2b' },
      { icon: '🛣️', name: 'Painted bike lane on major road',   defaultPreferred: false, level: '3' },
      { icon: '🛣️', name: 'Major road',                  defaultPreferred: false, level: '3' },
    ]},
  ],

  // Legend-preferred: 1a/1b/2a. Router accepts 2b + 3 too (adult fitness
  // fleets ride them at full speed), but legend stays focused on bike-
  // infra tiers unless opted in.
  training: [
    { defaultPreferred: true, items: [
      { icon: '🚴', name: 'Bike path',                   defaultPreferred: true, level: '1a' },
      { icon: '🛤️', name: 'Shared use path',             defaultPreferred: true, level: '1a' },
    ]},
    { defaultPreferred: true, items: [
      { icon: '🚲', name: 'Fahrradstrasse',              defaultPreferred: true, level: '1b' },
      { icon: '🏘️', name: 'Living street',               defaultPreferred: true, level: '1b' },
      { icon: '🏡', name: 'Bike boulevard',              defaultPreferred: true, level: '1b' },
    ]},
    { defaultPreferred: true, items: [
      { icon: '〰️', name: 'Painted bike lane on quiet street', defaultPreferred: true, level: '2a' },
      { icon: '🚌', name: 'Shared bus lane on quiet street',    defaultPreferred: true, level: '2a' },
    ]},
    { defaultPreferred: false, items: [
      { icon: '🛡️', name: 'Elevated sidewalk path',      defaultPreferred: false, level: '1a' },
      { icon: '🏠', name: 'Quiet street',                defaultPreferred: false, level: '2b' },
      { icon: '🛣️', name: 'Painted bike lane on major road',   defaultPreferred: false, level: '3' },
      { icon: '🛣️', name: 'Major road',                  defaultPreferred: false, level: '3' },
    ]},
  ],
}

// Tiers that the user can toggle into the preferred legend via
// adminSettings.showNonPreferredInLegend. 2b and 3 are "accepted for
// routing but not displayed as preferred" by default for the affected
// modes; this switch promotes them into the preferred set for display.
// Routing acceptance is driven by MODE_RULES.acceptedLevels and is
// independent of this flag.
export const OPTIONAL_PREFERRED_LEVELS: ReadonlySet<PathLevel> = new Set(['2b', '3'])

/**
 * Return the effective PROFILE_LEGEND for a profile, optionally with 2b/3
 * items promoted from non-preferred to preferred. Used by the legend + by
 * overlay/route display logic to keep the "what's preferred" view in sync
 * with adminSettings.
 */
export function getEffectiveProfileLegend(
  profileKey: string,
  showNonPreferredInLegend: boolean,
): LegendGroup[] {
  const groups = PROFILE_LEGEND[profileKey] ?? []
  if (!showNonPreferredInLegend) return groups
  // Promote 2b / 3 items from any non-preferred group into a new preferred
  // group. The item's own defaultPreferred is flipped to true so downstream
  // preferredItemNames derivation picks them up.
  const preferred: LegendItem[] = []
  const nonPreferred: LegendItem[] = []
  for (const g of groups) {
    for (const it of g.items) {
      if (g.defaultPreferred) {
        preferred.push(it)
      } else if (OPTIONAL_PREFERRED_LEVELS.has(it.level)) {
        preferred.push({ ...it, defaultPreferred: true })
      } else {
        nonPreferred.push(it)
      }
    }
  }
  const out: LegendGroup[] = []
  if (preferred.length) out.push({ defaultPreferred: true, items: preferred })
  if (nonPreferred.length) out.push({ defaultPreferred: false, items: nonPreferred })
  return out
}

// ── Route quality stats ─────────────────────────────────────────────────────

export interface RouteQuality {
  preferred: number
  other: number
  walking: number
  /** Per-tier fractions for the preferred portion. Keys present only when >0. */
  byLevel: Partial<Record<PathLevel, number>>
}

/** Haversine distance in metres. Inlined here to avoid a circular import
 *  with clientRouter (which already imports from this file). */
function segLengthM(coords: [number, number][]): number {
  if (coords.length < 2) return 0
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  let total = 0
  for (let i = 1; i < coords.length; i++) {
    const [lat1, lng1] = coords[i - 1]
    const [lat2, lng2] = coords[i]
    const dLat = toRad(lat2 - lat1)
    const dLng = toRad(lng2 - lng1)
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
    total += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  }
  return total
}

/**
 * Fraction of route (by actual on-the-ground distance) on preferred, other,
 * and walking infrastructure, plus a per-tier breakdown for the preferred
 * portion.
 *
 * Distance-weighted, NOT coordinate-count-weighted: OSM way vertex density
 * varies wildly (straight cycleways often have 4-5 coords for 800 m, while
 * curvy residential streets pack 10+ coords into 200 m). Coord-count
 * weighting systematically over-counts curvy non-preferred segments
 * relative to straight preferred ones, producing a breakdown bar that
 * doesn't match what the user visually sees on the map (Bryan reported
 * 53% non-preferred on a route that looked mostly green, 2026-04-26).
 *
 * `byLevel` buckets preferred segments by the PROFILE_LEGEND item's `level`
 * (1a/1b/2a). The distribution plot in DirectionsPanel uses this to render
 * the preferred share as tier-colored sub-segments — matching the map
 * overlay + SimpleLegend swatches.
 *
 * `profileKey` is optional; when absent, the per-level breakdown is skipped
 * and `byLevel` is empty. Existing call sites that just read
 * preferred/other/walking keep working.
 */
export function computeRouteQuality(
  segments: RouteSegment[],
  preferredItemNames: Set<string>,
  profileKey?: string,
): RouteQuality {
  if (!segments.length) return { preferred: 0, other: 0, walking: 0, byLevel: {} }
  let preferred = 0, other = 0, walking = 0
  const levelCounts: Partial<Record<PathLevel, number>> = {}
  for (const seg of segments) {
    const lengthM = segLengthM(seg.coordinates)
    if (lengthM <= 0) continue
    if (seg.isWalking) walking += lengthM
    else if (seg.itemName && preferredItemNames.has(seg.itemName)) {
      preferred += lengthM
      // Prefer seg.pathLevel (populated in clientRouter from classifyEdge —
      // same source the map painter uses). Fall back to the legend-item
      // lookup for segments built before pathLevel was threaded through.
      const lvl = seg.pathLevel ?? (profileKey ? getLegendItem(seg.itemName, profileKey)?.level : undefined)
      if (lvl) levelCounts[lvl] = (levelCounts[lvl] ?? 0) + lengthM
    } else other += lengthM
  }
  const total = preferred + other + walking || 1
  const byLevel: Partial<Record<PathLevel, number>> = {}
  for (const [k, v] of Object.entries(levelCounts)) {
    if (v) byLevel[k as PathLevel] = v / total
  }
  return { preferred: preferred / total, other: other / total, walking: walking / total, byLevel }
}

// ── Gap healing ─────────────────────────────────────────────────────────────

const MAX_GAP_COORDS = 5 // ~30m at typical OSM resolution

/**
 * Heal short non-preferred gaps between preferred segments.
 * At intersections, OSM often has a few meters of unclassified crossing
 * between two preferred paths. These show as orange slivers and drag down
 * quality metrics. If a non-preferred segment is ≤ MAX_GAP_COORDS coordinates
 * with preferred segments on both sides, reclassify it as the surrounding type.
 */
export function healSegmentGaps(
  segments: RouteSegment[],
  preferredItemNames: Set<string>,
): RouteSegment[] {
  if (segments.length < 3) return segments

  const result = [...segments]
  for (let i = 1; i < result.length - 1; i++) {
    const seg = result[i]
    if (seg.isWalking) continue // don't heal walking segments
    const isPreferred = seg.itemName !== null && preferredItemNames.has(seg.itemName)
    if (isPreferred) continue // already preferred

    // Check if this short non-preferred gap is between preferred segments
    if (seg.coordinates.length > MAX_GAP_COORDS) continue

    const prev = result[i - 1]
    const next = result[i + 1]
    const prevPreferred = prev.itemName !== null && preferredItemNames.has(prev.itemName) && !prev.isWalking
    const nextPreferred = next.itemName !== null && preferredItemNames.has(next.itemName) && !next.isWalking

    if (prevPreferred && nextPreferred) {
      // Heal: adopt the previous segment's classification, INCLUDING
      // pathLevel. Previously we only copied itemName, which left a
      // healed gap with itemName='Bike path' (1a) but pathLevel='3'
      // (yellow). The map painter colors by pathLevel-when-preferred,
      // so the gap rendered as a yellow sliver inside what visually
      // should have been a continuous green segment. The bar's
      // computeRouteQuality bucketed it under byLevel['3'] but the
      // sliver was usually <0.5%, hiding from the labels — so users
      // saw "yellow on the route polyline that doesn't appear in the
      // bar." (Bryan, 2026-04-28 launch-blocking bug report.)
      result[i] = { ...seg, itemName: prev.itemName, pathLevel: prev.pathLevel }
    }
  }

  return result
}

// ── Preferred item helpers ──────────────────────────────────────────────────

/**
 * Returns the set of item names that are preferred by default for a profile.
 * Pass `showNonPreferred=true` to promote the optional 2b / 3 items into the
 * preferred set (user opt-in via adminSettings).
 */
export function getDefaultPreferredItems(
  profileKey: string,
  showNonPreferred: boolean = false,
): Set<string> {
  const groups = showNonPreferred
    ? getEffectiveProfileLegend(profileKey, true)
    : PROFILE_LEGEND[profileKey]
  if (!groups) return new Set()
  const names = new Set<string>()
  for (const group of groups) {
    if (group.defaultPreferred) {
      group.items.forEach((item) => names.add(item.name))
    }
  }
  return names
}

/**
 * Look up a legend item by name for a given profile. Used for tooltip icons.
 */
export function getLegendItem(name: string | null, profileKey: string): LegendItem | undefined {
  if (!name) return undefined
  const groups = PROFILE_LEGEND[profileKey]
  if (!groups) return undefined
  for (const group of groups) {
    const item = group.items.find((i) => i.name === name)
    if (item) return item
  }
  return undefined
}

// getCostingFromPreferences was a Valhalla-specific helper that computed
// `use_roads` from the user's preferred items. It has been removed: the main
// app no longer uses Valhalla, and the client router reads preferences
// directly from the preferred-item set without needing a costing translation.
// If you need this for benchmarking against Valhalla, see
// src/services/benchmark/valhalla.ts.

// THE rough-surface list. Binary: a surface is either rough or it isn't.
// Rough surfaces are hidden from the overlay AND carry the 5× routing
// cost penalty. One list, used everywhere — no mode-specific overrides
// (per Bryan 2026-04-23 "let's just have things that are rough or
// things that are not rough and have that be consistent for both the
// overlay and also for routing").
//
// Rough = any of:
//   - soft/unrideable: mud, sand, grass
//   - loose/coarse: gravel, pebblestone, woodchips
//   - bumpy paved: cobblestone (+ variants), sett
//
// Not rough (always visible + normal cost):
//   - asphalt, concrete(+plates/lanes), paved, paving_stones
//   - compacted, fine_gravel, dirt, earth, ground, unpaved
//   - wood, metal
export const UNRIDEABLE_SURFACES = new Set([
  'mud', 'sand', 'grass',
  'gravel', 'pebblestone', 'woodchips',
  'cobblestone', 'sett', 'unhewn_cobblestone', 'cobblestone:flattened',
])

// Alias — same list for routing cost as for overlay-hide. Kept named
// ALWAYS_BAD_SURFACES for backwards-compat with internal callers that
// distinguished "always bad" from "speed-sensitive". The distinction
// collapsed in the 2026-04-23 simplification.
const ALWAYS_BAD_SURFACES = UNRIDEABLE_SURFACES

/**
 * Check if a surface is rough. Binary — same for every mode, same for
 * overlay + routing (per Bryan 2026-04-23). The `profileKey` parameter
 * is kept for API stability but no longer influences the result.
 */
export function isBadSurface(surface: string, _profileKey?: string): boolean {
  return UNRIDEABLE_SURFACES.has(surface)
}

// Used by the Overpass query filter. Same as UNRIDEABLE_SURFACES now
// that mode-sensitive surfaces are gone.
export const BAD_SURFACES = UNRIDEABLE_SURFACES

// Smoothness values that indicate a rough road regardless of surface tag.
// Used for both the overlay-hide and routing penalty (per 2026-04-23
// binary simplification).
export const BAD_SMOOTHNESS = new Set([
  'bad', 'very_bad', 'horrible', 'very_horrible', 'impassable',
])

// Maps road_class string values returned by Valhalla API to a numeric rank.
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

// ── Valhalla edge → legend item name ───────────────────────────────────────
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
//                                    and upgrades to 'separated' tier for toddler)
//   edge.cycle_lane=share_busway ↔ cycleway=share_busway
//   edge.cycle_lane=shared      ↔  sharrow markings
//   edge.road_class=residential  ↔  highway=residential
//
// NOTE: Valhalla does NOT expose cycleway:separation or cycleway:buffer tags in
// edge attributes, so it cannot distinguish plain painted lanes from bollard-protected
// ones. The overpass.ts overlay checks these directly from OSM via hasSeparation().

/**
 * Returns the PROFILE_LEGEND item name for a Valhalla edge, or null if the
 * infrastructure is not represented in the legend (e.g. arterial roads).
 * Benchmark-only path. Surface roughness is NOT folded into the item name —
 * a rough bike path still classifies as "Bike path". Benchmarks that want
 * to distinguish must read `edge.surface` separately.
 */
export function classifyEdgeToItem(
  edge: ValhallaEdge | null | undefined,
  _profileKey: string,
): string | null {
  if (!edge) return null

  const use         = edge.use          ?? ''
  const cycleLane   = edge.cycle_lane   ?? ''
  const roadClass   = edge.road_class   ?? ''
  const bicycleRoad = edge.bicycle_road ?? false

  if (bicycleRoad) return 'Fahrradstrasse'

  if (use === 'cycleway' || use === 'path' || use === 'mountain_bike') return 'Bike path'
  if (use === 'footway' || use === 'pedestrian') return 'Shared use path'

  if (cycleLane === 'separated') return 'Elevated sidewalk path'

  if (cycleLane === 'dedicated') return 'Painted bike lane on quiet street'
  if (use === 'living_street')   return 'Living street'
  if (cycleLane === 'share_busway') return 'Shared bus lane on quiet street'
  if (cycleLane === 'shared') return null  // sharrow — not in legend

  const rcRank = ROAD_CLASS_RANK[roadClass] ?? 5
  if (rcRank >= 6) return 'Quiet street'       // residential / service
  if (rcRank >= 4) return 'Major road'         // tertiary / unclassified

  return null  // arterial roads (primary, secondary) not in legend
}

interface ClassifiedPoint {
  itemName: string | null
  coord: [number, number]
}

/**
 * Returns all route segments for map display.
 *
 * ALL segments are always shown — preferred segments in green, non-preferred
 * in orange. The user sees the complete route path regardless of their
 * profile preferences. This is intentional: the route IS the path, so hiding
 * any part of it would be misleading.
 *
 * The showOtherPaths toggle (in the Legend) controls the OVERLAY (background
 * infrastructure tiles), NOT the route segments returned here.
 *
/**
 * Group an array of { itemName, coord } points into contiguous RouteSegments of the same item.
 */
export function buildSegments(classified: ClassifiedPoint[]): RouteSegment[] {
  if (!classified.length) return []

  const out: RouteSegment[] = []
  let current: RouteSegment = {
    itemName: classified[0].itemName,
    coordinates: [classified[0].coord],
  }

  for (let i = 1; i < classified.length; i++) {
    const item = classified[i]
    if (item.itemName === current.itemName) {
      current.coordinates.push(item.coord)
    } else {
      // Carry over last coord so segments are visually connected
      const bridgeCoord = current.coordinates[current.coordinates.length - 1]
      out.push(current)
      current = { itemName: item.itemName, coordinates: [bridgeCoord, item.coord] }
    }
  }
  out.push(current)
  return out
}
