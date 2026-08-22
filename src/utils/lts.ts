/**
 * Level of Traffic Stress (LTS) scoring per segment.
 *
 * Based on Furth (2012) / Conveyal simplified method, calibrated per
 * Mineta Transportation Institute's "Low-Stress Bicycling and Network
 * Connectivity" (Mekuria, Furth, Nixon 2012). LTS levels are explicitly
 * tied to Geller's Four Types of Cyclists (Portland BOT, 2006). See
 * docs/research/family-safety/standards.md.
 *
 * Uses OSM tags available in Overpass data.
 */

export type LtsLevel = 1 | 2 | 3 | 4

/**
 * Ceiling for the "calmed street" tier (pathLevel 2a). A painted lane or bus
 * lane at or below this speed counts as a bike route beside *slow* cars; above
 * it the lane is beside arterial traffic and demotes to '3'.
 *
 * 40 km/h is chosen so the two real-world regimes that mean "calmed urban
 * street" both land inside it: a European Tempo-30 zone (30 km/h) and a US
 * 25 mph street (40.2 km/h → 40). A US 30 mph street (48 km/h) is an arterial
 * and stays out, as does a European 50 km/h Hauptstraße.
 *
 * Verified against live OSM (2026-08-22): moving this from 30 to 40 changes
 * ZERO ways in central Berlin — Berlin streets are posted 30 or 50, nothing
 * sits between — while it is the difference between "reachable" and
 * "unreachable" for essentially every calmed street in San Francisco.
 */
export const QUIET_STREET_MAX_KMH = 40

/**
 * Parse an OSM `maxspeed` value to km/h.
 *
 * OSM stores speeds unit-suffixed: bare numbers are km/h by convention, and
 * US/UK ways carry an explicit `mph` suffix. Reading these with a bare
 * `parseInt` drops the unit and silently treats `"25 mph"` as 25 km/h — an
 * error in the *dangerous* direction for a family-safety product, because it
 * makes a 30 mph (48 km/h) arterial look like a quiet street.
 *
 * Returns null when the tag is absent or not a speed we understand, which
 * callers treat as "unknown" rather than "fast".
 */
export function parseMaxspeedKmh(raw: string | undefined): number | null {
  if (!raw) return null
  const value = raw.trim().toLowerCase()

  // Walking pace — living streets and shared spaces.
  if (value === 'walk' || value === 'walking') return 7
  // Explicitly derestricted (autobahn). Definitely not calm.
  if (value === 'none' || value === 'unlimited') return 130

  const match = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/.exec(value)
  if (!match) return null

  const n = parseFloat(match[1])
  if (!Number.isFinite(n) || n <= 0) return null
  return match[2] === 'mph' ? Math.round(n * 1.609344) : Math.round(n)
}

/**
 * Path Level — our extension of Furth's LTS framework with a/b sub-tiers
 * splitting LTS 1 and LTS 2 by bike-infra presence.
 *
 *   1a = physically car-free (cycleway, bike path, curb-separated track)
 *   1b = bike-prioritized shared surface (Fahrradstraße, living street,
 *        bike boulevard / SF Slow Street pattern)
 *   2a = bike infra on a calmed street (painted lane or bus lane on a
 *        street at or below QUIET_STREET_MAX_KMH)
 *   2b = quiet residential without bike infra OR LTS 2 without infra
 *   3  = LTS 3 (busy residentials, painted lane above the calmed ceiling)
 *   4  = LTS 4 (primary, secondary ≥50 km/h without infra, trunk)
 *
 * See docs/product/plans/2026-04-21-path-categories-plan.md.
 */
export type PathLevel = '1a' | '1b' | '2a' | '2b' | '3' | '4'

export const PATH_LEVELS: readonly PathLevel[] = ['1a', '1b', '2a', '2b', '3', '4']

/**
 * Single source of truth for PathLevel display props. One table, four
 * fields per level, consumed by:
 *   - SimpleLegend (uses short + displayDescription)
 *   - Admin Settings tiers (uses defaultColor + defaultWeight as the
 *     compile-time defaults; user can override per-tier in the UI)
 *   - Map.tsx + BikeMapOverlay.tsx (use short + description for popups)
 *   - AuditSamplesTab.tsx (uses short + description)
 *
 * If you're adding a new tier display surface, derive its mapping FROM
 * this table — don't add a parallel one. (Was: SIMPLE_TIERS in
 * SimpleLegend.tsx and DEFAULT_SETTINGS.tiers in adminSettings.ts both
 * had their own tier tables that drifted from the technical descriptions
 * here, surfaced by Bryan's 2026-04-27 audit.)
 *
 * Stable across travel modes — mode-specific acceptance is expressed by
 * calling `applyModeRule` on a full classification in src/data/modes.ts.
 */
