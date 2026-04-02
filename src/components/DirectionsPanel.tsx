import { useState, useEffect } from 'react'
import { formatDistance, formatDuration } from '../services/routing'
import { computeRouteQuality } from '../utils/classify'
import type { Route, ValhallaManeuver } from '../utils/types'

// Valhalla maneuver type → direction icon
const ICONS: Record<number, string> = {
  1: '▶',  // start
  4: '🏁', // destination
  7: '↑',  // becomes
  8: '↑',  // continue
  9: '↗',  // slight right
  10: '→', // right
  11: '↱', // sharp right
  12: '↩', // u-turn right
  13: '↪', // u-turn left
  14: '↲', // sharp left
  15: '←', // left
  16: '↖', // slight left
  17: '↑', // ramp straight
  18: '↗', // ramp right
  19: '↖', // ramp left
  26: '🔵', // roundabout enter
  27: '↑',  // roundabout exit
}

function icon(type: number): string {
  return ICONS[type] ?? '•'
}

function speak(text: string): void {
  if (!('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  const utt = new SpeechSynthesisUtterance(text)
  utt.lang = 'en-US'
  utt.rate = 0.9
  window.speechSynthesis.speak(utt)
}

interface Props {
  route: Route
  onClose: () => void
}

export default function DirectionsPanel({ route, onClose }: Props) {
  const [navigating, setNavigating] = useState(false)
  const [step, setStep] = useState(0)
  const [turnsExpanded, setTurnsExpanded] = useState(false)

  const { summary, maneuvers, segments } = route
  const quality = segments ? computeRouteQuality(segments) : null

  useEffect(() => {
    return () => window.speechSynthesis?.cancel()
  }, [])

  function startNav() {
    setNavigating(true)
    setStep(0)
    const first = maneuvers[0] as ValhallaManeuver | undefined
    if (first) speak(first.instruction)
  }

  function stopNav() {
    setNavigating(false)
    window.speechSynthesis?.cancel()
  }

  function goToStep(n: number) {
    setStep(n)
    const m = maneuvers[n] as ValhallaManeuver | undefined
    if (m) speak(m.instruction)
  }

  const currentStep = maneuvers[step] as ValhallaManeuver | undefined

  return (
    <div className="directions-panel">
      {/* Compact summary row */}
      <div className="route-summary">
        <div className="summary-stats">
          <span className="summary-distance">{formatDistance(summary.distance)}</span>
          <span className="summary-sep">·</span>
          <span className="summary-time">{formatDuration(summary.duration)}</span>
        </div>
        <button className="close-btn" onClick={onClose} title="Clear route">✕</button>
      </div>

      {/* Route quality bar */}
      {quality && (
        <div className="quality-bar-wrap">
          <div className="quality-bar">
            {quality.good > 0 && (
              <div className="qb-segment qb-good" style={{ flex: quality.good }} title={`${Math.round(quality.good * 100)}% good`} />
            )}
            {quality.ok > 0 && (
              <div className="qb-segment qb-ok" style={{ flex: quality.ok }} title={`${Math.round(quality.ok * 100)}% ok`} />
            )}
            {quality.bad > 0 && (
              <div className="qb-segment qb-bad" style={{ flex: quality.bad }} title={`${Math.round(quality.bad * 100)}% avoid`} />
            )}
          </div>
          <div className="quality-labels">
            {quality.good > 0.05 && <span className="ql-good">{Math.round(quality.good * 100)}% good</span>}
            {quality.ok   > 0.05 && <span className="ql-ok">{Math.round(quality.ok    * 100)}% ok</span>}
            {quality.bad  > 0.05 && <span className="ql-bad">{Math.round(quality.bad   * 100)}% avoid</span>}
          </div>
        </div>
      )}

      {navigating ? (
        <div className="nav-active">
          <div className="nav-step-row">
            <span className="nav-icon">{icon(currentStep?.type ?? 0)}</span>
            <p className="nav-instruction">{currentStep?.instruction}</p>
          </div>
          {currentStep?.length != null && (
            <p className="nav-dist">in {formatDistance(currentStep.length)}</p>
          )}
          <div className="nav-controls">
            <button
              className="nav-btn"
              disabled={step === 0}
              onClick={() => goToStep(step - 1)}
            >
              ‹ Prev
            </button>
            <span className="nav-counter">
              {step + 1} / {maneuvers.length}
            </span>
            <button
              className="nav-btn"
              disabled={step === maneuvers.length - 1}
              onClick={() => goToStep(step + 1)}
            >
              Next ›
            </button>
          </div>
          <button className="stop-nav-btn" onClick={stopNav}>
            Stop Navigation
          </button>
        </div>
      ) : (
        <>
          <button className="start-nav-btn" onClick={startNav}>
            ▶ Start Navigation
          </button>

          {/* Collapsible turn-by-turn */}
          <button
            className="turns-toggle"
            onClick={() => setTurnsExpanded((v) => !v)}
          >
            <span>Turn-by-turn</span>
            <span className="turns-toggle-arrow">{turnsExpanded ? '▲' : '▼'}</span>
          </button>

          {turnsExpanded && (
            <ol className="maneuvers-list">
              {(maneuvers as ValhallaManeuver[]).map((m, i) => (
                <li key={i} className="maneuver">
                  <span className="maneuver-icon">{icon(m.type)}</span>
                  <div className="maneuver-body">
                    <p className="maneuver-text">{m.instruction}</p>
                    <p className="maneuver-meta">
                      {formatDistance(m.length)} · {Math.max(1, Math.round(m.time / 60))} min
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  )
}
