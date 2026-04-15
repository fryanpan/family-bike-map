import type { ProfileMap } from '../utils/types'
import {
  KidStartingOut,
  KidConfident,
  KidTrafficSavvy,
  CarryingKid,
  Training,
} from './icons/modes'

// Map mode keys to custom SVG icon components. The icons are single-color
// (currentColor) React components in src/components/icons/modes/. Each
// depicts the rider situation at a glance: adult walking beside a kid bike
// for "starting out", kid + adult both biking for "confident", kid in a
// painted lane next to a car for "traffic-savvy", adult bike with child
// seat for "carrying kid", and a sport rider with speed lines for training.
//
// Custom icons are defined for every current ride mode; if a new mode is
// added without a matching icon, the picker falls back to the profile's
// emoji character from profiles.ts.
const iconProps = {
  width: 52,
  height: 36,
  strokeWidth: 1.6,
  'aria-hidden': true as const,
}

const PROFILE_ICONS: Record<string, JSX.Element> = {
  'kid-starting-out':  <KidStartingOut  {...iconProps} />,
  'kid-confident':     <KidConfident    {...iconProps} />,
  'kid-traffic-savvy': <KidTrafficSavvy {...iconProps} />,
  'carrying-kid':      <CarryingKid     {...iconProps} />,
  'training':          <Training        {...iconProps} />,
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
            <span className="profile-chip-label">{profile.label}</span>
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
            <span className="profile-chip-label">Custom</span>
          </button>
        )}
      </div>
    </div>
  )
}
