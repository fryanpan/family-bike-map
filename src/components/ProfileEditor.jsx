/**
 * ProfileEditor — a modal that lets the user customise the Valhalla costing
 * parameters for any rider profile.
 */

const BIKE_TYPES = ['Hybrid', 'Road', 'Cross', 'Mountain']

function Slider({ label, hint, value, min, max, step = 0.05, onChange }) {
  return (
    <div className="pe-field">
      <div className="pe-field-header">
        <label className="pe-label">{label}</label>
        <span className="pe-value">{value.toFixed(2)}</span>
      </div>
      {hint && <p className="pe-hint">{hint}</p>}
      <input
        type="range"
        className="pe-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      <div className="pe-range-labels">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  )
}

export default function ProfileEditor({ profile, onChange, onClose }) {
  const opts = profile.costingOptions

  function set(key, value) {
    onChange({ ...profile, costingOptions: { ...opts, [key]: value } })
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">
            {profile.emoji} Customise — {profile.label}
          </span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="pe-field">
            <label className="pe-label">Profile name</label>
            <input
              className="pe-text-input"
              value={profile.label}
              onChange={(e) => onChange({ ...profile, label: e.target.value })}
            />
          </div>

          <div className="pe-field">
            <label className="pe-label">Bike type</label>
            <select
              className="pe-select"
              value={opts.bicycle_type ?? 'Hybrid'}
              onChange={(e) => set('bicycle_type', e.target.value)}
            >
              {BIKE_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          <Slider
            label="Cycling speed (km/h)"
            hint="Affects time estimates and route selection"
            value={opts.cycling_speed ?? 14}
            min={8}
            max={30}
            step={1}
            onChange={(v) => set('cycling_speed', v)}
          />

          <Slider
            label="Paths vs roads preference"
            hint="0 = always use paths/trails; 1 = prefer roads"
            value={opts.use_roads ?? 0.3}
            min={0}
            max={1}
            onChange={(v) => set('use_roads', v)}
          />

          <Slider
            label="Surface quality importance"
            hint="0 = tolerant of cobblestones/gravel; 1 = smooth surfaces only"
            value={opts.avoid_bad_surfaces ?? 0.5}
            min={0}
            max={1}
            onChange={(v) => set('avoid_bad_surfaces', v)}
          />

          <Slider
            label="Hill tolerance"
            hint="0 = flat routes only; 1 = hills are fine"
            value={opts.use_hills ?? 0.5}
            min={0}
            max={1}
            onChange={(v) => set('use_hills', v)}
          />

          <Slider
            label="Living streets preference"
            hint="0 = avoid woonerven; 1 = strongly prefer them"
            value={opts.use_living_streets ?? 0.5}
            min={0}
            max={1}
            onChange={(v) => set('use_living_streets', v)}
          />
        </div>

        <div className="modal-footer">
          <button className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
