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

  // Stricter-than-Furth-LTS-1 constraint. When true, the edge must be
  // physically car-free (carFree === true). Bike-prioritized shared surfaces
  // (Fahrradstraßen, living streets, SF Slow Streets, Dutch fietsstraten) are
  // NOT accepted even though they're engineered to give bikes priority,
  // because cars are still legally allowed on them and a kid just learning to
  // ride can't reliably handle even an occasional car interaction. Accepted
  // infrastructure:
  //
  //   - cycleway, car-free path, pedestrianised zone, curb-separated cycle
  //     track on a sidewalk, forest/farm track.
  //
  // Excluded (all have some car presence):
  //   - Fahrradstraßen, living streets, SF Slow Streets
  //   - Ordinary quiet residential streets
  //
  // Real-world caveat: rejected edges still enter the graph as bridge-walks
  // at walkingSpeedKmh (see applyModeRule + isBridgeWalkable in clientRouter),
  // so the graph stays connected. A kid-starting-out rider walks their bike
  // across any Fahrradstraße segment rather than riding it.
  requireCarFree?: boolean

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

// Slow kid modes additionally tolerate softer natural surfaces (wooden
// boardwalks, fine gravel park paths). Both kid-starting-out and
// kid-confident use this set — the invariant is that as kid skill
// increases, the accepted-for-riding surface set grows monotonically,
// so toggling from starting-out → confident can never turn a rideable
// surface into a walking bridge.
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
      'Needs physically car-free infrastructure only: cycleways, park paths, curb-separated ' +
      'cycle tracks, pedestrianised zones, forest/farm tracks. Even Fahrradstraßen and ' +
      'living streets are excluded because cars are still legally present and this kid ' +
      'can\'t be trusted to handle even an occasional car interaction. Bridge-walks short ' +
      'non-car-free gaps (Fahrradstraße, residential, crosswalk) on the sidewalk at walking ' +
      'pace. Can walk across short cobblestone stretches at walking pace.',
    ltsAccept: [1],
    requireCarFree: true,
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
    // No requireCarFree — accepts full Furth LTS 1 including ordinary quiet residential + bikePriority.
    // Uses PAVED_AND_SOFT (superset of kid-starting-out's surface set) so
    // toggling up in skill never rejects an edge that the stricter mode
    // was willing to ride.
    surfaceOk: PAVED_AND_SOFT,
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
      'speeds ≤50 km/h, and moderate traffic density (never busy arterials). ' +
      'Avoids cobblestones — the kid is going 15+ km/h now and cobbles are jarring at speed.',
    ltsAccept: [1, 2],
    ltsConditions: {
      // Furth's LTS 2 painted-lane criterion allows up to ~48 km/h (30 mph);
      // we use 50 to match Berlin/European 50 km/h defaults. Earlier drafts
      // used 30 but that broke routing in Berlin because many tertiary
      // streets don't have maxspeed tagged, so their inferred speed falls
      // back to the 50 km/h road-class default and fails a 30 km/h cap
      // even when the actual LTS logic (which uses raw maxspeed=0) classified
      // them as LTS 2. The 50 km/h cap keeps primary/trunk arterials out
      // (they infer 60/80) while admitting typical painted-lane tertiary/
      // secondary streets the kid can actually handle at age 8+.
      2: {
        requireBikeInfra: true,
        maxSpeedKmh: 50,
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

  // Car-free-only constraint: edge must be physically car-free.
  // See ModeRule.requireCarFree for the full rationale.
  if (rule.requireCarFree && !carFree) {
    return { accepted: false, reason: 'requires physically car-free infrastructure' }
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

  // Speed selection for accepted LTS 1 edges.
  //
  // Fahrradstraßen, living streets, and SF-style Slow Streets are shared
  // surfaces in the strict sense (cars are present) but are ENGINEERED to
  // give bikes priority — drivers are guests, speed limits are low, and
  // enforcement culture treats cyclists as having right-of-way. The rider
  // should ride them at full cruising speed, not cautiously, because the
  // whole point of the infrastructure is that the occasional car yields.
  //
  // Ordinary quiet residential (Furth LTS 1 mixed traffic: ≤30 km/h, low
  // volume, 2-lane, no bike-priority designation) is different: cars are
  // not legally required to yield, just statistically rare. The rider
  // stays alert and rides at a cautious pace there.
  //
  // So the slowdown only applies when the edge is neither car-free NOR
  // bike-prioritized. Earlier drafts applied it to ALL shared-surface
  // LTS 1, which made Fahrradstraßen ride 2× slower than cycleways and
  // broke the routing intent ("prefer Fahrradstraßen" → "detour onto any
  // cycleway to avoid Fahrradstraßen").
  const needsCaution = lts === 1 && !carFree && !classification.bikePriority
  const speedKmh = needsCaution ? rule.slowSpeedKmh : rule.ridingSpeedKmh

  return { accepted: true, speedKmh, isWalking: false }
}

function rankTraffic(t: TrafficDensity): number {
  return t === 'low' ? 1 : t === 'moderate' ? 2 : 3
}
