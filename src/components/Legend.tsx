import React from 'react'
import { SAFETY, PROFILE_LEGEND } from '../utils/classify'
import type { LegendLevel } from '../utils/classify'
import type { RouteSegment, SafetyClass } from '../utils/types'

// Official Fahrradstrasse sign (Zeichen 244.1): blue circle with white bicycle
function FahrradstrasseSign() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" style={{ flexShrink: 0 }}>
      <circle cx="8" cy="8" r="8" fill="#1565C0"/>
      <circle cx="4.5" cy="11" r="2.2" fill="none" stroke="white" strokeWidth="1.2"/>
      <circle cx="11.5" cy="11" r="2.2" fill="none" stroke="white" strokeWidth="1.2"/>
      <path d="M4.5 11 L7 7.5 L11.5 11" fill="none" stroke="white" strokeWidth="1.1"/>
      <path d="M7 7.5 L9 7.5" stroke="white" strokeWidth="1.1"/>
      <path d="M9 7.5 L11.5 6.5" stroke="white" strokeWidth="1.1"/>
      <path d="M7 7.5 L6.5 6.8 L8.5 6.8" fill="none" stroke="white" strokeWidth="1"/>
      <circle cx="8.5" cy="6" r="1" fill="white"/>
    </svg>
  )
}

// Separated bike path icon: elevated bike lane beside car lane
function SeparatedPathSign() {
  return (
    <svg width="22" height="14" viewBox="0 0 22 14" style={{ flexShrink: 0 }}>
      <rect x="0" y="0" width="22" height="6.5" rx="1" fill="#dbeafe"/>
      <rect x="0" y="8" width="22" height="6" rx="1" fill="#f1f5f9"/>
      <rect x="0" y="6" width="22" height="2" fill="#94a3b8"/>
      <circle cx="5" cy="3.2" r="1.8" fill="none" stroke="#0ea5e9" strokeWidth="1"/>
      <circle cx="10" cy="3.2" r="1.8" fill="none" stroke="#0ea5e9" strokeWidth="1"/>
      <path d="M5 3.2 L7 1.2 L10 3.2" fill="none" stroke="#0ea5e9" strokeWidth="1"/>
      <path d="M8 1.8 L10 1.2" stroke="#0ea5e9" strokeWidth="1"/>
      <rect x="13" y="8.8" width="7" height="3.5" rx="1" fill="#94a3b8"/>
      <rect x="14" y="8" width="5" height="2.5" rx="0.5" fill="#cbd5e1"/>
    </svg>
  )
}

const LEGEND_ICON_OVERRIDE: Record<string, React.ReactNode> = {
  'Fahrradstrasse':                      <FahrradstrasseSign />,
  'Separated bike track':                <SeparatedPathSign />,
  'Separated bike track (narrow)':       <SeparatedPathSign />,
  'Separated bike track (slow)':         <SeparatedPathSign />,
}

function CheckMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" style={{ display: 'block' }}>
      <polyline points="1.5,5 4,7.5 8.5,2" fill="none" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

interface Props {
  segments: RouteSegment[] | null
  overlayOn: boolean
  profileKey: string
  hiddenSafetyClasses: Set<SafetyClass>
  onToggleSafetyClass: (cls: SafetyClass) => void
  onToggleGroup: (level: LegendLevel) => void
}

export default function Legend({
  segments,
  overlayOn,
  profileKey,
  hiddenSafetyClasses,
  onToggleSafetyClass,
  onToggleGroup,
}: Props) {
  const profileGroups = PROFILE_LEGEND[profileKey]
  const hasRoute = segments && segments.length > 0
  const showLegend = hasRoute || overlayOn

  if (!showLegend) return null

  // When showing route only (no overlay), limit to levels that appear in segments
  const presentClasses = (hasRoute && !overlayOn)
    ? new Set(segments!.map((s) => s.safetyClass))
    : null

  const levelAppears = (level: string): boolean => {
    if (!presentClasses) return true
    const levelToClasses: Record<string, string[]> = {
      good: ['great', 'good'],
      ok:   ['ok'],
      bad:  ['avoid'],
    }
    return (levelToClasses[level] ?? []).some((c) => (presentClasses as Set<string>).has(c))
  }

  if (profileGroups) {
    const visibleGroups = profileGroups.filter((g) => levelAppears(g.level))
    if (!visibleGroups.length) return null

    return (
      <div className="map-legend">
        {visibleGroups.map((group) => {
          const groupSafetyClasses = [...new Set(group.items.map((i) => i.safetyClass))]
          const allHidden = groupSafetyClasses.every((c) => hiddenSafetyClasses.has(c))
          const groupChecked = !allHidden

          return (
            <div key={group.level} className={`legend-group${allHidden ? ' legend-group-hidden' : ''}`}>
              <button
                className="legend-group-toggle"
                onClick={() => onToggleGroup(group.level)}
                title={`${groupChecked ? 'Hide' : 'Show'} ${group.label} paths`}
              >
                <span className={`legend-toggle-box${groupChecked ? ' checked' : ''}`}>
                  {groupChecked && <CheckMark />}
                </span>
                <span className="legend-level-label">{group.label}</span>
              </button>
              {group.items.map((item) => {
                const itemColor = SAFETY[item.safetyClass]?.color ?? '#888'
                const itemChecked = !hiddenSafetyClasses.has(item.safetyClass)
                const iconNode = LEGEND_ICON_OVERRIDE[item.name] ?? (
                  <span className="legend-icon">{item.icon}</span>
                )
                return (
                  <button
                    key={item.name}
                    className={`legend-item legend-item-toggle${itemChecked ? '' : ' legend-item-off'}`}
                    onClick={() => onToggleSafetyClass(item.safetyClass)}
                    title={`${itemChecked ? 'Hide' : 'Show'} ${item.name}`}
                  >
                    <span className={`legend-toggle-box legend-toggle-box-sm${itemChecked ? ' checked' : ''}`}>
                      {itemChecked && <CheckMark />}
                    </span>
                    <span className="legend-dot" style={{ background: itemColor }} />
                    {iconNode}
                    <span className="legend-text">{item.name}</span>
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    )
  }

  // Fallback for unknown profiles
  const classes = segments
    ? [...new Set(segments.map((s) => s.safetyClass))]
    : (Object.keys(SAFETY) as (keyof typeof SAFETY)[])
  return (
    <div className="map-legend">
      {classes.map((cls) => {
        const s = SAFETY[cls]
        return (
          <div key={cls} className="legend-item">
            <span className="legend-dot" style={{ background: s.color }} />
            <span className="legend-text">{s.icon} {s.label}</span>
          </div>
        )
      })}
    </div>
  )
}
