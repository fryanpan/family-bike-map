import { useState, useEffect } from 'react'
import { parsePreferenceText } from '../data/preferenceParser'
import {
  loadPreferences, loadActivePreferenceName,
  saveActivePreferenceName, upsertPreference, deletePreference,
} from '../services/preferencesStore'
import type { RiderPreference } from '../data/preferences'

interface Props {
  onClose: () => void
  onChange: () => void  // fired whenever prefs/active change so parent can rebuild
}

function humanize(adj: RiderPreference['adjustments'][number]): string {
  switch (adj.kind) {
    case 'surface': {
      if (adj.tolerance === 'ok') return `${adj.surface} surface — ride normally`
      if (adj.tolerance === 'rough') return `${adj.surface} surface — avoid`
      return `${adj.surface} surface — reject`
    }
    case 'path-type':
      return `${adj.item} — ${adj.pref}`
  }
}

export default function PreferencesModal({ onClose, onChange }: Props) {
  const [prefs, setPrefs] = useState<RiderPreference[]>([])
  const [activeName, setActiveName] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editText, setEditText] = useState('')

  const refresh = () => {
    setPrefs(loadPreferences())
    setActiveName(loadActivePreferenceName())
  }

  useEffect(() => { refresh() }, [])

  const preview = parsePreferenceText(editText)

  const handleSave = () => {
    if (!editName.trim()) return
    upsertPreference(editName.trim(), editText)
    saveActivePreferenceName(editName.trim())
    refresh()
    onChange()
    setEditName(''); setEditText('')
  }

  const handleActivate = (name: string) => {
    saveActivePreferenceName(name)
    refresh()
    onChange()
  }

  const handleDeactivate = () => {
    saveActivePreferenceName(null)
    refresh()
    onChange()
  }

  const handleDelete = (name: string) => {
    if (!confirm(`Delete preference "${name}"?`)) return
    deletePreference(name)
    refresh()
    onChange()
  }

  const handleEdit = (p: RiderPreference) => {
    setEditName(p.name)
    setEditText(p.rawText)
  }

  return (
    <div className="prefs-backdrop" onClick={onClose}>
      <div className="prefs-modal" onClick={(e) => e.stopPropagation()}>
        <div className="prefs-header">
          <div className="prefs-title">Personal preferences</div>
          <button className="prefs-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="prefs-body">
          <p className="prefs-intro">
            Within your travel mode, describe your own tolerance in plain English.
            Examples: <em>“cobbles are fine”</em>, <em>“avoid painted bike lanes”</em>,
            <em> “prefer Fahrradstraße”</em>.
          </p>

          {prefs.length > 0 && (
            <div className="prefs-list">
              <div className="prefs-list-title">Saved</div>
              {prefs.map((p) => (
                <div key={p.name} className={`prefs-item${p.name === activeName ? ' prefs-item-active' : ''}`}>
                  <div className="prefs-item-row">
                    <span className="prefs-item-name">
                      {p.name}
                      {p.name === activeName && <span className="prefs-active-badge">active</span>}
                    </span>
                    <div className="prefs-item-actions">
                      {p.name === activeName ? (
                        <button className="prefs-btn" onClick={handleDeactivate}>Deactivate</button>
                      ) : (
                        <button className="prefs-btn prefs-btn-primary" onClick={() => handleActivate(p.name)}>Activate</button>
                      )}
                      <button className="prefs-btn" onClick={() => handleEdit(p)}>Edit</button>
                      <button className="prefs-btn" onClick={() => handleDelete(p.name)}>Delete</button>
                    </div>
                  </div>
                  <div className="prefs-item-text">"{p.rawText}"</div>
                  {p.adjustments.length > 0 && (
                    <ul className="prefs-item-adj">
                      {p.adjustments.map((a, i) => <li key={i}>{humanize(a)}</li>)}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="prefs-edit">
            <div className="prefs-edit-title">
              {editName && prefs.some((p) => p.name === editName)
                ? `Edit "${editName}"`
                : 'New preference'}
            </div>
            <input
              className="prefs-input"
              type="text"
              placeholder="Name (e.g. Bryan, Joanna, me)"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
            />
            <textarea
              className="prefs-textarea"
              placeholder='e.g. "cobbles are fine. prefer Fahrradstraße."'
              rows={3}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
            />

            {editText && (
              <div className="prefs-preview">
                <div className="prefs-preview-title">Understood:</div>
                {preview.adjustments.length === 0 ? (
                  <div className="prefs-preview-empty">Nothing yet.</div>
                ) : (
                  <ul className="prefs-item-adj">
                    {preview.adjustments.map((a, i) => <li key={i}>{humanize(a)}</li>)}
                  </ul>
                )}
                {preview.unparsed.length > 0 && (
                  <div className="prefs-unparsed">
                    <strong>Not yet understood:</strong>
                    <ul>{preview.unparsed.map((s, i) => <li key={i}>"{s}"</li>)}</ul>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="prefs-footer">
          <button className="prefs-btn" onClick={onClose}>Close</button>
          <button
            className="prefs-btn prefs-btn-primary"
            onClick={handleSave}
            disabled={!editName.trim()}
          >
            Save &amp; activate
          </button>
        </div>
      </div>
    </div>
  )
}
