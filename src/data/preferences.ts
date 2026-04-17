/**
 * Layer 3 · Personal preferences.
 *
 * Different riders have different tolerances within the same mode.
 * Joanna tolerates cobblestones on her road bike; Bryan hates them.
 * Both ride "training" mode. A preference encodes that difference —
 * the mode defines who you ride WITH, the preference defines how YOU
 * feel about edge cases.
 *
 * Pipeline:
 *   OSM tags
 *     → classifyEdge                      (Layer 1)
 *     → applyRegionOverlay                (Layer 2)
 *     → applyPreferenceAdjustments        (Layer 3) ← this module
 *     → applyModeRule                     (Layer 1.5 / role)
 *
 * Preferences run BEFORE the mode rule so they can flip
 * "rough surface" → "ok" in time for the mode rule to accept the
 * edge for riding.
 */

import type { LtsClassification } from '../utils/lts'

export type SurfaceTolerance = 'ok' | 'rough' | 'reject'

/**
 * A single typed adjustment. Rider preferences compile to zero or
 * more of these.
 */
export type PreferenceAdjustment =
  | { kind: 'surface'; surface: string; tolerance: SurfaceTolerance }
  | { kind: 'path-type'; item: string; pref: 'prefer' | 'neutral' | 'avoid' }

export interface RiderPreference {
  name: string                       // 'Bryan', 'Joanna', 'me'
  rawText: string                    // original English
  adjustments: PreferenceAdjustment[]
  unparsed: string[]                 // English phrases the parser didn't understand
  createdAt: number
  updatedAt: number
}

// ── Apply ────────────────────────────────────────────────────────────

/**
 * Apply a rider's preference adjustments to a Layer-2 classification.
 * Returns a new LtsClassification (pure, does not mutate).
 *
 * Surface tolerance flips:
 *   `ok` — blank the surface field so downstream mode rules treat it
 *          as the default (no roughness penalty). Equivalent to
 *          "I don't mind this".
 *   `rough` — set the surface to a canonical rough marker so mode
 *             rules that reject rough surfaces reject this edge.
 *   `reject` — reserved for future; currently treated as rough.
 *
 * path-type adjustments are consumed elsewhere — they nudge the
 * user's preferredItemNames set in App.tsx before routing, not
 * per-edge here.
 */
export function applyPreferenceAdjustments(
  classification: LtsClassification,
  pref: RiderPreference | null,
): LtsClassification {
  if (!pref || pref.adjustments.length === 0) return classification
  let out = classification

  for (const adj of pref.adjustments) {
    if (adj.kind !== 'surface') continue
    if (out.surface !== adj.surface) continue
    if (adj.tolerance === 'ok') {
      // Drop the surface so downstream "rough surface" classification
      // doesn't fire. The road itself remains whatever it was.
      out = { ...out, surface: null }
    }
    // For rough / reject the default surface handling in the mode
    // rule already takes care of it; no adjustment needed here.
  }

  return out
}