export const PATH_LEVEL_LABELS: Record<PathLevel, {
  /** 1-3 word header for cramped surfaces (segment popups, audit). */
  short: string
  /** User-facing legend title — more descriptive than `short`. SimpleLegend. */
  legendTitle: string
  /** Technical description with concrete examples — admin / segment popups. */
  description: string
  /** User-friendly description for first-time visitors — SimpleLegend. */
  displayDescription: string
  /** Default tier color. Admin settings can override per-tier. */
  defaultColor: string
  /** Overlay line weight multiplier (relative to a base width). */
  defaultWeight: number
}> = {
  '1a': {
    short: 'Car-free',
    legendTitle: 'Car-free',
    description: 'Cycleways, bike paths, park paths, curb-separated cycle tracks, forest/farm tracks.',
    displayDescription: 'Bike paths, shared foot paths, elevated sidewalk paths',
    defaultColor: '#004529',
    defaultWeight: 0.75,
  },
  '1b': {
    short: 'Bike-priority',
    legendTitle: 'Bikeway with minimal cars',
    description: 'Fahrradstraße, living street, bike boulevard, SF Slow Street — cars present but legally yielding.',
    displayDescription: 'Fahrradstraße, living streets, bike boulevards',
    defaultColor: '#238443',
    defaultWeight: 0.75,
  },
  '2a': {
    short: 'Lane + quiet street',
    legendTitle: 'Bike route beside cars',
    description: 'Painted bike lane or shared bus lane on a street capped ≤30 km/h.',
    displayDescription: 'Painted bike lane or shared bus lane on quiet streets',
    defaultColor: '#2b8cbe',
    defaultWeight: 0.75,
  },
  '2b': {
    short: 'Quiet residential',
    legendTitle: 'Quiet residential street',
    description: 'Residential street without bike infra, low speed / low volume.',
    displayDescription: 'Residential street, no bike infra, speed ≤ 30 km/h',
    defaultColor: '#e78ac3',
    defaultWeight: 0.75,
  },
  '3': {
    short: 'Busy street',
    legendTitle: 'Higher traffic street',
    description: 'Tertiary, busy residentials, painted lane on 31-50 km/h — cyclist-in-traffic.',
    displayDescription: 'Streets 30–50 km/h, ≤ 3 lanes, with or without painted lane',
    defaultColor: '#ffd92f',
    defaultWeight: 0.75,
  },
  '4': {
    short: 'Major road',
    legendTitle: 'Major road',
    description: 'Primary/secondary/trunk without bike infra — unsafe for families.',
    displayDescription: 'Primary or secondary road at 50+ km/h without separation',
    defaultColor: '#999999',
    defaultWeight: 0.4,
  },
}

/**
 * Human-readable labels for LTS levels.
 *
 * `short` is the user-facing label (no jargon, no Geller terminology).
 * `official` is the Geller / Mekuria label, suitable for tooltips and
 * citations to the source research. `description` is a one-line plain-
 * language elaboration safe to render in the UI.
 *
 * UI strings should always read from this constant rather than hardcoding
 * "LTS 1" or "LTS 2" — internal code uses the LtsLevel type, but the
 * end user never sees the number.
 */
export const LTS_LABELS: Record<LtsLevel, {
  short: string
  official: string
  description: string
}> = {
  1: {
    short:       'Kid-friendly',
    official:    'Children',
    description: 'Suitable for children. Fully separated or essentially car-free.',
  },
  2: {
    short:       'Most adults',
    official:    'Interested but concerned',
    description: 'Comfortable for most adults. Quiet residential or buffered lanes.',
  },
  3: {
    short:       'Confident',
    official:    'Enthused and confident',
    description: 'Confident cyclists only. Painted lanes on busier streets.',
  },
  4: {
    short:       'Experienced',
    official:    'Strong and fearless',
    description: 'Experienced cyclists only. Mixed traffic on fast or wide roads.',
  },
}

