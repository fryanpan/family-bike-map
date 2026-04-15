import type { ProfileMap } from '../utils/types'
import {
  KidStartingOut,
  KidConfident,
  KidTrafficSavvy,
  CarryingKid,
  Training,
} from './icons/modes'

// Custom SVG icons for each ride mode. Landscape-aspect line-art bikes
// drawn to read as bikes at small icon sizes (~22px tall). Each icon
// uses a recognizable bike silhouette — two wheel circles plus a simple
// triangular frame — with rider context elements added on top:
//
//   kid-starting-out  — walking adult beside a small kid bike
//   kid-confident     — adult bike + kid bike riding together
//   kid-traffic-savvy — adult + kid bikes + dashed painted-lane stripe
//   carrying-kid      — adult bike + child trailer
//   training          — road bike + speed lines behind
//
// If a new mode is added without a matching icon the picker falls back
// to the profile's emoji character from profiles.ts.
const PROFILE_ICONS: Record<string, JSX.Element> = {
  'kid-starting-out':  <KidStartingOut />,
  'kid-confident':     <KidConfident />,
  'kid-traffic-savvy': <KidTrafficSavvy />,
  'carrying-kid':      <CarryingKid />,
  'training':          <Training />,
}

interface Props {
  profiles: ProfileMap
  selected: string
  onSelect: (key: string) => void
  isCustomTravelMode: boolean
}

export default function ProfileSelector({ profiles, selected, onSelect, isCustomTravelMode }: Props) {
  return (
    <div className="profile-selector">
      <div className="profile-chips">
        {Object.entries(profiles).map(([key, profile]) => (
          <button
            key={key}
            className={`profile-chip${selected === key && !isCustomTravelMode ? ' selected' : ''}`}
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
        {isCustomTravelMode && (
          <button
            className="profile-chip profile-chip-custom selected"
            title="Custom travel mode — you have edited the preferred path types"
            onClick={() => onSelect(selected)}
          >
            <span className="profile-chip-icon">
              <span className="profile-chip-emoji" style={{ fontSize: 14 }}>✎</span>
            </span>
          </button>
        )}
      </div>
    </div>
  )
}
