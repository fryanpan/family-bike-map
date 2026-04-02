import React from 'react'
import type { ProfileMap } from '../utils/types'

// --- Mode-specific SVG icons ---

function ToddlerModeIcon() {
  // Adult bike (left) + child bike (right, smaller) — 8px gap between bikes
  return (
    <svg width="40" height="22" viewBox="0 0 62 32" fill="none" aria-hidden="true">
      {/* Adult bike */}
      <circle cx="9" cy="22" r="8" stroke="currentColor" strokeWidth="1.6"/>
      <circle cx="27" cy="22" r="8" stroke="currentColor" strokeWidth="1.6"/>
      {/* Rear triangle: rear hub → BB → seat top → rear hub */}
      <path d="M9 22 L17 22 L14 12 Z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round"/>
      {/* Top tube + fork: seat top → head → front hub */}
      <path d="M14 12 L22 12 L27 22" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round"/>
      {/* Down tube: head → BB */}
      <line x1="22" y1="12" x2="17" y2="22" stroke="currentColor" strokeWidth="1.5"/>
      {/* Seat */}
      <line x1="11" y1="12" x2="17" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      {/* Handlebar */}
      <line x1="20" y1="10" x2="24" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>

      {/* Child bike (smaller, offset right with extra gap) */}
      <circle cx="44" cy="25" r="5.5" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="56" cy="25" r="5.5" stroke="currentColor" strokeWidth="1.4"/>
      {/* Rear triangle */}
      <path d="M44 25 L50 25 L48 17.5 Z" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round"/>
      {/* Top tube + fork */}
      <path d="M48 17.5 L53.5 17.5 L56 25" stroke="currentColor" strokeWidth="1.3" fill="none" strokeLinejoin="round"/>
      {/* Down tube */}
      <line x1="53.5" y1="17.5" x2="50" y2="25" stroke="currentColor" strokeWidth="1.3"/>
      {/* Seat */}
      <line x1="46" y1="17.5" x2="50" y2="17.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
      {/* Handlebar */}
      <line x1="51.5" y1="15.5" x2="55" y2="15.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
    </svg>
  )
}

function TrailerModeIcon() {
  // Bike facing right with trailer attached to rear
  return (
    <svg width="40" height="22" viewBox="0 0 62 32" fill="none" aria-hidden="true">
      {/* Bike (right portion, rear wheel left, front wheel right) */}
      <circle cx="34" cy="22" r="8" stroke="currentColor" strokeWidth="1.6"/>
      <circle cx="52" cy="22" r="8" stroke="currentColor" strokeWidth="1.6"/>
      {/* Rear triangle */}
      <path d="M34 22 L42 22 L39 12 Z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round"/>
      {/* Top tube + fork */}
      <path d="M39 12 L47 12 L52 22" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round"/>
      {/* Down tube */}
      <line x1="47" y1="12" x2="42" y2="22" stroke="currentColor" strokeWidth="1.5"/>
      {/* Seat */}
      <line x1="36" y1="12" x2="42" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      {/* Handlebar */}
      <line x1="45" y1="10" x2="49" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>

      {/* Hitch arm: rear axle → trailer coupling */}
      <line x1="34" y1="22" x2="22" y2="20" stroke="currentColor" strokeWidth="1.4"/>

      {/* Trailer body */}
      <rect x="5" y="13" width="17" height="12" rx="2" stroke="currentColor" strokeWidth="1.4"/>
      {/* Trailer wheels */}
      <circle cx="9.5" cy="25" r="4" stroke="currentColor" strokeWidth="1.4"/>
      <circle cx="17.5" cy="25" r="4" stroke="currentColor" strokeWidth="1.4"/>
    </svg>
  )
}

function TrainingModeIcon() {
  // Road bike with speed lines behind it
  return (
    <svg width="36" height="22" viewBox="0 0 56 32" fill="none" aria-hidden="true">
      {/* Speed lines (left, behind bike) */}
      <line x1="2" y1="13" x2="14" y2="13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.75"/>
      <line x1="4" y1="18" x2="14" y2="18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.5"/>
      <line x1="6" y1="23" x2="14" y2="23" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.3"/>

      {/* Road bike — slightly more aggressive frame geometry (lower bars, longer reach) */}
      <circle cx="27" cy="22" r="8" stroke="currentColor" strokeWidth="1.6"/>
      <circle cx="46" cy="22" r="8" stroke="currentColor" strokeWidth="1.6"/>
      {/* Rear triangle */}
      <path d="M27 22 L35 22 L32 12 Z" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round"/>
      {/* Top tube (angled, road geometry) + fork */}
      <path d="M32 12 L41 13.5 L46 22" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinejoin="round"/>
      {/* Down tube */}
      <line x1="41" y1="13.5" x2="35" y2="22" stroke="currentColor" strokeWidth="1.5"/>
      {/* Seat (road bike: seat post upright) */}
      <line x1="29.5" y1="12" x2="35" y2="12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      {/* Drop handlebars (lower than seat, road style) */}
      <line x1="40" y1="16" x2="44" y2="16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  )
}

const PROFILE_ICONS: Record<string, React.ReactNode> = {
  toddler:  <ToddlerModeIcon />,
  trailer:  <TrailerModeIcon />,
  training: <TrainingModeIcon />,
}

interface Props {
  profiles: ProfileMap
  selected: string
  onSelect: (key: string) => void
  onEdit: (key: string) => void
  isCustomMode: boolean
}

export default function ProfileSelector({ profiles, selected, onSelect, onEdit, isCustomMode }: Props) {
  return (
    <div className="profile-selector">
      <div className="profile-chips">
        {Object.entries(profiles).map(([key, profile]) => (
          <button
            key={key}
            className={`profile-chip${selected === key && !isCustomMode ? ' selected' : ''}`}
            onClick={() => onSelect(key)}
            title={`${profile.label}\n${profile.description}`}
          >
            <span className="profile-chip-icon">
              {PROFILE_ICONS[key] ?? (
                <span className="profile-chip-emoji">{profile.emoji}</span>
              )}
            </span>
          </button>
        ))}
        {isCustomMode && (
          <button
            className="profile-chip profile-chip-custom selected"
            title="Custom mode — you have edited the preferred path types"
            onClick={() => onSelect(selected)}
          >
            <span className="profile-chip-icon">
              <span className="profile-chip-emoji" style={{ fontSize: 14 }}>✎ Custom</span>
            </span>
          </button>
        )}
        <button
          className="profile-edit-icon"
          onClick={() => onEdit(selected)}
          title="Customise profile"
        >
          ✏️
        </button>
      </div>
    </div>
  )
}
