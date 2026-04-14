// Layer 1.5: travel mode rules.
//
// Single source of truth for what each ride mode ACCEPTS as safe.
// Mode rules are mode-specific and city-agnostic — they describe a rider's
// tolerance profile using Level of Traffic Stress (LTS) bands plus explicit
// extra constraints like physical car separation and surface handling.
//
// Region-specific adjustments live in the Layer 2 city profile overlay
// (src/data/cityProfiles/), which applies tier adjustments and surface flags
// in a mode-neutral way. The router joins Layer 1 (global LTS classification),
// Layer 2 (region overlay), and Layer 1.5 (these mode rules) at route time.
//
// LTS framework anchored to Peter Furth's canonical criteria:
//   https://peterfurth.sites.northeastern.edu/level-of-traffic-stress/
// See docs/research/family-safety/standards.md for the full framework and
// docs/product/plans/2026-04-13-three-layer-scoring-plan.md for the Option C
// architecture decision.

import type { LtsLevel } from '../utils/lts'

export type RideMode =
  | 'kid-starting-out'
  | 'kid-confident'
  | 'kid-traffic-savvy'
  | 'carrying-kid'
  | 'training'

export type TrafficDensity = 'low' | 'moderate' | 'high'

export interface LtsCondition {
  // Require explicit bike infrastructure (lane, track, path, or bicycle_road)
  requireBikeInfra?: boolean
  // Cap the motor vehicle operating speed (km/h)
  maxSpeedKmh?: number
  // Cap the traffic density (low < moderate < high)
  maxTrafficDensity?: TrafficDensity
}

/**
 * How this mode handles cobblestones and sett paving.
 *   reject        — edge is excluded entirely
 *   walking_pace  — edge accepted but rider dismounts and walks at walkingSpeedKmh
 *   slow_pace     — edge accepted but rider slows to slowSpeedKmh (e.g. a kid
 *                   learning to ride can roll over cobbles slowly while mounted)
 */
export type CobbleHandling = 'reject' | 'walking_pace' | 'slow_pace'

export interface ModeRule {
  key: RideMode
  label: string
  description: string

  // LTS bands this mode accepts. Non-contiguous profiles are expressible.
  ltsAccept: LtsLevel[]

  // Stricter-than-Furth-LTS-1 constraint. When true, the edge must offer
  // "minimal risk of bad car interactions" — either physically car-free,
  // OR legally/structurally engineered to give bikes priority so that cars,
  // when present, yield by default. Accepted infrastructure:
  //
  //   - Physically car-free (carFree === true):
  //       cycleway, car-free path, pedestrianised zone, curb-separated cycle
  //       track on a sidewalk, forest/farm track.
  //   - Bike-prioritized shared surface (bikePriority === true):
  //       Fahrradstraßen (bicycle_road=yes), Dutch fietsstraten
  //       (cyclestreet=yes), living streets (legally ≤ walking pace for cars),
  //       SF Slow Streets and equivalents (residential with motor_vehicle=
  //       destination), etc.
  //
  // Excluded (even though Furth's LTS 1 would include them):
  //   - Ordinary quiet residential streets with no bike-priority designation.
  //
  // Real-world caveat: some bike-priority streets have persistent bad-driver
  // problems (e.g. SF's Noe Slow Street). Layer 2 city profiles may demote
  // specific named corridors to compensate.
  requireLowCarRisk?: boolean

  // Extra conditions that must hold for specific LTS tiers above 1.
  // Example: kid-traffic-savvy accepts LTS 2 only when bike infra is present,
  // speeds are ≤30 km/h, and traffic density is moderate or lower.
  ltsConditions?: Partial<Record<LtsLevel, LtsCondition>>

  // Surface tolerance. Any surface string not in this set is rejected,
  // EXCEPT cobblestone/sett which are handled separately below.
  // If null, surface is not checked (all surfaces acceptable).
  surfaceOk: Set<string> | null

  // How cobblestone / sett paving is handled. See CobbleHandling above.
  cobbleHandling: CobbleHandling

  // Typical cruising speed (km/h) on accepted infrastructure.
  ridingSpeedKmh: number
  // Slower speed (km/h) for rough-but-allowed sections (e.g. slow_pace cobbles,
  // shared with pedestrians, adjacent to cars on a Fahrradstraße).
  slowSpeedKmh: number
  // Walking speed (km/h) for bridge-walk fallbacks — dismount to cross a short
  // unavoidable gap by walking the bike on the sidewalk.
  walkingSpeedKmh: number

  // Optional gradient cap (percent grade). Route is rejected if any segment
  // exceeds this. Useful for non-e-assist modes on hilly cities.
  gradientCapPct?: number
}

// Surfaces universally OK for paved riding across all modes.
const PAVED = new Set(['asphalt', 'concrete', 'paving_stones', 'compacted'])

