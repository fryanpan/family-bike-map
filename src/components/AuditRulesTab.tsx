import { saveRules } from '../services/rules'
import type { RegionRules, ClassificationRule } from '../services/rules'

interface Props {
  rules: RegionRules
  region: string
  onRulesChange: (rules: RegionRules) => void
}

export default function AuditRulesTab({ rules, region, onRulesChange }: Props) {
  async function handleDelete(index: number) {
    const updated: RegionRules = {
      ...rules,
      rules: rules.rules.filter((_, i) => i !== index),
    }
    await saveRules(region, updated)
    onRulesChange(updated)
  }

  async function handleMove(index: number, direction: -1 | 1) {
    const newIndex = index + direction
    if (newIndex < 0 || newIndex >= rules.rules.length) return
    const reordered = [...rules.rules]
    const [moved] = reordered.splice(index, 1)
    reordered.splice(newIndex, 0, moved)
    const updated: RegionRules = { ...rules, rules: reordered }
    await saveRules(region, updated)
    onRulesChange(updated)
  }

  if (rules.rules.length === 0) {
    return <p className="audit-empty">No classification rules for this region yet.</p>
  }

  return (
    <div className="audit-rules-list">
      {rules.rules.map((rule: ClassificationRule, i: number) => (
        <div key={i} className="audit-rule-card">
          <div className="audit-rule-match">
            {Object.entries(rule.match).map(([k, v]) => (
              <code key={k} className="audit-rule-tag">{k}={v}</code>
            ))}
          </div>
          <div className="audit-rule-classification">{rule.classification}</div>
          <div className="audit-rule-modes">
            {Object.entries(rule.travelModes).map(([mode, pref]) => (
              <span
                key={mode}
                className={`audit-rule-badge ${pref === 'preferred' ? 'audit-badge-preferred' : 'audit-badge-other'}`}
              >
                {mode}: {pref}
              </span>
            ))}
          </div>
          <div className="audit-rule-actions">
            <button
              className="audit-rule-move-btn"
              onClick={() => handleMove(i, -1)}
              disabled={i === 0}
              aria-label="Move up"
            >
              &#x25B2;
            </button>
            <button
              className="audit-rule-move-btn"
              onClick={() => handleMove(i, 1)}
              disabled={i === rules.rules.length - 1}
              aria-label="Move down"
            >
              &#x25BC;
            </button>
            <button
              className="audit-rule-delete-btn"
              onClick={() => handleDelete(i)}
              aria-label="Delete rule"
            >
              &#x2715;
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
