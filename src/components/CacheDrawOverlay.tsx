/**
 * Rectangle drawing overlay for selecting a map area to cache.
 *
 * When active, intercepts mouse/touch events on the map to let the user
 * draw a rectangle. On release, shows a confirmation dialog with tile
 * count estimate. On confirm, triggers the download callback.
 */
import { useState, useCallback, useRef } from 'react'
import { Rectangle, useMapEvents } from 'react-leaflet'
import type { LatLngBounds } from 'leaflet'
import L from 'leaflet'
import { estimateTiles } from '../services/tileCache'

interface Props {
  active: boolean
  onConfirm: (bbox: { south: number; west: number; north: number; east: number }) => void
  onCancel: () => void
}

/** Inner component that hooks into Leaflet map events. */
function DrawHandler({
  onDrawComplete,
}: {
  onDrawComplete: (bounds: LatLngBounds) => void
}) {
  const [drawing, setDrawing] = useState(false)
  const [bounds, setBounds] = useState<LatLngBounds | null>(null)
  const startRef = useRef<L.LatLng | null>(null)

  useMapEvents({
    mousedown(e) {
      // Only respond to left click
      if (e.originalEvent.button !== 0) return
      e.originalEvent.preventDefault()
      e.originalEvent.stopPropagation()
      startRef.current = e.latlng
      setBounds(L.latLngBounds(e.latlng, e.latlng))
      setDrawing(true)
      // Disable map dragging while drawing
      e.target.dragging.disable()
    },
    mousemove(e) {
      if (!drawing || !startRef.current) return
      setBounds(L.latLngBounds(startRef.current, e.latlng))
    },
    mouseup(e) {
      if (!drawing || !startRef.current) return
      e.target.dragging.enable()
      setDrawing(false)
      const finalBounds = L.latLngBounds(startRef.current, e.latlng)
      startRef.current = null
      setBounds(null)

      // Ignore tiny rectangles (accidental clicks)
      const ne = finalBounds.getNorthEast()
      const sw = finalBounds.getSouthWest()
      const latSpan = Math.abs(ne.lat - sw.lat)
      const lngSpan = Math.abs(ne.lng - sw.lng)
      if (latSpan < 0.001 && lngSpan < 0.001) return

      onDrawComplete(finalBounds)
    },
  })

  if (!bounds) return null

  return (
    <Rectangle
      bounds={bounds}
      pathOptions={{
        color: '#2563eb',
        weight: 2,
        fillColor: '#2563eb',
        fillOpacity: 0.15,
        dashArray: '6 4',
      }}
    />
  )
}

export default function CacheDrawOverlay({ active, onConfirm, onCancel }: Props) {
  const [pendingBbox, setPendingBbox] = useState<{
    south: number; west: number; north: number; east: number
  } | null>(null)

  const handleDrawComplete = useCallback((bounds: LatLngBounds) => {
    const bbox = {
      south: bounds.getSouth(),
      west: bounds.getWest(),
      north: bounds.getNorth(),
      east: bounds.getEast(),
    }
    setPendingBbox(bbox)
  }, [])

  const handleConfirm = useCallback(() => {
    if (pendingBbox) {
      onConfirm(pendingBbox)
      setPendingBbox(null)
    }
  }, [pendingBbox, onConfirm])

  const handleCancel = useCallback(() => {
    setPendingBbox(null)
    onCancel()
  }, [onCancel])

  if (!active && !pendingBbox) return null

  const estimate = pendingBbox ? estimateTiles(pendingBbox) : null

  return (
    <>
      {active && !pendingBbox && <DrawHandler onDrawComplete={handleDrawComplete} />}

      {pendingBbox && (
        <Rectangle
          bounds={L.latLngBounds(
            [pendingBbox.south, pendingBbox.west],
            [pendingBbox.north, pendingBbox.east],
          )}
          pathOptions={{
            color: '#2563eb',
            weight: 2,
            fillColor: '#2563eb',
            fillOpacity: 0.15,
            dashArray: '6 4',
          }}
        />
      )}

      {pendingBbox && estimate && (
        <div className="cache-rect-confirm" role="dialog" aria-label="Confirm download area">
          <p className="cache-rect-confirm-text">
            Download cycling data for this area?
          </p>
          <p className="cache-rect-confirm-detail">
            ~{estimate.tileCount} tiles, ~{estimate.estimatedSeconds}s
          </p>
          <div className="cache-rect-confirm-actions">
            <button className="download-banner-dismiss" onClick={handleCancel}>
              Cancel
            </button>
            <button className="download-banner-btn" onClick={handleConfirm}>
              Download
            </button>
          </div>
        </div>
      )}
    </>
  )
}