/**
 * Rich per-edge classification returned by the LTS classifier.
 *
 * This is the Layer 1 output consumed by the Layer 1.5 mode rule check
 * (src/data/modes.ts) and by the Layer 2 region overlay. It captures more
 * than a single LTS tier number because mode rules need to distinguish:
 *
 *   - physically-separated LTS 1 (kid-starting-out accepts)
 *   - mixed-traffic LTS 1 (kid-confident accepts, kid-starting-out rejects)
 *   - LTS 2 with/without bike infrastructure (kid-traffic-savvy condition)
 *   - road speed and traffic density (mode-rule conditions on LTS 2+)
 *   - surface type (mode-rule cobble handling)
 */
export interface LtsClassification {
  lts: LtsLevel
  // Our extended path level — Furth's LTS tier with a/b sub-tier for LTS 1/2
  // split by bike-infra presence. Mode rules in src/data/modes.ts key off this
  // (not lts) to get finer acceptance granularity. See PathLevel docstring.
  pathLevel: PathLevel
  // True iff the bike does NOT share a traffic surface with motor vehicles.
  // Physically separated cycle tracks, dedicated cycleways, park paths, and
  // pedestrianised zones are all car-free. Fahrradstraßen, living streets,
  // quiet residential, and painted lanes are NOT (cars present on the same
  // surface, even if slow or rare).
  carFree: boolean
  // True iff the edge is legally or structurally engineered to give bikes
  // priority over cars on a shared surface. Fahrradstraßen (bicycle_road=yes),
  // Dutch fietsstraten (cyclestreet=yes), living streets (legally ≤ walking
  // pace for motor traffic), and residential streets restricted to local
  // access only (motor_vehicle=destination) all qualify. In practice, cars
  // on these infrastructures slow down and yield to bikes — bad actors
  // happen but are the exception, not the norm. NOTE: Layer 2 city profiles
  // may demote specific named corridors where drivers habitually misbehave.
  bikePriority: boolean
  // True iff the edge has any explicit bike infrastructure — a cycleway
  // tag, a bike path, a Fahrradstraße, or a dedicated track/lane.
  bikeInfra: boolean
  // Inferred motor vehicle operating speed (km/h). Taken from `maxspeed`
  // when present, otherwise from a road-class default. Null when not
  // applicable (car-free paths).
  speedKmh: number | null
  // Rough traffic density estimate from road class. Null for car-free paths.
  trafficDensity: TrafficDensity | null
  // OSM `surface` tag if set, otherwise null.
  surface: string | null
  // OSM `smoothness` tag if set, otherwise null. A bike path can have
  // surface=asphalt but smoothness=horrible (freeze-thaw cracked, root
  // heaves, potholed). Treated as rough independent of surface.
  smoothness: string | null
}

/**
 * Derive pathLevel from the other LtsClassification fields. Captures our two
 * departures from strict Furth:
 *   - Quiet residential (LTS 1 per Furth) demotes to '2b' when it has no bike
 *     infra or priority — the kid-first framing treats "quiet street" as
 *     meaningfully different from "bike-prioritized street."
 *   - Painted lane above QUIET_STREET_MAX_KMH demotes to '3' — Furth allows
 *     up to ~48 km/h; we tighten so '2a' genuinely represents "bike infra on
 *     a calmed street."
 *
 * See docs/product/plans/2026-04-21-path-categories-plan.md §2.
 */
function derivePathLevel(params: {
  lts: LtsLevel
  carFree: boolean
  bikePriority: boolean
  bikeInfra: boolean
  speedKmh: number | null
}): PathLevel {
  const { lts, carFree, bikePriority, bikeInfra, speedKmh } = params
  if (lts === 4) return '4'
  if (lts === 3) return '3'
  if (carFree) return '1a'
  if (bikePriority) return '1b'
  // LTS 1 or 2, shared surface without bike priority.
  // 2a requires bike infra AND a calmed street (at or below
  // QUIET_STREET_MAX_KMH, or speed unknown).
  if (bikeInfra && (speedKmh == null || speedKmh <= QUIET_STREET_MAX_KMH)) return '2a'
  // Bike infra on a faster road demotes to LTS 3 per our kid-first framing.
  if (bikeInfra) return '3'
  // Everything else (quiet residential, LTS 2 mixed traffic) → 2b.
  return '2b'
}

export type TrafficDensity = 'low' | 'moderate' | 'high'

/**
 * Classify an edge from its OSM tags. Returns a rich LtsClassification
 * object. The LTS tier is computed per Furth's canonical criteria
 * (https://peterfurth.sites.northeastern.edu/level-of-traffic-stress/);
 * the other fields are derived so mode rules can check stricter-than-LTS
 * constraints like car-free separation or traffic-density caps.
 */