// Kid modes additionally tolerate softer natural surfaces at low speed.
const PAVED_AND_SOFT = new Set([...PAVED, 'wood', 'fine_gravel'])

// Training and carrying-kid are strictest — no paving stones (too bumpy).
const SMOOTH_ONLY = new Set(['asphalt', 'concrete', 'compacted'])

/**
 * The five ride modes, mapped to LTS bands and rider-specific constraints.
 *
 * LTS mapping summary (from user direction, anchored to Furth):
 *   kid-starting-out  — LTS 1 with minimal car risk (car-free OR bike-priority)
 *   kid-confident     — LTS 1 in full (includes ≤30 km/h low-density residential)
 *   kid-traffic-savvy — LTS 1 + LTS 2 (LTS 2 conditional: bike infra, ≤30, moderate)
 *   carrying-kid      — LTS 1–3, no cobbles
 *   training          — LTS 1–3, smooth surfaces, adult pace
 *
 * Deliberately does NOT carry a maxContinuousKm cap — stamina is orthogonal
 * to safety, and families will judge distance themselves. The router optimizes
 * safety and time; the user picks the destination.
 */
export const MODE_RULES: Record<RideMode, ModeRule> = {
  'kid-starting-out': {
    key: 'kid-starting-out',
    label: 'Kid starting out',
    description:
      'Kid has some bike control — can stop to avoid danger — but judgment is unreliable. ' +
      'Needs infrastructure with minimal risk of bad car interactions: either physically ' +
      'car-free (cycleways, park paths, curb-separated tracks, pedestrianised zones) or ' +
      'bike-prioritized (Fahrradstraßen, Dutch fietsstraten, living streets, SF-style Slow ' +
      'Streets where cars are restricted to local access). On bike-priority infrastructure ' +
      'cars share the surface but in practice slow down and yield — some corridors with ' +
      'persistent bad-driver problems may be demoted via Layer 2 city profiles. ' +
      'Excludes ordinary residential streets that are merely quiet but not engineered for ' +
      'bike priority. Can walk across short cobblestone stretches at walking pace.',
    ltsAccept: [1],
    requireLowCarRisk: true,
    surfaceOk: PAVED_AND_SOFT,
    cobbleHandling: 'walking_pace',
    // ~5 km/h typical balance-bike or early pedaling pace
    ridingSpeedKmh: 5,
    slowSpeedKmh: 3,
    walkingSpeedKmh: 2,
  },

  'kid-confident': {
    key: 'kid-confident',
    label: 'Kid confident',
    description:
      'Good bike control, basic road awareness. Can stay right in a lane or on a path under ' +
      'parental command. Parent still needs time to correct mistakes — no split-second ' +
      'life-and-death decisions. Accepts full Furth LTS 1: physically separated tracks plus ' +
      'quiet residential streets (≤30 km/h, low volume) even without bike-priority ' +
      'designation. Can ride short cobblestone stretches slowly as a learning opportunity.',
    ltsAccept: [1],
    // No requireLowCarRisk — accepts full Furth LTS 1 including ordinary quiet residential.
    surfaceOk: PAVED,
    cobbleHandling: 'slow_pace',
    // Kid-pedal bikes often max out around 10 km/h — kid has to move their legs fast
    ridingSpeedKmh: 10,
    slowSpeedKmh: 5,
    walkingSpeedKmh: 2,
  },

  'kid-traffic-savvy': {
    key: 'kid-traffic-savvy',
    label: 'Kid traffic-savvy',
    description:
      'Reads traffic, handles intersections and traffic signals, can ride a painted bike ' +
      'lane in moderate traffic without panicking. Still a kid — never LTS 3 or higher. ' +
      'Accepts Furth LTS 1 in full, plus LTS 2 conditionally: must have bike infrastructure, ' +
      'speeds ≤30 km/h, and moderate traffic density (never busy arterials). ' +
      'Avoids cobblestones — the kid is going 15+ km/h now and cobbles are jarring at speed.',
    ltsAccept: [1, 2],
    ltsConditions: {
      2: {
        requireBikeInfra: true,
        maxSpeedKmh: 30,
        maxTrafficDensity: 'moderate',
      },
    },
    surfaceOk: PAVED,
    cobbleHandling: 'reject',
    // ~16 km/h typical cruising on a small kid bike in traffic-aware mode
    ridingSpeedKmh: 16,
    slowSpeedKmh: 10,
    walkingSpeedKmh: 3,
  },

  'carrying-kid': {
    key: 'carrying-kid',
    label: 'Carrying kid',
    description:
      'Adult pilots a child seat, trailer, or cargo bike (longtail or front-load). ' +
      'Adult has full judgment. Accepts LTS 1–3. Surface-strict: no cobblestones or sett ' +
      'paving — a trailer or bakfiets on cobble is painful for the passenger. ' +
      'Hardware variants (trailer / longtail / bucket / child seat) collapse into one ' +
      'mode; fine-grained preferences (width, e-assist, gradient) are expressed in Layer 3.',
    ltsAccept: [1, 2, 3],
    surfaceOk: SMOOTH_ONLY,
    cobbleHandling: 'reject',
    ridingSpeedKmh: 20,
    slowSpeedKmh: 12,
    walkingSpeedKmh: 4,
  },

  training: {
    key: 'training',
    label: 'Fast training',
    description:
      'Adult fitness ride. Prioritizes 30 km/h flow. Still safety-conscious — accepts ' +
      'LTS 1–3 but avoids crowded greenways where pedestrian traffic slows riding. ' +
      'Smooth surfaces only; avoids cobbles, tram tracks, and unpaved sections.',
    ltsAccept: [1, 2, 3],
    surfaceOk: SMOOTH_ONLY,
    cobbleHandling: 'reject',
    ridingSpeedKmh: 30,
    slowSpeedKmh: 20,
    walkingSpeedKmh: 5,
  },
}

