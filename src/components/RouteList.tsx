import { formatDistance, formatDuration } from '../utils/format'
import { computeRouteQuality } from '../utils/classify'
import { PREFERRED_COLOR, OTHER_COLOR } from '../utils/classify'
import type { Route } from '../utils/types'

interface Props {
  routes: Route[]
  selectedIndex: number
  onSelect: (index: number) => void
  preferredItemNames: Set<string>
}

function engineTag(engine?: string): string {
  if (engine === 'brouter') return 'B'
  if (engine === 'client') return 'C'
  return 'V'
}

export default function RouteList({ routes, selectedIndex, onSelect, preferredItemNames }: Props) {
  if (routes.length <= 1) return null

  return (
    <div className="route-list">
      {routes.map((r, i) => {
        const quality = r.segments
          ? computeRouteQuality(r.segments, preferredItemNames)
          : null
        const isSelected = i === selectedIndex
        const isBRouter = r.engine === 'brouter'
        const preferredPct = quality ? Math.round(quality.preferred * 100) : null

        return (
          <button
            key={i}
            className={`route-card ${isSelected ? 'route-card--selected' : ''} ${isBRouter ? 'route-card--brouter' : ''}`}
            onClick={() => onSelect(i)}
          >
            <div className="route-card-row">
              <span className="route-card-engine">{engineTag(r.engine)}</span>
              <span className="route-card-distance">{formatDistance(r.summary.distance)}</span>
              <span className="route-card-sep">&middot;</span>
              <span className="route-card-time">{formatDuration(r.summary.duration)}</span>
              {preferredPct !== null && (
                <span className="route-card-pct">{preferredPct}%</span>
              )}
            </div>
            {quality && (
              <div className="route-card-bar">
                {quality.preferred > 0 && (
                  <div className="route-card-bar-seg" style={{ flex: quality.preferred, backgroundColor: PREFERRED_COLOR }} />
                )}
                {quality.other > 0 && (
                  <div className="route-card-bar-seg" style={{ flex: quality.other, backgroundColor: OTHER_COLOR }} />
                )}
              </div>
            )}
          </button>
        )
      })}
    </div>
  )
}
