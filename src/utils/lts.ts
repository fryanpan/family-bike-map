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
 * Compute LTS for a road segment from OSM tags.
 */
export function computeLts(tags: Record<string, string>): LtsLevel {
  const highway = tags.highway ?? ''
  const cycleway = tags.cycleway ?? tags['cycleway:right'] ?? tags['cycleway:both'] ?? ''
  const maxspeed = parseInt(tags.maxspeed ?? '0', 10)
  const lanes = parseInt(tags.lanes ?? '0', 10)

  // Car-free infrastructure = LTS 1
  if (['cycleway', 'path', 'track', 'pedestrian'].includes(highway)) return 1
  if (highway === 'footway' && (tags.bicycle === 'yes' || tags.bicycle === 'designated')) return 1
  if (highway === 'living_street') return 1
  if (tags.bicycle_road === 'yes' || tags.cyclestreet === 'yes') return 1

  // Separated cycle track = LTS 1-2
  if (cycleway === 'track' || cycleway === 'opposite_track') {
    return maxspeed > 50 ? 2 : 1
  }

  // Residential with low speed = LTS 1
  if (highway === 'residential' && (maxspeed <= 30 || maxspeed === 0) && lanes <= 2) return 1

  // Bike lane
  if (cycleway === 'lane' || cycleway === 'opposite_lane') {
    if (maxspeed <= 30 && lanes <= 2) return 2
    if (maxspeed <= 50 && lanes <= 3) return 2
    return 3
  }

  // Shared bus lane
  if (cycleway === 'share_busway') return 2

  // No bike facility
  if (highway === 'residential') {
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
