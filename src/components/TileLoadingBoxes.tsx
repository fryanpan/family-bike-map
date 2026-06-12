/**
 * Translucent grey boxes drawn over the map tiles that are still loading, each
 * with a spinner in the middle, so the user can see exactly which part of the
 * map is waiting on data. Queued tiles (waiting behind the fetch concurrency
 * cap) get a dimmer, dashed box.
 *
 * Positions are projected from each tile's geographic bounds to container
 * pixels via the engine, and re-projected on map move/zoom/resize. Reads the
 * tile-load store. Display-only — pointer-events: none, so the map still pans.
 */
import { useEffect, useState } from 'react'
import type { MapEngine } from '../services/mapEngine'
import { tileBounds } from '../services/overpass'
import { useTileLoadStatus, type TileStatus } from '../services/tileLoadStatus'

export function TileLoadingBoxes({ engine }: { engine: MapEngine }) {
  const status = useTileLoadStatus()
  const [, bump] = useState(0)

  // Re-project the boxes whenever the map view changes.
  useEffect(() => {
    const rerender = () => bump((n) => n + 1)
    const offMove = engine.on('moveend', rerender)
    const offZoom = engine.on('zoomend', rerender)
    const offResize = engine.on('resize', rerender)
    return () => { offMove(); offZoom(); offResize() }
  }, [engine])

  if (!status.active) return null

  const entries: Array<{ t: TileStatus; active: boolean }> = [
    ...status.loading.map((t) => ({ t, active: true })),
    ...status.queued.map((t) => ({ t, active: false })),
  ]

  const boxes = entries.map(({ t, active }) => {
    const b = tileBounds(t.row, t.col)
    let nw: [number, number]
    let se: [number, number]
    try {
      nw = engine.latLngToContainerPoint([b.north, b.west])
      se = engine.latLngToContainerPoint([b.south, b.east])
    } catch {
      return null
    }
    const left = Math.min(nw[0], se[0])
    const top = Math.min(nw[1], se[1])
    const width = Math.abs(se[0] - nw[0])
    const height = Math.abs(se[1] - nw[1])
    if (!Number.isFinite(left) || !Number.isFinite(top) || width <= 0 || height <= 0) return null
    return (
      <div
        key={t.key}
        className={`tile-loading-box${active ? '' : ' tile-loading-box--queued'}`}
        style={{ left, top, width, height }}
      >
        {active && <span className="tile-loading-box-icon" aria-hidden="true" />}
      </div>
    )
  })

  return <div className="tile-loading-boxes" aria-hidden="true">{boxes}</div>
}
