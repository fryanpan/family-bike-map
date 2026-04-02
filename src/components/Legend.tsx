import React from 'react'
import { SAFETY, PROFILE_LEGEND } from '../utils/classify'
import type { LegendItem } from '../utils/classify'
import type { RouteSegment } from '../utils/types'

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

interface Props {
  segments: RouteSegment[] | null
  overlayOn: boolean
  profileKey: string
  preferredItemNames: Set<string>
  onMoveToPreferred: (name: string) => void
  onMoveToOther: (name: string) => void
}

export default function Legend({
  segments,
  overlayOn,
  profileKey,
  preferredItemNames,
  onMoveToPreferred,
  onMoveToOther,
}: Props) {
  const profileGroups = PROFILE_LEGEND[profileKey]
  const hasRoute = segments && segments.length > 0
  const showLegend = hasRoute || overlayOn

  if (!showLegend || !profileGroups) return null

  // All items for this profile, flattened and deduplicated by name
  const allItemsRaw = profileGroups.flatMap((g) => g.items)
  const seenNames = new Set<string>()
  const allItems = allItemsRaw.filter((item) => {
    if (seenNames.has(item.name)) return false
    seenNames.add(item.name)
    return true
  })

  // When showing route only (no overlay), limit to safety classes present in route
  const presentClasses = (hasRoute && !overlayOn)
    ? new Set(segments!.map((s) => s.safetyClass))
    : null

  const preferredItems = allItems.filter((item) => {
    if (presentClasses && !presentClasses.has(item.safetyClass)) return false
    return preferredItemNames.has(item.name)
  })

  const otherItems = allItems.filter((item) => {
    if (presentClasses && !presentClasses.has(item.safetyClass)) return false
    return !preferredItemNames.has(item.name)
  })

  if (preferredItems.length === 0 && otherItems.length === 0) return null

  function renderItem(item: LegendItem, inPreferred: boolean) {
    const itemColor = SAFETY[item.safetyClass]?.color ?? '#888'
    const iconNode = LEGEND_ICON_OVERRIDE[item.name] ?? (
      <span className="legend-icon">{item.icon}</span>
    )
    return (
      <div key={item.name} className="legend-item legend-item-row">
        <span className="legend-dot" style={{ background: itemColor }} />
        {iconNode}
        <span className="legend-text legend-text-flex">{item.name}</span>
        {inPreferred ? (
          <button
            className="legend-move-btn"
            onClick={() => onMoveToOther(item.name)}
            title="Move to Other Types"
            aria-label={`Move ${item.name} to Other Types`}
          >
            ↓
          </button>
        ) : (
          <button
            className="legend-move-btn legend-move-btn-up"
            onClick={() => onMoveToPreferred(item.name)}
            title="Move to Preferred"
            aria-label={`Move ${item.name} to Preferred Path Types`}
          >
            ↑
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="map-legend">
      {preferredItems.length > 0 && (
        <div className="legend-section">
          <div className="legend-section-header legend-section-header-preferred">
            Preferred
          </div>
          {preferredItems.map((item) => renderItem(item, true))}
        </div>
      )}
      {otherItems.length > 0 && (
        <div className={`legend-section${preferredItems.length > 0 ? ' legend-section-other' : ''}`}>
          <div className="legend-section-header legend-section-header-other">
            Other
          </div>
          {otherItems.map((item) => renderItem(item, false))}
        </div>
      )}
    </div>
  )
}
