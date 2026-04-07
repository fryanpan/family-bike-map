import type { ValhallaEdge, RouteSegment, BicycleCostingOptions, RiderProfile } from './types'

// Two-tone display palette — preferred paths green, other paths orange.
// Chosen for high contrast against OpenStreetMap tile backgrounds.
export const PREFERRED_COLOR = '#10b981'  // teal-green
export const OTHER_COLOR     = '#f97316'  // orange

// ── Profile-aware legend ────────────────────────────────────────────────────
// Each profile defines its path types, which are preferred by default, and
// the Valhalla use_roads value that each type implies when preferred.
//
// useRoads controls how willing Valhalla is to route on car roads (0 = avoid,
// 1 = freely use). Preferred items set the effective use_roads for the route
// request — the max useRoads across all preferred items wins.

export interface LegendItem {
  icon: string
  name: string
  useRoads: number        // Valhalla use_roads implied when this item is preferred
  defaultPreferred: boolean
}

export interface LegendGroup {
  defaultPreferred: boolean
  items: LegendItem[]
}

export const PROFILE_LEGEND: Record<string, LegendGroup[]> = {
  toddler: [
    { defaultPreferred: true, items: [
      { icon: '🚴', name: 'Car-free path / Radweg',    useRoads: 0.0,  defaultPreferred: true },
      { icon: '🚲', name: 'Fahrradstrasse',             useRoads: 0.0,  defaultPreferred: true },
      { icon: '🛤️', name: 'Shared footway (park path)', useRoads: 0.0,  defaultPreferred: true },
    ]},
    { defaultPreferred: true, items: [
      { icon: '🛡️', name: 'Separated bike track',       useRoads: 0.05, defaultPreferred: true },
      { icon: '🏘️', name: 'Living street',              useRoads: 0.05, defaultPreferred: true },
    ]},
    { defaultPreferred: false, items: [
      { icon: '〰️', name: 'Painted bike lane',          useRoads: 0.3,  defaultPreferred: false },
      { icon: '🚌', name: 'Shared bus lane',            useRoads: 0.3,  defaultPreferred: false },
      { icon: '🏠', name: 'Residential & local road',           useRoads: 0.5,  defaultPreferred: false },
      { icon: '⚠️', name: 'Rough road (e.g. cobblestone)', useRoads: 0.5, defaultPreferred: false },
    ]},
  ],
  trailer: [
    { defaultPreferred: true, items: [
      { icon: '🚴', name: 'Car-free path / Radweg',    useRoads: 0.0,  defaultPreferred: true },
      { icon: '🚲', name: 'Fahrradstrasse',             useRoads: 0.0,  defaultPreferred: true },
      { icon: '🛤️', name: 'Shared footway (park path)', useRoads: 0.0,  defaultPreferred: true },
      { icon: '🚌', name: 'Shared bus lane',            useRoads: 0.15, defaultPreferred: true },
    ]},
    { defaultPreferred: true, items: [
      { icon: '〰️', name: 'Painted bike lane',          useRoads: 0.15, defaultPreferred: true },
      { icon: '🏘️', name: 'Living street',              useRoads: 0.05, defaultPreferred: true },
      { icon: '🏠', name: 'Residential & local road',           useRoads: 0.15, defaultPreferred: true },
    ]},
    { defaultPreferred: false, items: [
      { icon: '🛡️', name: 'Separated bike track (narrow)', useRoads: 0.0, defaultPreferred: false },
      { icon: '⚠️', name: 'Rough road (e.g. cobblestone)', useRoads: 0.15, defaultPreferred: false },
    ]},
  ],
  training: [
    { defaultPreferred: true, items: [
      { icon: '🚴', name: 'Car-free path / Radweg',    useRoads: 0.0,  defaultPreferred: true },
      { icon: '🚲', name: 'Fahrradstrasse',             useRoads: 0.0,  defaultPreferred: true },
      { icon: '🛤️', name: 'Shared footway (park path)', useRoads: 0.0,  defaultPreferred: true },
      { icon: '〰️', name: 'Painted bike lane',          useRoads: 0.6,  defaultPreferred: true },
      { icon: '🚌', name: 'Shared bus lane',            useRoads: 0.6,  defaultPreferred: true },
    ]},
    { defaultPreferred: true, items: [
      { icon: '🏘️', name: 'Living street',              useRoads: 0.5,  defaultPreferred: true },
      { icon: '🏠', name: 'Residential & local road',           useRoads: 0.6,  defaultPreferred: true },
    ]},
    { defaultPreferred: false, items: [
      { icon: '🛡️', name: 'Separated bike track (slow)', useRoads: 0.0, defaultPreferred: false },
      { icon: '⚠️', name: 'Rough road (e.g. cobblestone)', useRoads: 0.6, defaultPreferred: false },
    ]},
  ],
}

