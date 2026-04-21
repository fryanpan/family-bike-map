import { useState, useEffect, useRef, useMemo } from 'react'
import { formatDistance, formatDuration } from '../utils/format'
import { computeRouteQuality } from '../utils/classify'
import { SIMPLE_TIERS } from './SimpleLegend'
import SegmentFeedback from './SegmentFeedback'
import type { Route, ValhallaManeuver, LatLng } from '../utils/types'

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

/** Haversine distance in meters. */
function distanceM(a: LatLng, b: { lat: number; lng: number }): number {
  const R = 6371000
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x))
}

/** Get the coordinate for a maneuver from the route coordinates. */
function maneuverCoord(m: ValhallaManeuver, coords: [number, number][]): { lat: number; lng: number } | null {
  const idx = m.begin_shape_index ?? 0
  const c = coords[idx]
  return c ? { lat: c[0], lng: c[1] } : null
}

interface Props {
  route: Route
  onClose: () => void
  preferredItemNames: Set<string>
  currentLocation?: LatLng | null
  travelMode?: string
  /** When true, hide the summary row and turn-by-turn until navigation starts. */
  compact?: boolean
}

export default function DirectionsPanel({ route, onClose, preferredItemNames, currentLocation, travelMode, compact }: Props) {
  const [navigating, setNavigating] = useState(false)
  const [step, setStep] = useState(0)
  const [turnsExpanded, setTurnsExpanded] = useState(false)

  const { summary, maneuvers, segments, coordinates } = route
  const quality = segments ? computeRouteQuality(segments, preferredItemNames, travelMode) : null

  // Compute maneuver coordinates once
  const maneuverCoords = useMemo(() =>
    (maneuvers as ValhallaManeuver[]).map((m) => maneuverCoord(m, coordinates)),
    [maneuvers, coordinates],
  )

  // Track which speech triggers have fired for the current step
  const speechRef = useRef<{ step: number; spoke200: boolean; spoke50: boolean }>({ step: -1, spoke200: false, spoke50: false })

  useEffect(() => {
    return () => window.speechSynthesis?.cancel()
  }, [])

  // GPS-based auto-advance and distance-based speech
  useEffect(() => {
    if (!navigating || !currentLocation || maneuvers.length === 0) return

    const nextCoord = maneuverCoords[step + 1]
    if (!nextCoord) return

    const dist = distanceM(currentLocation, nextCoord)

    // Reset speech triggers when step changes
    if (speechRef.current.step !== step) {
      speechRef.current = { step, spoke200: false, spoke50: false }
    }

    const nextManeuver = maneuvers[step + 1] as ValhallaManeuver | undefined
    if (!nextManeuver) return

    // Speak at 200m
    if (dist <= 200 && !speechRef.current.spoke200) {
      speechRef.current.spoke200 = true
      speak(`In ${Math.round(dist)} meters, ${nextManeuver.instruction}`)
    }

    // Speak at 50m (shortened)
    if (dist <= 50 && !speechRef.current.spoke50) {
      speechRef.current.spoke50 = true
      const short = nextManeuver.instruction.replace(/ onto .+$/, '')
      speak(short)
    }

    // Auto-advance at 30m
    if (dist <= 30 && step < maneuvers.length - 1) {
      setStep(step + 1)
    }
  }, [navigating, currentLocation, step, maneuverCoords, maneuvers])

  // Find current segment for preferred/other/walking indicator
  const currentSegmentInfo = useMemo(() => {
    if (!navigating || !currentLocation || !segments?.length) return null
    let nearest = { dist: Infinity, itemName: null as string | null, isWalking: false }
    for (const seg of segments) {
      for (const coord of seg.coordinates) {
        const d = distanceM(currentLocation, { lat: coord[0], lng: coord[1] })
        if (d < nearest.dist) {
          nearest = { dist: d, itemName: seg.itemName, isWalking: seg.isWalking ?? false }
        }
      }
    }
    if (nearest.dist > 100) return null // too far from route
    const isPreferred = nearest.itemName !== null && preferredItemNames.has(nearest.itemName)
    return { itemName: nearest.itemName, isPreferred, isWalking: nearest.isWalking }
  }, [navigating, currentLocation, segments, preferredItemNames])

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
  const nextCoord = maneuverCoords[step + 1]
  const distToNext = currentLocation && nextCoord ? distanceM(currentLocation, nextCoord) : null

  return (
    <div className="directions-panel">
      {/* Summary row — hidden in compact mode (info already in route card) */}
      {(
        <div className="route-summary">
          <div className="summary-stats">
            <span className="summary-distance">{formatDistance(summary.distance)}</span>
            <span className="summary-sep">·</span>
            <span className="summary-time">{formatDuration(summary.duration)}</span>
          </div>
          <button className="close-btn" onClick={onClose} title="Clear route">✕</button>
        </div>
      )}

      {/* Route quality bar — tier-colored segments matching the map legend.
          Preferred share splits into 1a/1b/2a sub-segments (each a distinct
          green). Non-preferred share is the single orange-styled "other"
          fallback; walking keeps its own color. */}
      {quality && (
        <div className="quality-bar-wrap">
          <div className="quality-bar">
            {SIMPLE_TIERS.map((tier) => {
              const frac = quality.byLevel[tier.level] ?? 0
              if (frac <= 0) return null
              return (
                <div
                  key={tier.level}
                  className="qb-segment"
                  style={{ flex: frac, background: tier.color }}
                  title={`${Math.round(frac * 100)}% ${tier.title}`}
                />
              )
            })}
            {quality.walking > 0 && (
              <div className="qb-segment qb-walking" style={{ flex: quality.walking }} title={`${Math.round(quality.walking * 100)}% walking`} />
            )}
            {quality.other > 0 && (
              <div className="qb-segment qb-other" style={{ flex: quality.other }} title={`${Math.round(quality.other * 100)}% other`} />
            )}
          </div>
          <div className="quality-labels">
            {SIMPLE_TIERS.map((tier) => {
              const frac = quality.byLevel[tier.level] ?? 0
              if (frac <= 0.05) return null
              return (
                <span key={tier.level} className="ql-tier" style={{ color: tier.color }}>
                  {Math.round(frac * 100)}% {tier.title.toLowerCase()}
                </span>
              )
            })}
            {quality.walking > 0.05 && (
              <span className="ql-walking">{Math.round(quality.walking * 100)}% walking</span>
            )}
            {quality.other > 0.05 && (
              <span className="ql-other">{Math.round(quality.other * 100)}% other</span>
            )}
          </div>
        </div>
      )}

      {navigating ? (
        <div className="nav-active">
          {/* Current segment indicator */}
          {currentSegmentInfo && (
            <div className={`nav-segment-badge ${currentSegmentInfo.isWalking ? 'nav-segment-walking' : currentSegmentInfo.isPreferred ? 'nav-segment-preferred' : 'nav-segment-other'}`}>
              {currentSegmentInfo.isWalking
                ? '\u{1F6B6} Walk your bike'
                : currentSegmentInfo.isPreferred ? '\u25CF On preferred path' : '\u25CF On other path'}
            </div>
          )}

          <div className="nav-step-row">
            <span className="nav-icon">{icon(currentStep?.type ?? 0)}</span>
            <p className="nav-instruction">{currentStep?.instruction}</p>
          </div>
          {distToNext != null ? (
            <p className="nav-dist">Next turn in {distToNext < 1000 ? `${Math.round(distToNext)}m` : `${(distToNext / 1000).toFixed(1)}km`}</p>
          ) : currentStep?.length != null ? (
            <p className="nav-dist">in {formatDistance(currentStep.length)}</p>
          ) : null}
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

          <SegmentFeedback
            currentLocation={currentLocation ?? null}
            travelMode={travelMode ?? 'unknown'}
          />
        </div>
      ) : (
        <>
          <button className="start-nav-btn" onClick={startNav}>
            ▶ Start Navigation
          </button>

          {/* Collapsible turn-by-turn — hidden in compact mode */}
          {!compact && (
            <>
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
        </>
      )}
    </div>
  )
}
