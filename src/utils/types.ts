// Shared domain types

export interface LatLng {
  lat: number
  lng: number
}

export interface Place extends LatLng {
  label: string
  shortLabel: string
}

/** Extract city/district from a Nominatim display_name (e.g. "Kreuzberg, Berlin"). */
export function getPlaceDetail(label: string): string {
  return label.split(', ').slice(1, 3).join(', ')
}

export type BicycleType = 'Hybrid' | 'Road' | 'Cross' | 'Mountain'

export interface BicycleCostingOptions {
  bicycle_type: BicycleType
  cycling_speed: number
  use_roads: number
  avoid_bad_surfaces: number
  use_hills: number
  use_ferry: number
  use_living_streets?: number
}

export interface RiderProfile {
  label: string
  emoji: string
  description: string
  costingOptions: BicycleCostingOptions
  editable: boolean
  avoidances?: string[]
}

export type ProfileKey = string

export type ProfileMap = Record<ProfileKey, RiderProfile>

export interface SafetyInfo {
  label: string
  color: string
  icon: string
  textColor: string
}

/**
 * Edge attributes returned by Valhalla trace_attributes.
 *
 * The public Valhalla API (valhalla1.openstreetmap.de) returns string values for
 * enum fields, not the legacy numeric codes found in older documentation.
 *
 * edge.use strings (key ones):
 *   "road", "living_street", "cycleway", "mountain_bike", "path",
 *   "footway", "pedestrian", "service_road", "driveway"
 *
 * edge.cycle_lane strings:
 *   "none", "shared" (sharrow), "dedicated" (painted lane),
 *   "separated" (elevated/physical barrier), "share_busway"
 *
 * edge.road_class strings:
 *   "motorway", "trunk", "primary", "secondary", "tertiary",
 *   "unclassified", "residential", "service_other"
 *
 * edge.bicycle_network:
 *   0 = none, 1 = national, 2 = regional, 4 = local, 8 = mountain
 *   NOTE: This tracks cycling route networks (NCN/RCN/LCN), NOT bicycle_road=yes.
 *
 * edge.bicycle_road:
 *   true if the OSM way has bicycle_road=yes (Fahrradstrasse in Germany)
 */
export interface ValhallaEdge {
  use?: string
  cycle_lane?: string
  road_class?: string
  bicycle_network?: number
  /** True for Fahrradstrasse (OSM: bicycle_road=yes) */
  bicycle_road?: boolean
  surface?: string
}

/**
 * A contiguous stretch of route with a single infrastructure type.
 * itemName is the PROFILE_LEGEND item name (e.g. 'Fahrradstrasse'), or null
 * for infrastructure not represented in the legend (e.g. cobblestone overlay,
 * arterial roads). Null items are always treated as non-preferred.
 */
export interface RouteSegment {
  itemName: string | null
  coordinates: [number, number][]
  /** True when the rider should dismount and walk their bike on this segment. */
  isWalking?: boolean
  /**
   * OSM way IDs this segment was built from. Used by "reroute around this
   * segment" to add the specific ways to a session avoid list before
   * recomputing the route.
   */
  wayIds?: number[]
  /**
   * PathLevel from classifyEdge(tags) at build time. Single source of
   * truth for coloring on the map — both the route painter (Map.tsx)
   * and the overlay (BikeMapOverlay.tsx) use this, so route and overlay
   * colors can't diverge for the same underlying way.
   */
  pathLevel?: import('./lts').PathLevel
}

export interface ValhallaManeuver {
  type: number
  instruction: string
  length: number
  time: number
  begin_shape_index?: number
}

export interface LtsSegmentInfo {
  name: string
  lts: 1 | 2 | 3 | 4
  lengthM: number
}

export interface RouteLtsBreakdown {
  lts1Pct: number
  lts2Pct: number
  lts3Pct: number
  lts4Pct: number
  worstLts: 1 | 2 | 3 | 4
  familySafetyScore: number
  /** The single worst segment by LTS level (for callout display). */
  worstSegment: LtsSegmentInfo | null
}

export interface Route {
  coordinates: [number, number][]
  maneuvers: ValhallaManeuver[]
  summary: {
    distance: number // km
    duration: number // seconds
    /** Junction turns ≥60° (instruction count). Client router only. */
    turns?: number
  }
  segments?: RouteSegment[]
  /** Which routing engine produced this route (e.g. 'valhalla', 'brouter'). */
  engine?: string
  /** LTS breakdown, available when the route has per-segment OSM tags (BRouter). */
  ltsBreakdown?: RouteLtsBreakdown
}

export interface OsmWay {
  itemName: string | null
  coordinates: [number, number][]
  osmId: number
  tags: Record<string, string>
}
// Note: roughness is NOT a cached field on OsmWay because it's profile-
// dependent (paving_stones is fine for slow kid modes but rough for
// higher-speed modes). Callers use `isRoughSurface(tags, profileKey)`
// in overpass.ts to compute it at render/routing time.
