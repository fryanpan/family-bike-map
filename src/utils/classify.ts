import type { ValhallaEdge, RouteSegment } from './types'

// Two-tone display palette — preferred paths green, other paths orange.
// Chosen for high contrast against OpenStreetMap tile backgrounds.
export const PREFERRED_COLOR = '#10b981'  // teal-green
export const OTHER_COLOR     = '#f97316'  // orange

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
}

export interface LegendGroup {
  defaultPreferred: boolean
  items: LegendItem[]
}

export const PROFILE_LEGEND: Record<string, LegendGroup[]> = {
  // Strictest. Only physically car-separated infra. Default mode on first launch.
  // Elevated sidewalk paths count — they're curb-separated even though next to a road.
  'kid-starting-out': [
    { defaultPreferred: true, items: [
      { icon: '🚴', name: 'Bike path',              defaultPreferred: true },
      { icon: '🛤️', name: 'Shared foot path',      defaultPreferred: true },
      { icon: '🛡️', name: 'Elevated sidewalk path', defaultPreferred: true },
    ]},
    { defaultPreferred: false, items: [
      { icon: '🚲', name: 'Fahrradstrasse',         defaultPreferred: false },
      { icon: '🏘️', name: 'Living street',          defaultPreferred: false },
      { icon: '〰️', name: 'Painted bike lane',      defaultPreferred: false },
      { icon: '🚌', name: 'Shared bus lane',        defaultPreferred: false },
      { icon: '🏠', name: 'Residential/local road', defaultPreferred: false },
      { icon: '⚠️', name: 'Rough surface',          defaultPreferred: false },
    ]},
  ],

  // Kid has good control + basic awareness. Adds quiet residential and
  // sidewalk-elevated tracks to the preferred set.
  'kid-confident': [
    { defaultPreferred: true, items: [
      { icon: '🚴', name: 'Bike path',          defaultPreferred: true },
      { icon: '🚲', name: 'Fahrradstrasse',     defaultPreferred: true },
      { icon: '🛤️', name: 'Shared foot path',  defaultPreferred: true },
    ]},
    { defaultPreferred: true, items: [
      { icon: '🛡️', name: 'Elevated sidewalk path', defaultPreferred: true },
      { icon: '🏘️', name: 'Living street',          defaultPreferred: true },
    ]},
    { defaultPreferred: false, items: [
      { icon: '〰️', name: 'Painted bike lane',      defaultPreferred: false },
      { icon: '🚌', name: 'Shared bus lane',        defaultPreferred: false },
      { icon: '🏠', name: 'Residential/local road', defaultPreferred: false },
      { icon: '⚠️', name: 'Rough surface',          defaultPreferred: false },
    ]},
  ],

  // Kid handles painted lanes + intersections. Adds residential and painted
  // lanes to the preferred set; arterial roads still excluded by router.
  'kid-traffic-savvy': [
    { defaultPreferred: true, items: [
      { icon: '🚴', name: 'Bike path',          defaultPreferred: true },
      { icon: '🚲', name: 'Fahrradstrasse',     defaultPreferred: true },
      { icon: '🛤️', name: 'Shared foot path',  defaultPreferred: true },
      { icon: '🛡️', name: 'Elevated sidewalk path', defaultPreferred: true },
      { icon: '🏘️', name: 'Living street',          defaultPreferred: true },
    ]},
    { defaultPreferred: true, items: [
      { icon: '〰️', name: 'Painted bike lane',      defaultPreferred: true },
      { icon: '🏠', name: 'Residential/local road', defaultPreferred: true },
    ]},
    { defaultPreferred: false, items: [
      { icon: '🚌', name: 'Shared bus lane',        defaultPreferred: false },
      { icon: '⚠️', name: 'Rough surface',          defaultPreferred: false },
    ]},
  ],

  // Adult pilots a child seat / cargo bike / trailer. Surface-strict;
  // willing to take residential and painted lanes since adult has judgment.
  'carrying-kid': [
    { defaultPreferred: true, items: [
      { icon: '🚴', name: 'Bike path',          defaultPreferred: true },
      { icon: '🚲', name: 'Fahrradstrasse',     defaultPreferred: true },
      { icon: '🛤️', name: 'Shared foot path',  defaultPreferred: true },
      { icon: '🚌', name: 'Shared bus lane',    defaultPreferred: true },
    ]},
    { defaultPreferred: true, items: [
      { icon: '〰️', name: 'Painted bike lane',      defaultPreferred: true },
      { icon: '🏘️', name: 'Living street',          defaultPreferred: true },
      { icon: '🏠', name: 'Residential/local road', defaultPreferred: true },
    ]},
    { defaultPreferred: false, items: [
      { icon: '🛡️', name: 'Elevated sidewalk path', defaultPreferred: false },
      { icon: '⚠️', name: 'Rough surface',          defaultPreferred: false },
    ]},
  ],

  // Bryan's mode. Adult fitness ride. Prioritizes 30 km/h flow.
  // Secondary — Komoot exists for this use case.
  training: [
    { defaultPreferred: true, items: [
      { icon: '🚴', name: 'Bike path',          defaultPreferred: true },
      { icon: '🚲', name: 'Fahrradstrasse',     defaultPreferred: true },
      { icon: '🛤️', name: 'Shared foot path',  defaultPreferred: true },
      { icon: '〰️', name: 'Painted bike lane',  defaultPreferred: true },
      { icon: '🚌', name: 'Shared bus lane',    defaultPreferred: true },
    ]},
    { defaultPreferred: true, items: [
      { icon: '🏘️', name: 'Living street',          defaultPreferred: true },
      { icon: '🏠', name: 'Residential/local road', defaultPreferred: true },
    ]},
    { defaultPreferred: false, items: [
      { icon: '🛡️', name: 'Elevated sidewalk path', defaultPreferred: false },
      { icon: '⚠️', name: 'Rough surface',          defaultPreferred: false },
    ]},
  ],
}

