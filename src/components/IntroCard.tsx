import { useState, useEffect } from 'react'

const DISMISS_KEY = 'bike-route-intro-dismissed'

interface Props {
  /** Force-show the intro regardless of dismissal state (for re-opening from a help button). */
  forced?: boolean
  onClose?: () => void
}

/**
 * First-visit intro card. Explains what the app does, who it's for,
 * and the 3-step "how to start" in a dismissable bottom-sheet (mobile)
 * / centered card (desktop). Dismissal is persisted in localStorage
 * so it doesn't re-appear on every visit — but a help button in the
 * map controls re-opens it on demand via the `forced` prop.
 */
export default function IntroCard({ forced = false, onClose }: Props) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (forced) { setVisible(true); return }
    try {
      const dismissed = localStorage.getItem(DISMISS_KEY) === '1'
      if (!dismissed) setVisible(true)
    } catch {
      setVisible(true) // localStorage blocked → still show
    }
  }, [forced])

  if (!visible) return null

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, '1') } catch { /* quota */ }
    setVisible(false)
    onClose?.()
  }

  return (
    <div className="intro-backdrop" onClick={dismiss}>
      <div className="intro-card" onClick={(e) => e.stopPropagation()}>
        <div className="intro-header">
          <h2 className="intro-title">Family Bike Map</h2>
          <button className="intro-close" onClick={dismiss} aria-label="Close">×</button>
        </div>

        <p className="intro-lede">
          A bike route planner for parents biking with kids. Picks
          routes that match your rider's level — from a toddler on a
          balance bike to a confident kid in traffic — and walks your
          family past scary intersections instead of routing you
          through them.
        </p>

        <ol className="intro-steps">
          <li>
            <span className="intro-step-num">1</span>
            <div>
              <strong>Pick your rider level.</strong> Tap an icon at
              the top. "Kid starting out" chooses only fully car-free
              paths; "Kid confident" adds quiet streets; the others
              adjust from there.
            </div>
          </li>
          <li>
            <span className="intro-step-num">2</span>
            <div>
              <strong>Search a place.</strong> Top-left. Pick from the
              dropdown to see it on the map, then tap Directions.
            </div>
          </li>
          <li>
            <span className="intro-step-num">3</span>
            <div>
              <strong>Tap any segment</strong> on the route for a
              street-view photo and the option to reroute around it
              or flag it as wrongly classified.
            </div>
          </li>
        </ol>

        <p className="intro-footnote">
          Green segments are good for your rider level; orange/grey
          means slower or walk-the-bike. Built with OSM + Mapillary;
          it's opinionated, not finished — tell us when a segment is wrong.
        </p>

        <button className="intro-got-it" onClick={dismiss}>
          Got it — show me the map
        </button>
      </div>
    </div>
  )
}
