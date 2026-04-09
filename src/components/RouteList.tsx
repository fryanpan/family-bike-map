import { formatDistance, formatDuration } from '../services/routing'
import { computeRouteQuality } from '../utils/classify'
import { PREFERRED_COLOR, OTHER_COLOR } from '../utils/classify'
import SafetyScore from './SafetyScore'
import type { Route } from '../utils/types'

interface Props {
  routes: Route[]
  selectedIndex: number
  onSelect: (index: number) => void
  preferredItemNames: Set<string>
}

function routeLabel(index: number, engine?: string): string {
  const engineLabel = engine === 'brouter' ? 'BRouter' : 'Valhalla'
  if (index === 0) return `Route 1 (fastest) - ${engineLabel}`
  return `Route ${index + 1} - ${engineLabel}`
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
            <div className="route-card-header">
              <span className="route-card-label">{routeLabel(i, r.engine)}</span>
            </div>

            <div className="route-card-stats">
              <span className="route-card-distance">{formatDistance(r.summary.distance)}</span>
              <span className="route-card-sep">&middot;</span>
              <span className="route-card-time">{formatDuration(r.summary.duration)}</span>
            </div>

            {quality && (
              <div className="route-card-quality">
                <div className="route-card-bar">
                  {quality.preferred > 0 && (
                    <div
                      className="route-card-bar-seg"
                      style={{
                        flex: quality.preferred,
                        backgroundColor: PREFERRED_COLOR,
                      }}
                    />
                  )}
                  {quality.other > 0 && (
                    <div
                      className="route-card-bar-seg"
                      style={{
                        flex: quality.other,
                        backgroundColor: OTHER_COLOR,
                      }}
                    />
                  )}
                </div>
                {preferredPct !== null && (
                  <span className="route-card-pct">{preferredPct}% preferred</span>
                )}
              </div>
            )}

            {r.ltsBreakdown && (
              <SafetyScore
                score={r.ltsBreakdown.familySafetyScore}
                worstSegment={r.ltsBreakdown.worstSegment}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
