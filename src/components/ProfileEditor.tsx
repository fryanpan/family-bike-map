import { SAFETY, PROFILE_LEGEND } from '../utils/classify'
import type { RiderProfile, BicycleType, BicycleCostingOptions } from '../utils/types'

const BIKE_TYPES: BicycleType[] = ['Hybrid', 'Road', 'Cross', 'Mountain']

interface SliderProps {
  label: string
  hint?: string
  value: number
  min: number
  max: number
  step?: number
  minLabel?: string
  maxLabel?: string
  onChange: (v: number) => void
}

function Slider({ label, hint, value, min, max, step = 0.05, minLabel, maxLabel, onChange }: SliderProps) {
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
        <span>{minLabel ?? String(min)}</span>
        <span>{maxLabel ?? String(max)}</span>
      </div>
    </div>
  )
}

interface Props {
  profileKey?: string
  profile: RiderProfile
  onChange: (updated: RiderProfile) => void
  onClose: () => void
}

const LEVEL_COLORS: Record<string, string> = {
  great: '#15803d',
  ok:    '#92400e',
  bad:   '#991b1b',
}

const LEVEL_BG: Record<string, string> = {
  great: '#f0fdf4',
  ok:    '#fffbeb',
  bad:   '#fef2f2',
}

export default function ProfileEditor({ profileKey, profile, onChange, onClose }: Props) {
  const opts: BicycleCostingOptions = profile.costingOptions
  const profileGroups = profileKey ? PROFILE_LEGEND[profileKey] : null

  function set(key: keyof BicycleCostingOptions, value: number | string) {
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
            label="Speed (km/h)"
            hint="Affects time estimates and route selection"
            value={opts.cycling_speed ?? 14}
            min={8}
            max={30}
            step={1}
            minLabel="Slow (8 km/h)"
            maxLabel="Fast (30 km/h)"
            onChange={(v) => set('cycling_speed', v)}
          />

          <Slider
            label="Road bike lanes & streets"
            hint="How much to route via on-road bike lanes and quiet streets vs dedicated paths"
            value={opts.use_roads ?? 0.3}
            min={0}
            max={1}
            minLabel="Paths only"
            maxLabel="Roads OK"
            onChange={(v) => set('use_roads', v)}
          />

          <Slider
            label="Surface quality"
            hint="Tolerance for cobblestones, gravel, and rough surfaces"
            value={opts.avoid_bad_surfaces ?? 0.5}
            min={0}
            max={1}
            minLabel="Tolerant"
            maxLabel="Smooth only"
            onChange={(v) => set('avoid_bad_surfaces', v)}
          />

          <Slider
            label="Hill tolerance"
            hint="How much to prefer flat routes"
            value={opts.use_hills ?? 0.5}
            min={0}
            max={1}
            minLabel="Flat only"
            maxLabel="Hills OK"
            onChange={(v) => set('use_hills', v)}
          />

          <Slider
            label="Fahrradstrasse & living streets"
            hint="How strongly to prefer Fahrradstrasse and Wohnstraßen"
            value={opts.use_living_streets ?? 0.5}
            min={0}
            max={1}
            minLabel="Avoid"
            maxLabel="Strongly prefer"
            onChange={(v) => set('use_living_streets', v)}
          />

          {profileGroups && (
            <div className="pe-field">
              <label className="pe-label">Path preferences for this profile</label>
              <p className="pe-hint">How each path type is classified when displaying routes</p>
              <div className="pe-pref-section">
                {profileGroups.map((group) => (
                  <div key={group.level} className="pe-pref-group">
                    <span
                      className="pe-pref-badge"
                      style={{ color: LEVEL_COLORS[group.level], background: LEVEL_BG[group.level] }}
                    >
                      {group.label}
                    </span>
                    <div className="pe-pref-items">
                      {group.items.map((item) => (
                        <div key={item.name} className="pe-pref-item">
                          <span
                            className="pe-pref-dot"
                            style={{ background: SAFETY[item.safetyClass]?.color }}
                          />
                          <span className="pe-pref-name">{item.icon} {item.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
