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

import type { LtsLevel, PathLevel } from '../utils/lts'

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

  // Path levels this mode accepts. Drives routing acceptance directly — the
  // LTS tier number alone is ambiguous (Furth treats quiet residential as
  // LTS 1 but our kid-first model treats it as 2b), so we key off pathLevel
  // which encodes both the Furth tier AND our a/b refinement. See
  // docs/product/plans/2026-04-21-path-categories-plan.md §3.
  acceptedLevels: Set<PathLevel>

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

  // Cost multiplier per PathLevel. Defaults to 1.0 for any level not listed.
  // Higher = more expensive per metre, biasing the router away from those
  // edges even when they're accepted. See docs/product/plans/2026-04-21-
  // path-categories-plan.md §3. Ordering of preferences comes from these
  // multipliers plus speed.
  levelMultipliers?: Partial<Record<PathLevel, number>>

  // Rough-surface cost multiplier (applied on top of levelMultiplier when
  // `surface ∈ ALWAYS_BAD_SURFACES` or smoothness is bad). Default 1.0.
  roughSurfaceMultiplier?: number

  // Path types this mode refuses outright even if the level is accepted.
  // Used by training to exclude "Elevated sidewalk path" (narrow, pedestrian-
  // heavy) while still accepting the rest of 1a. The values match
  // classifyOsmTagsToItem's output strings.
  rejectPathTypes?: Set<string>
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
    acceptedLevels: new Set<PathLevel>(['1a']),
    levelMultipliers: {},
    roughSurfaceMultiplier: 5.0,
    surfaceOk: PAVED_AND_SOFT,
    cobbleHandling: 'walking_pace',
    // ~5 km/h typical balance-bike or early pedaling pace
    ridingSpeedKmh: 5,
    slowSpeedKmh: 3,
    walkingSpeedKmh: 1,
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
    acceptedLevels: new Set<PathLevel>(['1a', '1b']),
    levelMultipliers: {},
    roughSurfaceMultiplier: 5.0,
    // PAVED_AND_SOFT is a superset of kid-starting-out's surface set so
    // toggling up in skill never rejects an edge that the stricter mode
    // was willing to ride.
    surfaceOk: PAVED_AND_SOFT,
    cobbleHandling: 'slow_pace',
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
    // Accepts 1a-2a outright plus 2b with a 1.5× cost multiplier. LTS 3+
    // rejected (bridge-walks if a sidewalk exists). The speed-cap/density
    // filters of the old ltsConditions model are now baked into classifyEdge
    // (painted lane on >30 km/h already classifies as pathLevel 3).
    acceptedLevels: new Set<PathLevel>(['1a', '1b', '2a', '2b']),
    levelMultipliers: { '2a': 1.5, '2b': 1.5 },
    roughSurfaceMultiplier: 5.0,
    surfaceOk: PAVED,
    cobbleHandling: 'reject',
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
    // Accepts 1a-2b; LTS 3 rejected (bridge-walks if sidewalk exists).
    // Most carrying-kid riders strongly prefer to avoid the higher-traffic
    // infra that LTS 3 captures, even when the router would otherwise take
    // it at a higher cost.
    acceptedLevels: new Set<PathLevel>(['1a', '1b', '2a', '2b']),
    levelMultipliers: { '2a': 1.2, '2b': 1.2 },
    roughSurfaceMultiplier: 5.0,
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
      'Smooth surfaces only; avoids cobbles, tram tracks, and unpaved sections. Rejects ' +
      'elevated sidewalk paths — they\'re narrow and pedestrian-heavy, which kills the ' +
      '30 km/h flow.',
    acceptedLevels: new Set<PathLevel>(['1a', '1b', '2a', '2b', '3']),
    // Nudge the router toward the bike-infra tiers (1a/1b/2a) and away
    // from busy painted-lane / no-infra streets (3) and unmarked
    // residentials (2b). Without these multipliers the cost function is
    // pure distance/speed and A* picks the SHORTEST path — which on a
    // 20km training ride means major roads with painted lanes beat a
    // 1.5km bike-path detour even when the detour is much nicer to
    // ride. (Joanna 2026-04-29, Rudower investigation; mirrors the
    // 1.5× nudge kid-traffic-savvy already uses for 2a/2b.)
    levelMultipliers: { '3': 1.5, '2b': 1.2 },
    roughSurfaceMultiplier: 5.0,
    rejectPathTypes: new Set(['Elevated sidewalk path']),
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
  | { accepted: true; speedKmh: number; isWalking: boolean; costMultiplier: number }
  | { accepted: false; reason: string }

// Rough surfaces trigger the 5× routing cost multiplier (same surfaces
// also hidden from the overlay — one list, both consumers). Mirrors
// UNRIDEABLE_SURFACES in classify.ts; duplicated here to avoid a
// cross-module import cycle (modes is consumed by classify via
// clientRouter).
//
// Per Bryan 2026-04-23: binary rough / not-rough, same for overlay and
// routing. Cobblestone + sett are in the rough list (carrying-kid +
// training-scale riders avoid them; kid-scale riders don't want them
// either). Dirt, earth, ground, fine_gravel, compacted, unpaved,
// paving_stones, wood, metal all NOT rough — well-maintained forest
// paths and paving-stone bike paths ride fine.
const ROUGH_SURFACES = new Set([
  'mud', 'sand', 'grass',
  'gravel', 'pebblestone', 'woodchips',
  'cobblestone', 'sett', 'unhewn_cobblestone', 'cobblestone:flattened',
])