// ── Route quality stats ─────────────────────────────────────────────────────

export interface RouteQuality { preferred: number; other: number; walking: number }

/**
 * Fraction of route (by coordinate count) on preferred, other, and walking infrastructure.
 */
export function computeRouteQuality(
  segments: RouteSegment[],
  preferredItemNames: Set<string>,
): RouteQuality {
  if (!segments.length) return { preferred: 0, other: 0, walking: 0 }
  let preferred = 0, other = 0, walking = 0
  for (const seg of segments) {
    const count = Math.max(1, seg.coordinates.length - 1)
    if (seg.isWalking) walking += count
    else if (seg.itemName && preferredItemNames.has(seg.itemName)) preferred += count
    else other += count
  }
  const total = preferred + other + walking || 1
  return { preferred: preferred / total, other: other / total, walking: walking / total }
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
      // Heal: adopt the previous segment's classification
      result[i] = { ...seg, itemName: prev.itemName }
    }
  }

  return result
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

// getCostingFromPreferences was a Valhalla-specific helper that computed
// `use_roads` from the user's preferred items. It has been removed: the main
// app no longer uses Valhalla, and the client router reads preferences
// directly from the preferred-item set without needing a costing translation.
// If you need this for benchmarking against Valhalla, see
// src/services/benchmark/valhalla.ts.

// Surfaces that are always rough regardless of travel mode.
const ALWAYS_BAD_SURFACES = new Set([
  'cobblestone', 'sett', 'unhewn_cobblestone', 'cobblestone:flattened',
  'gravel', 'unpaved', 'dirt', 'earth', 'ground', 'mud', 'sand',
  'grass', 'fine_gravel', 'pebblestone', 'woodchips',
])

// Surfaces that are rough only at higher speeds (trailer pulling, training ride).
// Paving stones are the standard Berlin bike path material — fine for a toddler
// at low speed, but bumpy at trailer/training speed.
const SPEED_SENSITIVE_SURFACES = new Set([
  'paving_stones', 'paving_stones:lanes',
])

/**
 * Check if a surface is bad for a given travel mode.
 * - Slow kid modes (kid-starting-out, kid-confident): only universally bad
 *   surfaces. Paving stones are OK — Berlin's standard bike path material,
 *   fine at 5–10 km/h on a kid bike.
 * - Higher-speed modes (kid-traffic-savvy at 16 km/h, carrying-kid with a
 *   trailer, training at 30 km/h): paving stones count as rough too.
 *
 * Invariant: the set of "fine" surfaces for kid-confident is a strict
 * SUPERSET of kid-starting-out, so toggling from starting-out → confident
 * never makes a green segment turn orange on the map.
 */
export function isBadSurface(surface: string, profileKey: string): boolean {
  if (ALWAYS_BAD_SURFACES.has(surface)) return true
  const slowKidMode = profileKey === 'kid-starting-out' || profileKey === 'kid-confident'
  if (!slowKidMode && SPEED_SENSITIVE_SURFACES.has(surface)) return true
  return false
}

// Kept for backwards compat with overpass.ts import (used in Overpass query filter).
// This is the union of all bad surfaces across all modes.
export const BAD_SURFACES = new Set([...ALWAYS_BAD_SURFACES, ...SPEED_SENSITIVE_SURFACES])

// Smoothness values that indicate a rough road regardless of surface tag.
export const BAD_SMOOTHNESS = new Set([
  'bad', 'very_bad', 'horrible', 'very_horrible', 'impassable',
])

export const ROUGH_ROAD_ITEM = 'Rough surface'

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

  // Bad surfaces → classified as rough road (travel-mode-aware)
  if (surface && isBadSurface(surface, profileKey)) return ROUGH_ROAD_ITEM

  // Fahrradstrasse must come before cycleway/path checks (bicycle_road tag wins)
  if (bicycleRoad) return 'Fahrradstrasse'

  if (use === 'cycleway' || use === 'path' || use === 'mountain_bike') return 'Bike path'
  if (use === 'footway' || use === 'pedestrian') return 'Shared foot path'

  if (cycleLane === 'separated') return 'Elevated sidewalk path'

  if (cycleLane === 'dedicated') return 'Painted bike lane'
  if (use === 'living_street')   return 'Living street'
  if (cycleLane === 'share_busway') return 'Shared bus lane'
  if (cycleLane === 'shared') return null  // sharrow — not in legend

  const rcRank = ROAD_CLASS_RANK[roadClass] ?? 5
  if (rcRank >= 4) return 'Residential/local road'

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
