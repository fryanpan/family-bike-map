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
 * Path Level — our extension of Furth's LTS framework with a/b sub-tiers
 * splitting LTS 1 and LTS 2 by bike-infra presence.
 *
 *   1a = physically car-free (cycleway, bike path, curb-separated track)
 *   1b = bike-prioritized shared surface (Fahrradstraße, living street,
 *        bike boulevard / SF Slow Street pattern)
 *   2a = bike infra on a quiet street (painted lane or bus lane on
 *        maxspeed ≤ 30 km/h)
 *   2b = quiet residential without bike infra OR LTS 2 without infra
 *   3  = LTS 3 (busy residentials, painted lane on 31–50 km/h, tertiary)
 *   4  = LTS 4 (primary, secondary ≥50 km/h without infra, trunk)
 *
 * See docs/product/plans/2026-04-21-path-categories-plan.md.
 */
export type PathLevel = '1a' | '1b' | '2a' | '2b' | '3' | '4'

export const PATH_LEVELS: readonly PathLevel[] = ['1a', '1b', '2a', '2b', '3', '4']

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
 *   - Painted lane on >30 km/h demotes to '3' — Furth allows up to ~48 km/h;
 *     we tighten so '2a' genuinely represents "quiet street with bike infra."
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
  // 2a requires bike infra AND quiet (maxspeed ≤ 30 or unset).
  if (bikeInfra && (speedKmh == null || speedKmh <= 30)) return '2a'
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
  const maxspeed = parseInt(tags.maxspeed ?? '0', 10)
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
      case 'tertiary': return 50
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
    if (isResidential && (maxspeed <= 30 || maxspeed === 0) && lanes <= 2) return 1

    // Painted bike lane
    if (hasPaintedLane) {
      if (maxspeed <= 30 && lanes <= 2) return 2
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
