import { useState, useEffect } from 'react'
import { formatDistance, formatDuration } from '../services/routing.js'

// Valhalla maneuver type → direction icon
const ICONS = {
  1: '▶', // start
  4: '🏁', // destination
  7: '↑', // becomes
  8: '↑', // continue
  9: '↗', // slight right
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
  27: '↑', // roundabout exit
}

function icon(type) {
  return ICONS[type] ?? '•'
}

function speak(text) {
  if (!('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  const utt = new SpeechSynthesisUtterance(text)
  utt.lang = 'en-US'
  utt.rate = 0.9
  window.speechSynthesis.speak(utt)
}

export default function DirectionsPanel({ route, onClose }) {
  const [navigating, setNavigating] = useState(false)
  const [step, setStep] = useState(0)

  const { summary, maneuvers } = route

  useEffect(() => {
    return () => window.speechSynthesis?.cancel()
  }, [])

  function startNav() {
    setNavigating(true)
    setStep(0)
    if (maneuvers[0]) speak(maneuvers[0].instruction)
  }

  function stopNav() {
    setNavigating(false)
    window.speechSynthesis?.cancel()
  }

  function goToStep(n) {
    setStep(n)
    if (maneuvers[n]) speak(maneuvers[n].instruction)
  }

  return (
    <div className="directions-panel">
      <div className="route-summary">
        <span className="summary-distance">{formatDistance(summary.distance)}</span>
        <span className="summary-sep">·</span>
        <span className="summary-time">{formatDuration(summary.duration)}</span>
        <button className="close-btn" onClick={onClose} title="Clear route">
          ✕
        </button>
      </div>

      {navigating ? (
        <div className="nav-active">
          <div className="nav-step-row">
            <span className="nav-icon">{icon(maneuvers[step]?.type)}</span>
            <p className="nav-instruction">{maneuvers[step]?.instruction}</p>
          </div>
          {maneuvers[step]?.length != null && (
            <p className="nav-dist">in {formatDistance(maneuvers[step].length)}</p>
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
          <ol className="maneuvers-list">
            {maneuvers.map((m, i) => (
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
        </>
      )}
    </div>
  )
}