// ── Route quality stats ─────────────────────────────────────────────────────

export interface RouteQuality { preferred: number; other: number }

/**
 * Fraction of route (by coordinate count) on preferred vs. other infrastructure.
 */
export function computeRouteQuality(
  segments: RouteSegment[],
  preferredItemNames: Set<string>,
): RouteQuality {
  if (!segments.length) return { preferred: 0, other: 0 }
  let preferred = 0, other = 0
  for (const seg of segments) {
    const count = Math.max(1, seg.coordinates.length - 1)
    if (seg.itemName && preferredItemNames.has(seg.itemName)) preferred += count
    else other += count
  }
  const total = preferred + other || 1
  return { preferred: preferred / total, other: other / total }
}

// ── Preferred item helpers ──────────────────────────────────────────────────

/**
 * Returns the set of item names that are preferred by default for a profile.
 */
export function getDefaultPreferredItems(profileKey: string): Set<string> {
  const groups = PROFILE_LEGEND[profileKey]
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

/**
 * Compute Valhalla costing options from the user's current preferred items.
 * use_roads is the max useRoads across all preferred items; use_living_streets
 * is boosted when 'Living street' is preferred.
 */
export function getCostingFromPreferences(
  preferredItemNames: Set<string>,
  profileKey: string,
  baseProfile: RiderProfile,
): BicycleCostingOptions {
  const groups = PROFILE_LEGEND[profileKey]
  if (!groups) return baseProfile.costingOptions

  let useRoads = 0.0
  let useLivingStreets = 0.5

  for (const group of groups) {
    for (const item of group.items) {
      if (preferredItemNames.has(item.name)) {
        useRoads = Math.max(useRoads, item.useRoads)
        if (item.name === 'Living street') useLivingStreets = 1.0
      }
    }
  }

  return {
    ...baseProfile.costingOptions,
    use_roads: useRoads,
    use_living_streets: useLivingStreets,
  }
}

// Surfaces that are rough/uncomfortable for family cycling.
// Imported by overpass.ts (single source of truth).
export const BAD_SURFACES = new Set([
  'cobblestone', 'paving_stones', 'sett', 'unhewn_cobblestone',
  'cobblestone:flattened', 'gravel', 'unpaved',
])

// Smoothness values that indicate a rough road regardless of surface tag.
export const BAD_SMOOTHNESS = new Set([
  'bad', 'very_bad', 'horrible', 'very_horrible', 'impassable',
])

export const ROUGH_ROAD_ITEM = 'Rough road (e.g. cobblestone)'

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
 * infrastructure is not represented in the legend (e.g. cobblestones, arterial roads).
 * The returned name can be checked directly against preferredItemNames.
 */
export function classifyEdgeToItem(
  edge: ValhallaEdge | null | undefined,
  profileKey: string,
): string | null {
  if (!edge) return null

  const use         = edge.use          ?? ''
  const cycleLane   = edge.cycle_lane   ?? ''
  const roadClass   = edge.road_class   ?? ''
  const bicycleRoad = edge.bicycle_road ?? false
  const surface     = edge.surface      ?? ''

  // Bad surfaces → classified as rough road (visible on map, not preferred)
  if (BAD_SURFACES.has(surface)) return ROUGH_ROAD_ITEM

  // Fahrradstrasse must come before cycleway/path checks (bicycle_road tag wins)
  if (bicycleRoad) return 'Fahrradstrasse'

  if (use === 'cycleway' || use === 'path' || use === 'mountain_bike') return 'Car-free path / Radweg'
  if (use === 'footway' || use === 'pedestrian') return 'Shared footway (park path)'

  if (cycleLane === 'separated') {
    if (profileKey === 'toddler') return 'Separated bike track'
    if (profileKey === 'trailer') return 'Separated bike track (narrow)'
    if (profileKey === 'training') return 'Separated bike track (slow)'
    return null
  }

  if (cycleLane === 'dedicated') return 'Painted bike lane'
  if (use === 'living_street')   return 'Living street'
  if (cycleLane === 'share_busway') return 'Shared bus lane'
  if (cycleLane === 'shared') return null  // sharrow — not in legend

  const rcRank = ROAD_CLASS_RANK[roadClass] ?? 5
  if (rcRank >= 4) return 'Residential & local road'

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
