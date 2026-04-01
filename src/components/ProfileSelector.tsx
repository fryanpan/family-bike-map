import type { ProfileMap } from '../utils/types'

interface Props {
  profiles: ProfileMap
  selected: string
  onSelect: (key: string) => void
  onEdit: (key: string) => void
}

export default function ProfileSelector({ profiles, selected, onSelect, onEdit }: Props) {
  return (
    <div className="profile-selector">
      <div className="profile-chips">
        {Object.entries(profiles).map(([key, profile]) => (
          <button
            key={key}
            className={`profile-chip${selected === key ? ' selected' : ''}`}
            onClick={() => onSelect(key)}
            title={profile.description}
          >
            <span className="profile-chip-emoji">{profile.emoji}</span>
            <span className="profile-chip-label">{profile.label}</span>
          </button>
        ))}
        <button
          className="profile-edit-icon"
          onClick={() => onEdit(selected)}
          title="Customise profile"
        >
          ⚙️
        </button>
      </div>
    </div>
  )
}
