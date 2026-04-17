/**
 * Layer 2 · region overlay.
 *
 * Adjusts a `LtsClassification` produced by Layer 1 (`classifyEdge`)
 * based on region-specific rules authored in each city's markdown
 * profile. Runs BEFORE `applyModeRule` (Layer 1.5) so mode decisions
 * see the city-corrected classification.
 *
 * Three rule kinds ship in the first version:
 *
 *   - `promote` — force an edge matching a name / ref / tag pattern
 *     up to LTS 1 + carFree (e.g. Landwehrkanal + Mauerweg in Berlin
 *     are the family spine).
 *   - `demote` — force an edge down (e.g. Oranienstraße has heavy bus
 *     traffic despite a painted lane; kid modes should walk it).
 *   - `zoneSurface` — force a surface override on everything inside a
 *     bounding rectangle (Berlin Altstadt's cobblestones are
 *     unreliably tagged in OSM; treat the whole area as cobblestone).
 *
 * Rules are plain data, hand-written in `overlay-rules.ts` per city,
 * and applied deterministically. No LLM in the loop.
 */

import type { LtsClassification } from '../../utils/lts'

export type RegionOverlayRule =
  | PromoteRule
  | DemoteRule
  | ZoneSurfaceRule

/** Boost an edge to a minimum LTS + car-free status. */
export interface PromoteRule {
  kind: 'promote'
  id: string                  // unique per region, for debugging
  // Match: any combination of name, ref, tag pattern
  match: EdgeMatch
  // Outcome: minimum guarantees
  toMinLts?: 1 | 2            // e.g. set lts=1 if currently higher
  setCarFree?: boolean        // force carFree=true
  setBikePriority?: boolean   // force bikePriority=true
}

/**
 * Push an edge down (e.g. painted lane with bad driver behavior).
 *
 * Note on composition: `demote` intentionally does NOT clear `carFree`.
 * If a future author needs to flip `carFree` from true back to false,
 * add a new `clearCarFree` flag here rather than assuming demote
 * undoes a prior promote. Today's three Berlin rules have disjoint
 * matchers so this doesn't arise, but rule-authoring conventions are
 * easier to keep than to recover.
 */
export interface DemoteRule {
  kind: 'demote'
  id: string
  match: EdgeMatch
  toMaxLts?: 2 | 3 | 4        // cap lts downward (higher number = worse)
  clearBikePriority?: boolean // force bikePriority=false
}

/** Apply a surface override to everything inside a bounding rectangle. */
export interface ZoneSurfaceRule {
  kind: 'zoneSurface'
  id: string
  // Bounding box: [south, west, north, east]. Any edge whose center
  // falls inside is treated as having this surface.
  bbox: [number, number, number, number]
  surface: string             // e.g. 'cobblestone', 'sett'
}

export interface EdgeMatch {
  // OSM name matches (case-insensitive substring). If supplied, at least
  // one must match the edge's `name` tag.
  nameContains?: string[]
  // OSM ref equality (case-sensitive), e.g. 'D11' for the Berliner Mauerweg.
  refEquals?: string[]
  // Any OSM tag key/value pair. All entries must match.
  tags?: Record<string, string>
}

/** A minimal region profile is just a list of overlay rules + meta. */
export interface RegionProfile {
  key: string                 // 'berlin', 'potsdam', ...
  displayName: string
  bbox: [number, number, number, number]  // [south, west, north, east]
  rules: RegionOverlayRule[]
}

// ── Helpers ──────────────────────────────────────────────────────────

function matchesEdge(match: EdgeMatch, tags: Record<string, string>): boolean {
  if (match.nameContains && match.nameContains.length > 0) {
    const name = (tags.name ?? '').toLowerCase()
    if (!match.nameContains.some((n) => name.includes(n.toLowerCase()))) {
      return false
    }
  }
  if (match.refEquals && match.refEquals.length > 0) {
    const ref = tags.ref ?? ''
    if (!match.refEquals.includes(ref)) return false
  }
  if (match.tags) {
    for (const [k, v] of Object.entries(match.tags)) {
      if (tags[k] !== v) return false
    }
  }
  return true
}

function insideBbox(
  lat: number, lng: number,
  [south, west, north, east]: [number, number, number, number],
): boolean {
  return lat >= south && lat <= north && lng >= west && lng <= east
}

// ── Apply ────────────────────────────────────────────────────────────

/**
 * Apply a region profile's overlay rules to a single edge's
 * classification. Returns a new classification (does not mutate).
 * If no rule matches, returns the input unchanged.
 *
 * `centerLat` / `centerLng` are the edge's midpoint — used only for
 * zone-surface rule matching; ignored by name/ref/tag rules.
 */
export function applyRegionOverlay(
  classification: LtsClassification,
  tags: Record<string, string>,
  profile: RegionProfile | null,
  centerLat?: number,
  centerLng?: number,
): LtsClassification {
  if (!profile) return classification
  let out = classification

  for (const rule of profile.rules) {
    switch (rule.kind) {
      case 'promote':
        if (matchesEdge(rule.match, tags)) {
          out = {
            ...out,
            lts: rule.toMinLts != null ? Math.min(out.lts, rule.toMinLts) as typeof out.lts : out.lts,
            carFree: rule.setCarFree != null ? rule.setCarFree || out.carFree : out.carFree,
            bikePriority: rule.setBikePriority != null ? rule.setBikePriority || out.bikePriority : out.bikePriority,
          }
        }
        break
      case 'demote':
        if (matchesEdge(rule.match, tags)) {
          out = {
            ...out,
            lts: rule.toMaxLts != null ? Math.max(out.lts, rule.toMaxLts) as typeof out.lts : out.lts,
            bikePriority: rule.clearBikePriority ? false : out.bikePriority,
          }
        }
        break
      case 'zoneSurface':
        if (centerLat != null && centerLng != null && insideBbox(centerLat, centerLng, rule.bbox)) {
          out = { ...out, surface: rule.surface }
        }
        break
    }
  }

  return out
}
