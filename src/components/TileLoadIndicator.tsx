/**
 * Live loading indicator for the browse-map overlay. Shows, while Overpass tiles
 * are loading: an overall progress bar (settled / total tiles + bytes), which
 * tiles are downloading right now (with per-tile byte progress), and which are
 * still queued. Auto-hides when nothing is loading.
 *
 * Reads the tile-load store (src/services/tileLoadStatus.ts), which the single
 * fetch choke point reports into. Cache hits are instant and never appear here.
 */
import { useTileLoadStatus } from '../services/tileLoadStatus'

function fmtBytes(n: number): string {
  if (n <= 0) return '0 KB'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function TileLoadIndicator() {
  const s = useTileLoadStatus()
  if (!s.active) return null

  const settled = s.doneCount + s.errorCount
  const pct = s.totalCount > 0 ? Math.round((settled / s.totalCount) * 100) : 0

  return (
    <div className="tile-load-indicator" role="status" aria-live="polite">
      <div className="tile-load-header">
        <span className="tile-load-spinner" aria-hidden="true" />
        <span className="tile-load-title">Loading bike map</span>
        <span className="tile-load-count">{settled}/{s.totalCount} tiles</span>
      </div>

      <div className="tile-load-bar">
        <div className="tile-load-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="tile-load-bytes">
        {fmtBytes(s.loadedBytes)} downloaded
        {s.loading.length > 0 && <span> · {s.loading.length} loading</span>}
        {s.queued.length > 0 && <span> · {s.queued.length} queued</span>}
        {s.errorCount > 0 && <span className="tile-load-err"> · {s.errorCount} failed</span>}
      </div>
    </div>
  )
}
