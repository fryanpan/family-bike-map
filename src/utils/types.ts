// Shared domain types

export interface LatLng {
  lat: number
  lng: number
}

export interface Place extends LatLng {
  label: string
  shortLabel: string
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
}

export type ProfileKey = string

export type ProfileMap = Record<ProfileKey, RiderProfile>

export type SafetyClass = 'great' | 'good' | 'ok' | 'acceptable' | 'caution' | 'avoid'

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

export interface RouteSegment {
  safetyClass: SafetyClass
  coordinates: [number, number][]
}

export interface ValhallaManeuver {
  type: number
  instruction: string
  length: number
  time: number
}

export interface Route {
  coordinates: [number, number][]
  maneuvers: ValhallaManeuver[]
  summary: {
    distance: number // km
    duration: number // seconds
  }
  segments?: RouteSegment[]
}

export interface OsmWay {
  safetyClass: SafetyClass
  coordinates: [number, number][]
  osmId: number
  tags: Record<string, string>
}