export function classifyEdge(tags: Record<string, string>): LtsClassification {
  const highway = tags.highway ?? ''
  const cycleway = tags.cycleway ?? tags['cycleway:right'] ?? tags['cycleway:both'] ?? ''
  // 0 = untagged, the sentinel the comparisons below already expect.
  const maxspeed = parseMaxspeedKmh(tags.maxspeed) ?? 0
  const lanes = parseInt(tags.lanes ?? '0', 10)
  const surface = tags.surface ?? null
  const smoothness = tags.smoothness ?? null

  const isCycleway = highway === 'cycleway'
  const isPath = highway === 'path'
  const isFootway = highway === 'footway'
  const isPedestrian = highway === 'pedestrian'
  const isTrack = highway === 'track'  // forest/farm track, low motor density
  const isLivingStreet = highway === 'living_street'
  const isResidential = highway === 'residential'
  const isBikeRoad = tags.bicycle_road === 'yes' || tags.cyclestreet === 'yes'
  const bikeOnFoot = isFootway && (tags.bicycle === 'yes' || tags.bicycle === 'designated')
  const bikeOnPath = isPath && tags.bicycle !== 'no'
  const explicitlyNoMotor = tags.motor_vehicle === 'no' || tags.access === 'no'
  const hasSeparatedTrack = cycleway === 'track' || cycleway === 'opposite_track'
  const hasPaintedLane = cycleway === 'lane' || cycleway === 'opposite_lane'
  const hasBusLane = cycleway === 'share_busway'

  // carFree: the bike is not sharing a traffic surface with motor vehicles.
  // Curb-separated cycle tracks next to a road count (cars are adjacent but
  // on a different surface). `highway=track` (forest/farm track) counts as
  // car-free because motor traffic is rare and agricultural, not transport.
  const carFree =
    isCycleway ||
    isPedestrian ||
    isTrack ||
    bikeOnPath ||
    bikeOnFoot ||
    hasSeparatedTrack ||
    explicitlyNoMotor

  // bikePriority: the edge is engineered or legally designated to give bikes
  // priority over cars. Shared surface with cars, but cars are constrained
  // to yield or travel at walking pace. In practice, interactions are rare
  // and predictable. Bad actors can still happen — Layer 2 city profiles
  // may demote specific named corridors where drivers habitually misbehave
  // (e.g. SF's Noe Slow Street).
  const isLocalAccessOnly = tags.motor_vehicle === 'destination' || tags.motor_vehicle === 'permissive'
  const bikePriority =
    isBikeRoad ||                                       // Fahrradstraße / fietsstraat
    isLivingStreet ||                                   // legally ≤ walking pace for cars
    (isResidential && isLocalAccessOnly)                // SF Slow Street pattern

  // bikeInfra: any explicit cycling facility at all.
  const bikeInfra =
    isCycleway ||
    bikeOnPath ||
    bikeOnFoot ||
    isBikeRoad ||
    hasSeparatedTrack ||
    hasPaintedLane ||
    hasBusLane

  // Speed: from maxspeed tag if present, otherwise from road-class defaults.
  const speedKmh: number | null = (() => {
    if (maxspeed > 0) return maxspeed
    if (isCycleway || isPath || isFootway || isPedestrian) return null
    if (isLivingStreet) return 15
    if (isResidential) return 30
    switch (highway) {
      case 'unclassified': return 30
      // A tertiary is a minor connector, not an arterial. Guessing 50 here
      // put every untagged tertiary above the 2a ceiling, which silently
      // deleted whole painted-lane corridors from the overlay in cities that
      // don't tag maxspeed densely (SF: Folsom St, 17th St). 40 is the more
      // honest guess for an urban connector; secondary and above keep 50+
      // because those genuinely are arterials.
      case 'tertiary': return 40
      case 'secondary': return 50
      case 'primary': return 60
      case 'trunk': return 80
      default: return null
    }
  })()

  // Traffic density heuristic from road class. Null for car-free infra.
  const trafficDensity: TrafficDensity | null = (() => {
    if (isCycleway || isPath || isFootway || isPedestrian) return null
    if (isLivingStreet || isResidential) return 'low'
    switch (highway) {
      case 'unclassified': return 'low'
      case 'tertiary': return 'moderate'
      case 'secondary': return 'moderate'
      case 'primary': return 'high'
      case 'trunk': return 'high'
      default: return null
    }
  })()

  // Compute LTS tier using the same logic as the legacy computeLts but
  // staying consistent with Furth's criteria.
  const lts: LtsLevel = (() => {
    // Car-free infrastructure = LTS 1
    if (isCycleway || isPath || isPedestrian || isTrack) return 1
    if (bikeOnFoot) return 1
    if (isLivingStreet) return 1
    if (isBikeRoad) return 1

    // Separated cycle track: LTS 1 unless on a very fast road
    if (hasSeparatedTrack) {
      return maxspeed > 50 ? 2 : 1
    }

    // Residential with low speed and narrow = LTS 1 (Furth's "quiet mixed")
    if (isResidential && maxspeed <= QUIET_STREET_MAX_KMH && lanes <= 2) return 1

    // Painted bike lane
    if (hasPaintedLane) {
      if (maxspeed <= QUIET_STREET_MAX_KMH && lanes <= 2) return 2
      if (maxspeed <= 50 && lanes <= 3) return 2
      return 3
    }

    // Shared bus lane
    if (hasBusLane) return 2

    // No bike facility
    if (isResidential) {
      if (maxspeed <= 50 && lanes <= 3) return 2
      return 3
    }
    if (highway === 'tertiary') {
      if (maxspeed <= 30) return 2
      if (maxspeed <= 50) return 3
      return 4
    }
    if (highway === 'unclassified') {
      if (maxspeed <= 30) return 2
      return 3
    }
    if (['secondary', 'primary', 'trunk'].includes(highway)) return 4

    return 3 // default for unknown
  })()

  const pathLevel = derivePathLevel({ lts, carFree, bikePriority, bikeInfra, speedKmh })

  return { lts, pathLevel, carFree, bikePriority, bikeInfra, speedKmh, trafficDensity, surface, smoothness }
}

