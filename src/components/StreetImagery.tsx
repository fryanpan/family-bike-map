import { useEffect, useState } from 'react'
import { resolveStreetImagery, type ResolvedImagery } from '../services/streetImagery'

/**
 * Street-level image for a map point. Shows Google Street View where it has
 * coverage and falls back to Mapillary where it doesn't — so coverage gaps no
 * longer leave the popup with a blank / gray "no imagery" tile. Renders a
 * loading placeholder while resolving, and a subtle note only when neither
 * source has anything.
 */
export function StreetImagery({ lat, lng }: { lat: number; lng: number }) {
  const [state, setState] = useState<ResolvedImagery | null>(null)

  useEffect(() => {
    let cancelled = false
    setState(null)
    void resolveStreetImagery(lat, lng).then((r) => {
      if (!cancelled) setState(r)
    })
    return () => { cancelled = true }
  }, [lat, lng])

  if (state === null) {
    return <div className="segment-popup-img-loading">Loading street view…</div>
  }
  if (state.kind === 'none') {
    return <div className="segment-popup-img-missing">No street imagery here</div>
  }
  return (
    <figure className="segment-popup-img-figure">
      <img src={state.url} alt="Street-level view" className="segment-popup-img" loading="lazy" />
      {state.credit && (
        <figcaption className="segment-popup-img-credit">via {state.credit}</figcaption>
      )}
    </figure>
  )
}
