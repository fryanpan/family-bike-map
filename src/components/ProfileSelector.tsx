import type { ProfileMap } from '../utils/types'
import {
  KidStartingOut,
  KidConfident,
  KidTrafficSavvy,
  CarryingKid,
  Training,
} from './icons/modes'
import { useAdminSettings } from '../services/adminSettings'

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
}

export default function ProfileSelector({ profiles, selected, onSelect }: Props) {
  const settings = useAdminSettings()
  // Training mode is hidden unless the user opts in via Admin Tools →
  // Settings. If the current selected profile is training, keep it in
  // the list (the user must have enabled it previously, then disabled
  // the toggle — don't silently drop the active mode).
  const visibleEntries = Object.entries(profiles).filter(([key]) =>
    key !== 'training' || settings.showTrainingMode || key === selected,
  )
  return (
    <div className="profile-selector">
      <div className="profile-chips">
        {visibleEntries.map(([key, profile]) => (
          <button
            key={key}
            className={`profile-chip${selected === key ? ' selected' : ''}`}
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
      </div>
    </div>
  )
}