// Smoothness tiers that trigger the same rough penalty regardless of
// surface. A bike path with surface=asphalt but smoothness=horrible
// (freeze-thaw cracks, root heaves, potholes) rides like gravel. Mirrors
// BAD_SMOOTHNESS in classify.ts — duplicated for the same cycle-avoidance
// reason as ROUGH_SURFACES. `intermediate` is intentionally excluded:
// cyclocross/hybrid-rideable is still fine for a kid on a bike path.
const BAD_SMOOTHNESS = new Set([
  'bad', 'very_bad', 'horrible', 'very_horrible', 'impassable',
])

/**
 * Check whether a mode accepts an edge, given its Layer 1 classification
 * (already adjusted by any Layer 2 region overlay).
 *
 * Acceptance keys off `classification.pathLevel` (our LTS 1a/1b/2a/2b/3/4
 * extension of Furth). Cost multipliers come from `rule.levelMultipliers`
 * and apply on top of the distance/speed base cost — e.g. kid-traffic-savvy
 * accepts LTS 2b (plain residentials) but marks them 1.5× more expensive
 * than LTS 2a (painted lane on quiet street), so the router prefers
 * bike-infra-present streets when one exists.
 *
 * Bridge-walk connectivity invariant (see .claude/rules/routing-changes.md):
 * when this returns `accepted: false`, the caller (clientRouter) still
 * adds the edge to the graph as a bridge-walk at `walkingSpeedKmh`. Hard
 * rejection is reserved for motorway/trunk and `sidewalk=no` elsewhere.
 */
/**
 * Return a ModeRule with runtime overrides (from adminSettings) merged in.
 * Any field not overridden falls back to the compile-time MODE_RULES
 * default. Used by the router so the Admin Tools → Settings → Routing
 * sliders take effect without rebuilding the app.
 */
export function getEffectiveModeRule(
  mode: RideMode,
  overrides?: {
    modeRouting?: Partial<Record<RideMode, {
      ridingSpeedKmh?: number
      slowSpeedKmh?: number
      walkingSpeedKmh?: number
      levelMultipliers?: Partial<Record<PathLevel, number>>
      roughSurfaceMultiplier?: number
    }>>
    roughSurfaceMultiplierGlobal?: number
  },
): ModeRule {
  const base = MODE_RULES[mode]
  const modeOverride = overrides?.modeRouting?.[mode]
  const globalRough = overrides?.roughSurfaceMultiplierGlobal

  if (!modeOverride && globalRough === undefined) return base

  return {
    ...base,
    ridingSpeedKmh: modeOverride?.ridingSpeedKmh ?? base.ridingSpeedKmh,
    slowSpeedKmh: modeOverride?.slowSpeedKmh ?? base.slowSpeedKmh,
    walkingSpeedKmh: modeOverride?.walkingSpeedKmh ?? base.walkingSpeedKmh,
    levelMultipliers: modeOverride?.levelMultipliers
      ? { ...(base.levelMultipliers ?? {}), ...modeOverride.levelMultipliers }
      : base.levelMultipliers,
    // Per-mode override wins if present; else global override if present; else mode default.
    roughSurfaceMultiplier:
      modeOverride?.roughSurfaceMultiplier
      ?? globalRough
      ?? base.roughSurfaceMultiplier,
  }
}

export function applyModeRule(
  rule: ModeRule,
  classification: LtsClassification,
  pathType?: string | null,
): ModeDecision {
  const { pathLevel, surface, smoothness } = classification

  // Level acceptance.
  if (!rule.acceptedLevels.has(pathLevel)) {
    return { accepted: false, reason: `path level ${pathLevel} not accepted` }
  }

  // Path-type exclusion (training rejects elevated sidewalk paths).
  if (pathType && rule.rejectPathTypes?.has(pathType)) {
    return { accepted: false, reason: `path type '${pathType}' rejected by mode` }
  }

  // Cobble special-case: even when the level is accepted, surface-strict
  // modes (carrying-kid, training) reject cobbles, and kid modes may
  // downshift to walking / slow pace.
  if (surface === 'cobblestone' || surface === 'sett' || surface === 'unhewn_cobblestone') {
    switch (rule.cobbleHandling) {
      case 'reject':
        return { accepted: false, reason: 'cobblestone surface' }
      case 'walking_pace':
        return {
          accepted: true,
          speedKmh: rule.walkingSpeedKmh,
          isWalking: true,
          costMultiplier: rule.roughSurfaceMultiplier ?? 1.0,
        }
      case 'slow_pace':
        return {
          accepted: true,
          speedKmh: rule.slowSpeedKmh,
          isWalking: false,
          costMultiplier: rule.roughSurfaceMultiplier ?? 1.0,
        }
    }
  }

  // Non-cobble surface check — still strict.
  if (rule.surfaceOk && surface && !rule.surfaceOk.has(surface)) {
    return { accepted: false, reason: `surface '${surface}' not in accepted set` }
  }

  const levelMul = rule.levelMultipliers?.[pathLevel] ?? 1.0
  const isRough =
    (surface != null && ROUGH_SURFACES.has(surface)) ||
    (smoothness != null && BAD_SMOOTHNESS.has(smoothness))
  const roughMul = isRough ? (rule.roughSurfaceMultiplier ?? 1.0) : 1.0
  const costMultiplier = levelMul * roughMul

  return {
    accepted: true,
    speedKmh: rule.ridingSpeedKmh,
    isWalking: false,
    costMultiplier,
  }
}
