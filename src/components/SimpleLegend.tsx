import { useState, useEffect } from 'react'
import { PROFILE_LEGEND, PREFERRED_COLOR, OTHER_COLOR } from '../utils/classify'
import { MODE_RULES } from '../data/modes'
import type { RideMode } from '../data/modes'
import type { PathLevel } from '../utils/lts'

// Compact inline legend — replaces the old preferred/other two-column panel.
// Shows only the preferred tiers for the selected travel mode, as line-style
// swatches.

type DisplayTier = {
  level: PathLevel
  title: string
  description: string
  dashArray: string | undefined
  color: string
}

// Tier colors — three distinct greens so the legend + distribution plot can
// visually separate Car-free from Bikeway-minimal-cars from Bike-route-
// beside-cars, even though they all count as "preferred."
const COLOR_1A = '#059669' // deepest green — car-free
const COLOR_1B = '#10b981' // mid green    — bike-priority shared
const COLOR_2A = '#6ee7b7' // lightest     — painted lane on quiet street

// Display titles that match the spec in docs/product/plans/2026-04-21-path-categories-plan.md.
export const SIMPLE_TIERS: DisplayTier[] = [
  { level: '1a', title: 'Car-free',                  description: 'Bike paths, shared foot paths, elevated sidewalk paths', dashArray: undefined, color: COLOR_1A },
  { level: '1b', title: 'Bikeway with minimal cars', description: 'Fahrradstraße, living streets, bike boulevards',         dashArray: '12 6',    color: COLOR_1B },
  { level: '2a', title: 'Bike route beside cars',    description: 'Painted bike lane, shared bus lane on quiet streets',     dashArray: '2 4',     color: COLOR_2A },
]

/** Leaflet dash-array string for a given path level, or undefined (solid). */
export function dashArrayForLevel(level: PathLevel): string | undefined {
  switch (level) {
    case '1a': return undefined
    case '1b': return '12 6'
    case '2a': return '2 4'
    default:   return undefined // 2b/3/4 use solid orange
  }
}

/**
 * Tier-specific color for a given level. Preferred tiers (1a/1b/2a) each get
 * a distinct green shade so the distribution plot and map can visually
 * separate them. Non-preferred tiers return OTHER_COLOR (orange).
 *
 * `isPreferred` is accepted for call-site clarity but no longer influences
 * the choice — a level's visual identity is stable across modes.
 */
export function colorForLevel(level: PathLevel, _isPreferred = true): string {
  switch (level) {
    case '1a': return COLOR_1A
    case '1b': return COLOR_1B
    case '2a': return COLOR_2A
    default:   return OTHER_COLOR
  }
}

// Re-export so consumers can keep the fallback color without re-importing classify.
export { PREFERRED_COLOR, OTHER_COLOR }

function LineSwatch({ dashArray, color }: { dashArray?: string; color: string }) {
  return (
    <svg width="38" height="10" viewBox="0 0 38 10" style={{ flexShrink: 0 }}>
      <line
        x1="2" y1="5" x2="36" y2="5"
        stroke={color}
        strokeWidth="3"
        strokeDasharray={dashArray}
        strokeLinecap="round"
      />
    </svg>
  )
}

interface Props {
  profileKey: string
}

export default function SimpleLegend({ profileKey }: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return localStorage.getItem('simpleLegend.collapsed') === 'true'
  })

  useEffect(() => {
    localStorage.setItem('simpleLegend.collapsed', String(collapsed))
  }, [collapsed])

  // Only show the tiers that are preferred for this mode. kid-starting-out
  // gets just LTS 1a; kid-confident picks up 1b; kid-traffic-savvy adds 2a;
  // etc. Tiers the mode doesn't treat as preferred are omitted entirely —
  // they still appear on the map (colored orange) and in the route-summary
  // distribution plot, but not here.
  const groups = PROFILE_LEGEND[profileKey] ?? []
  const preferredLevels = new Set<PathLevel>()
  for (const group of groups) {
    if (!group.defaultPreferred) continue
    for (const item of group.items) preferredLevels.add(item.level)
  }

  const visibleTiers = SIMPLE_TIERS.filter((t) => preferredLevels.has(t.level))
  if (visibleTiers.length === 0) return null

  const modeLabel = MODE_RULES[profileKey as RideMode]?.label ?? profileKey

  if (collapsed) {
    return (
      <button
        className="simple-legend-toggle simple-legend-collapsed"
        onClick={() => setCollapsed(false)}
        title="Show legend"
        aria-label="Show legend"
      >
        ?
      </button>
    )
  }

  return (
    <div className="simple-legend">
      <div className="simple-legend-header">
        <span className="simple-legend-title">Preferred paths for {modeLabel}</span>
        <button
          className="simple-legend-dismiss"
          onClick={() => setCollapsed(true)}
          title="Hide legend"
          aria-label="Hide legend"
        >
          ×
        </button>
      </div>
      {visibleTiers.map((tier) => (
        <div key={tier.level} className="simple-legend-row">
          <LineSwatch dashArray={tier.dashArray} color={tier.color} />
          <div className="simple-legend-text">
            <div className="simple-legend-tier-title">{tier.title}</div>
            <div className="simple-legend-tier-desc">{tier.description}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