/**
 * Back-compat wrapper returning just the LTS tier. Use classifyEdge for
 * new code — it returns the full classification needed by mode rules.
 */
export function computeLts(tags: Record<string, string>): LtsLevel {
  return classifyEdge(tags).lts
}

export interface LtsBreakdown {
  lts1Pct: number
  lts2Pct: number
  lts3Pct: number
  lts4Pct: number
  worstLts: LtsLevel
  familySafetyScore: number // 0-100
}

/**
 * Compute LTS breakdown for a route from per-segment tags.
 * Uses distance-weighted percentages.
 */
export function computeLtsBreakdown(
  segments: Array<{ tags: Record<string, string>; lengthM: number }>,
): LtsBreakdown {
  if (segments.length === 0) {
    return { lts1Pct: 0, lts2Pct: 0, lts3Pct: 0, lts4Pct: 0, worstLts: 1, familySafetyScore: 0 }
  }

  let totalLength = 0
  const ltsTotals = { 1: 0, 2: 0, 3: 0, 4: 0 }
  let worstLts: LtsLevel = 1

  for (const seg of segments) {
    const lts = computeLts(seg.tags)
    ltsTotals[lts] += seg.lengthM
    totalLength += seg.lengthM
    if (lts > worstLts) worstLts = lts as LtsLevel
  }

  if (totalLength === 0) {
    return { lts1Pct: 0, lts2Pct: 0, lts3Pct: 0, lts4Pct: 0, worstLts: 1, familySafetyScore: 0 }
  }

  const breakdown: LtsBreakdown = {
    lts1Pct: ltsTotals[1] / totalLength,
    lts2Pct: ltsTotals[2] / totalLength,
    lts3Pct: ltsTotals[3] / totalLength,
    lts4Pct: ltsTotals[4] / totalLength,
    worstLts,
    familySafetyScore: 0,
  }

  breakdown.familySafetyScore = familySafetyScore(breakdown)
  return breakdown
}

/**
 * Family Safety Score: 0-100.
 * Heavily penalizes LTS 3-4 segments ("weakest link" principle).
 */
export function familySafetyScore(breakdown: LtsBreakdown): number {
  // Base score from LTS percentages
  const base =
    breakdown.lts1Pct * 100 +
    breakdown.lts2Pct * 70 +
    breakdown.lts3Pct * 30 +
    breakdown.lts4Pct * 0
  // Weakest-link penalty: any LTS 4 drops the score dramatically
  if (breakdown.lts4Pct > 0) return Math.min(Math.round(base), 40)
  if (breakdown.lts3Pct > 0.1) return Math.min(Math.round(base), 60)
  return Math.round(base)
}
