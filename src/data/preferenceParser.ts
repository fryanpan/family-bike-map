/**
 * English → PreferenceAdjustment parser.
 *
 * Deterministic, rule-based. Handles a small canon of common phrasings
 * for MVP. Anything it can't understand goes into the "unparsed" list
 * so the UI can show the user what was actually understood. Future:
 * wire an LLM path behind a feature flag.
 *
 * Input is lowercased line-by-line. Each line can produce 0 or 1
 * adjustments. Multiple surfaces / path-types per line are not
 * supported.
 */

import type { PreferenceAdjustment } from './preferences'

interface Canon {
  // Regex over a lowercased line. Must include "\bsubject\b"-style
  // tokens so partial-word matches don't trigger.
  match: RegExp
  build: (match: RegExpMatchArray) => PreferenceAdjustment | null
}

// Surfaces the parser recognizes. Maps common English names to OSM surface
// tag values.
const SURFACE_ALIASES: Record<string, string> = {
  'cobble': 'cobblestone',
  'cobbles': 'cobblestone',
  'cobblestone': 'cobblestone',
  'cobblestones': 'cobblestone',
  'sett': 'sett',
  'setts': 'sett',
  'paving': 'paving_stones',
  'paving stone': 'paving_stones',
  'paving stones': 'paving_stones',
  'gravel': 'gravel',
  'fine gravel': 'fine_gravel',
  'dirt': 'dirt',
  'mud': 'mud',
}

const surfaceTokens = Object.keys(SURFACE_ALIASES).join('|')

// Path-type names the parser recognizes. These correspond to
// PROFILE_LEGEND item names.
const PATH_TYPES: Record<string, string> = {
  'fahrradstrasse': 'Fahrradstrasse',
  'fahrradstraße': 'Fahrradstrasse',
  'bike path': 'Bike path',
  'cycle path': 'Bike path',
  'cycleway': 'Bike path',
  'radweg': 'Bike path',
  'shared foot path': 'Shared foot path',
  'foot path': 'Shared foot path',
  'park path': 'Shared foot path',
  'painted bike lane': 'Painted bike lane',
  'painted lane': 'Painted bike lane',
  'bike lane': 'Painted bike lane',
  'living street': 'Living street',
  'bus lane': 'Shared bus lane',
}

// Allow optional trailing 's' for plural forms ("bike paths", "cobbles").
// Longest-first so "cycle path" wins over "path".
const pathTokens = Object.keys(PATH_TYPES)
  .sort((a, b) => b.length - a.length)
  .map((t) => `${t}s?`)
  .join('|')

/** Normalize plural→singular before looking up in PATH_TYPES. */
function lookupPathType(phrase: string): string | undefined {
  const lower = phrase.toLowerCase()
  if (PATH_TYPES[lower]) return PATH_TYPES[lower]
  if (lower.endsWith('s')) {
    const singular = lower.slice(0, -1)
    if (PATH_TYPES[singular]) return PATH_TYPES[singular]
  }
  return undefined
}

// Canonical patterns. Order matters: earlier patterns win.
const CANON: Canon[] = [
  // "cobbles are fine" / "cobblestones are ok" / "paving stones are fine"
  {
    match: new RegExp(`\\b(${surfaceTokens})\\b.*\\b(are |is )?(fine|ok|okay|no problem)\\b`),
    build: (m) => {
      const surface = SURFACE_ALIASES[m[1]]
      return surface ? { kind: 'surface', surface, tolerance: 'ok' } : null
    },
  },
  // "i don't mind cobbles" / "don't mind paving stones"
  {
    match: new RegExp(`\\b(don'?t|do not) mind\\b.*\\b(${surfaceTokens})\\b`),
    build: (m) => {
      const surface = SURFACE_ALIASES[m[2]]
      return surface ? { kind: 'surface', surface, tolerance: 'ok' } : null
    },
  },
  // "i hate cobblestones" / "avoid cobbles" / "skip paving stones"
  {
    match: new RegExp(`\\b(hate|avoid|skip|no)\\b.*\\b(${surfaceTokens})\\b`),
    build: (m) => {
      const surface = SURFACE_ALIASES[m[2]]
      return surface ? { kind: 'surface', surface, tolerance: 'rough' } : null
    },
  },
  // "prefer Fahrradstraße" / "prefer bike paths" / "love cycleways"
  {
    match: new RegExp(`\\b(prefer|love|like)\\b.*\\b(${pathTokens})\\b`),
    build: (m) => {
      const item = lookupPathType(m[2])
      return item ? { kind: 'path-type', item, pref: 'prefer' } : null
    },
  },
  // "avoid painted bike lanes" / "hate painted lanes" / "skip bus lane"
  {
    match: new RegExp(`\\b(avoid|hate|skip|no)\\b.*\\b(${pathTokens})\\b`),
    build: (m) => {
      const item = lookupPathType(m[2])
      return item ? { kind: 'path-type', item, pref: 'avoid' } : null
    },
  },
]

export interface ParseResult {
  adjustments: PreferenceAdjustment[]
  unparsed: string[]
}

/**
 * Parse a free-text English block into typed preference adjustments.
 *
 * Splits on newlines and sentences ('.', ';', ',' at end of thought)
 * and tries each fragment against the canon. Fragments that match
 * nothing go into `unparsed`.
 */
export function parsePreferenceText(raw: string): ParseResult {
  const adjustments: PreferenceAdjustment[] = []
  const unparsed: string[] = []
  const frags = raw
    .split(/[\n;.]+|,\s*(?=[a-z])/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  for (const frag of frags) {
    const lower = frag.toLowerCase()
    let matched = false
    for (const rule of CANON) {
      const m = lower.match(rule.match)
      if (m) {
        const adj = rule.build(m)
        if (adj) {
          adjustments.push(adj)
          matched = true
          break
        }
      }
    }
    if (!matched) unparsed.push(frag)
  }

  return { adjustments, unparsed }
}
