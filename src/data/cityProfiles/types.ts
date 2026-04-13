// City profile types for the three-layer scoring architecture.
// Layer 1 is pure LTS (see src/utils/lts.ts).
// Layer 2 is this file — per-city prose + compiled JSON.
// Layer 3 is family preferences merged into the prose before compilation.
//
// The authoritative source for each city is a .md file with YAML frontmatter
// plus a short prose description. A compile step (profileCompiler.ts) turns
// the prose into the structured CompiledProfile below, which the router
// consumes deterministically.

export type RideMode =
  | 'kid-starting-out'   // car-free paths only, ≤3 km
  | 'kid-confident'      // LTS 1 + selective LTS 2, ≤8 km
  | 'kid-traffic-savvy'  // LTS 1-2 + careful LTS 3, ≤15 km
  | 'carrying-kid'       // adult pilots; surface-strict
  | 'training'           // adult fitness; LTS ≤3, secondary

// Official Geller labels, used in tooltips and research citations.
// See docs/research/family-safety/standards.md.
export const LTS_LABELS = {
  1: { short: 'Kid-friendly', official: 'Children' },
  2: { short: 'Most adults',  official: 'Interested but concerned' },
  3: { short: 'Confident',    official: 'Enthused and confident' },
  4: { short: 'Experienced',  official: 'Strong and fearless' },
} as const

export type LtsLevel = 1 | 2 | 3 | 4

// ── Raw city profile — the human authoring surface ────────────────────────

// Parsed from a .md file: YAML frontmatter + prose body.
export interface RawCityProfile {
  key: string                  // 'berlin', 'potsdam', ... — human-readable for v1
  displayName: string
  country: string              // ISO 3166-1 alpha-2
  bbox: [number, number, number, number]  // [minLon, minLat, maxLon, maxLat]
  modeShare: number            // 0–1, for safety-in-numbers multiplier
  prose: string                // short English description, ~40–80 words
  sources: string[]            // URL list for human review
  reviewed: boolean            // true = human-checked; false = auto-generated
}

// ── City context — the auto-derived structural signal ────────────────────

// Populated by a one-off OSM analysis per city (src/services/cityContext.ts).
// Fed to the Opus compiler alongside the prose so the model knows what tags
// actually exist in this city and doesn't invent ones that don't.
export interface CityContext {
  tagFrequencies: {
    highway: Record<string, number>
    cycleway: Record<string, number>
    surface: Record<string, number>
    bicycleRoadShare: number
    livingStreetShare: number
    maxspeed30Pct: number
  }
  localVocabulary: string[]              // e.g. ['Fahrradstraße', 'Mauerweg']
  knownCorridors: Array<{
    name: string
    kind: 'boost' | 'avoid'
    osmRelation?: number
    osmWays?: number[]
  }>
}

// ── Compiled profile — the router's consumable ────────────────────────────

// Output of the Opus compiler. Deterministic, cached, committed to repo.
export interface CompiledProfile {
  key: string
  schemaVersion: string
  promptVersion: string
  modelId: string               // pinned, e.g. 'claude-opus-4-6'
  compiledAt: string            // ISO timestamp

  // SiN multiplier derived from modeShare — applied at city level,
  // never per-edge. See docs/research/family-safety/safety-in-numbers.md.
  sinMultiplier: number

  // Tag patterns to boost or reject — the router's primary knob.
  boostTags: string[]           // e.g. ['bicycle_road=yes', 'cycleway=track']
  rejectTags: string[]          // e.g. ['cycleway=lane'] in Berlin

  // Surfaces considered bad in this city (on top of the global set).
  citySpecificBadSurfaces: string[]

  // Named corridors — post-processing overrides.
  boostCorridors: Array<{ name: string; osmWays?: number[]; osmRelation?: number }>
  avoidCorridors: Array<{ name: string; osmWays?: number[]; osmRelation?: number }>

  // Optional mobility caps — set by Layer 3 family prose.
  gradientCapPct?: number
  minPassableWidthM?: number
  maxContinuousDistanceKm?: number

  // Optional city-specific extra dimensions.
  extraDimensions?: {
    aqi?: boolean                // CDMX
    winterPlowed?: string[]      // Montreal
    timeOfWeek?: Array<{ corridor: string; whenOpen: string }>  // Bogotá, Paris
  }

  // Human-facing summary shown under "What we're looking for".
  // One paragraph, second person, no jargon, no tag names.
  userSummary: string
}