// ── Acceptance check ────────────────────────────────────────────────────────

import type { LtsClassification } from '../utils/lts'

/**
 * Decision returned by the mode-rule acceptance check.
 *   accepted — edge is usable; use `speedKmh` for cost computation
 *   rejected — edge is excluded from the routing graph entirely
 */
export type ModeDecision =
  | { accepted: true; speedKmh: number; isWalking: boolean }
  | { accepted: false; reason: string }

/**
 * Check whether a mode accepts an edge, given its Layer 1 classification
 * (already adjusted by any Layer 2 region overlay).
 *
 * Returns a decision with the appropriate speed, or a rejection with a reason.
 * Reasons are human-readable to help debug routing surprises.
 */
export function applyModeRule(
  rule: ModeRule,
  classification: LtsClassification,
): ModeDecision {
  const { lts, carFree, bikeInfra, speedKmh: roadSpeedKmh, trafficDensity, surface } = classification

  // LTS band check
  if (!rule.ltsAccept.includes(lts)) {
    return { accepted: false, reason: `LTS ${lts} not in accepted bands ${rule.ltsAccept.join(',')}` }
  }

  // Low-car-risk constraint: edge must be car-free OR bike-prioritized.
  // See ModeRule.requireLowCarRisk for the full rationale.
  if (rule.requireLowCarRisk && !carFree && !classification.bikePriority) {
    return { accepted: false, reason: 'requires car-free or bike-prioritized infrastructure' }
  }

  // Per-tier conditions (only checked for tiers > 1)
  const condition = rule.ltsConditions?.[lts]
  if (condition) {
    if (condition.requireBikeInfra && !bikeInfra) {
      return { accepted: false, reason: `LTS ${lts} requires bike infrastructure` }
    }
    if (condition.maxSpeedKmh != null && roadSpeedKmh != null && roadSpeedKmh > condition.maxSpeedKmh) {
      return { accepted: false, reason: `road speed ${roadSpeedKmh} km/h exceeds cap ${condition.maxSpeedKmh}` }
    }
    if (condition.maxTrafficDensity && trafficDensity && rankTraffic(trafficDensity) > rankTraffic(condition.maxTrafficDensity)) {
      return { accepted: false, reason: `traffic density '${trafficDensity}' exceeds cap '${condition.maxTrafficDensity}'` }
    }
  }

  // Surface check — cobbles get special handling
  if (surface === 'cobblestone' || surface === 'sett' || surface === 'unhewn_cobblestone') {
    switch (rule.cobbleHandling) {
      case 'reject':
        return { accepted: false, reason: 'cobblestone surface' }
      case 'walking_pace':
        return { accepted: true, speedKmh: rule.walkingSpeedKmh, isWalking: true }
      case 'slow_pace':
        return { accepted: true, speedKmh: rule.slowSpeedKmh, isWalking: false }
    }
  }

  // Non-cobble surface check
  if (rule.surfaceOk && surface && !rule.surfaceOk.has(surface)) {
    return { accepted: false, reason: `surface '${surface}' not in accepted set` }
  }

  // Accepted at normal riding speed. On shared-surface bike-priority infra
  // (Fahrradstraßen, living streets, Slow Streets) the rider is still
  // cautious around the occasional car, so we drop to slowSpeedKmh. True
  // car-free edges ride at the full ridingSpeedKmh.
  const sharedSurface = lts === 1 && !carFree
  const speedKmh = sharedSurface ? rule.slowSpeedKmh : rule.ridingSpeedKmh

  return { accepted: true, speedKmh, isWalking: false }
}

function rankTraffic(t: TrafficDensity): number {
  return t === 'low' ? 1 : t === 'moderate' ? 2 : 3
}
