/**
 * SafetyScore badge — displays the family safety score with color coding
 * and an optional "worst segment" callout.
 */

interface Props {
  score: number
  worstSegment?: { name: string; lts: number; lengthM: number } | null
}

function scoreColor(score: number): string {
  if (score >= 85) return '#10b981' // green
  if (score >= 70) return '#eab308' // yellow
  if (score >= 50) return '#f97316' // orange
  return '#ef4444'                  // red
}

function scoreLabel(score: number): string {
  if (score >= 85) return 'Great'
  if (score >= 70) return 'Good'
  if (score >= 50) return 'OK'
  return 'Poor'
}

export default function SafetyScore({ score, worstSegment }: Props) {
  const color = scoreColor(score)

  return (
    <div className="safety-score">
      <div className="safety-score-badge" style={{ backgroundColor: color }}>
        <span className="safety-score-value">{score}</span>
        <span className="safety-score-label">{scoreLabel(score)}</span>
      </div>
      {worstSegment && (
        <p className="safety-score-worst">
          Worst: {Math.round(worstSegment.lengthM)}m on {worstSegment.name} (LTS {worstSegment.lts})
        </p>
      )}
    </div>
  )
}
