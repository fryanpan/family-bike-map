import { useState } from 'react'
import { PROFILE_LEGEND } from '../utils/classify'
import { saveRules } from '../services/rules'
import type { RegionRules } from '../services/rules'

interface Props {
  rules: RegionRules
  region: string
  onRulesChange: (rules: RegionRules) => void
}

/** Collect all unique built-in legend items across profiles. */
function getBuiltInItems(): Array<{ name: string; icon: string }> {
  const seen = new Set<string>()
  const items: Array<{ name: string; icon: string }> = []
  for (const groups of Object.values(PROFILE_LEGEND)) {
    for (const group of groups) {
      for (const item of group.items) {
        if (!seen.has(item.name)) {
          seen.add(item.name)
          items.push({ name: item.name, icon: item.icon })
        }
      }
    }
  }
  return items
}

const BUILT_IN_ITEMS = getBuiltInItems()

export default function AuditLegendTab({ rules, region, onRulesChange }: Props) {
  const [newName, setNewName] = useState('')
  const [newIcon, setNewIcon] = useState('')
  const [editIndex, setEditIndex] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editIcon, setEditIcon] = useState('')

  async function handleAddItem() {
    const name = newName.trim()
    const icon = newIcon.trim()
    if (!name || !icon) return
    const updated: RegionRules = {
      ...rules,
      legendItems: [...rules.legendItems, { name, icon, description: '' }],
    }
    await saveRules(region, updated)
    onRulesChange(updated)
    setNewName('')
    setNewIcon('')
  }

  async function handleDeleteItem(index: number) {
    const updated: RegionRules = {
      ...rules,
      legendItems: rules.legendItems.filter((_, i) => i !== index),
    }
    await saveRules(region, updated)
    onRulesChange(updated)
  }

  function startEdit(index: number) {
    setEditIndex(index)
    setEditName(rules.legendItems[index].name)
    setEditIcon(rules.legendItems[index].icon)
  }

  async function saveEdit() {
    if (editIndex === null) return
    const updated: RegionRules = {
      ...rules,
      legendItems: rules.legendItems.map((item, i) =>
        i === editIndex ? { ...item, name: editName.trim(), icon: editIcon.trim() } : item,
      ),
    }
    await saveRules(region, updated)
    onRulesChange(updated)
    setEditIndex(null)
  }

  return (
    <div className="audit-legend-list">
      {/* Built-in items */}
      {BUILT_IN_ITEMS.map((item) => (
        <div key={item.name} className="audit-legend-item">
          <span className="audit-legend-icon">{item.icon}</span>
          <span className="audit-legend-name">{item.name}</span>
          <span className="audit-badge-builtin">Built-in</span>
        </div>
      ))}

      {/* Custom items from region rules */}
      {rules.legendItems.map((item, i) => (
        <div key={`custom-${i}`} className="audit-legend-item">
          {editIndex === i ? (
            <>
              <input
                className="audit-legend-edit-input"
                value={editIcon}
                onChange={(e) => setEditIcon(e.target.value)}
                style={{ width: '3em' }}
              />
              <input
                className="audit-legend-edit-input"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
              <button className="audit-rule-move-btn" onClick={saveEdit}>Save</button>
              <button className="audit-rule-move-btn" onClick={() => setEditIndex(null)}>Cancel</button>
            </>
          ) : (
            <>
              <span className="audit-legend-icon">{item.icon}</span>
              <span className="audit-legend-name">{item.name}</span>
              <span className="audit-badge-custom">Custom</span>
              <button className="audit-rule-move-btn" onClick={() => startEdit(i)} aria-label="Edit">
                &#x270E;
              </button>
              <button className="audit-rule-delete-btn" onClick={() => handleDeleteItem(i)} aria-label="Delete">
                &#x2715;
              </button>
            </>
          )}
        </div>
      ))}

      {/* Add new item form */}
      <div className="audit-legend-add">
        <input
          className="audit-legend-edit-input"
          placeholder="Icon"
          value={newIcon}
          onChange={(e) => setNewIcon(e.target.value)}
          style={{ width: '3em' }}
        />
        <input
          className="audit-legend-edit-input"
          placeholder="Name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <button
          className="audit-action-btn"
          onClick={handleAddItem}
          disabled={!newName.trim() || !newIcon.trim()}
        >
          Add
        </button>
      </div>
    </div>
  )
}
