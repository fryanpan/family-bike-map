export default function ProfileSelector({ profiles, selected, onSelect, onEdit }) {
  return (
    <div className="profile-selector">
      <h3 className="section-title">Riding Profile</h3>
      <div className="profiles">
        {Object.entries(profiles).map(([key, profile]) => (
          <div key={key} className={`profile-card${selected === key ? ' selected' : ''}`}>
            <button className="profile-main" onClick={() => onSelect(key)}>
              <span className="profile-emoji">{profile.emoji}</span>
              <span className="profile-label">{profile.label}</span>
              <span className="profile-desc">{profile.description}</span>
            </button>
            <button
              className="profile-edit-btn"
              onClick={(e) => { e.stopPropagation(); onEdit(key) }}
              title="Customise this profile"
            >
              ⚙️
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
