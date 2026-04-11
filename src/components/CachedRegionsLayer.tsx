/**
 * Map layer showing cached region bounding boxes as dashed rectangles.
 * Click a region to show options (clear / refresh).
 */
import { useState } from 'react'
import { Rectangle, Tooltip } from 'react-leaflet'
import type { CachedRegion } from '../services/tileCache'

interface Props {
  regions: CachedRegion[]
  onDelete: (name: string) => void
  onRefresh: (name: string, bbox: CachedRegion['bbox']) => void
}

export default function CachedRegionsLayer({ regions, onDelete, onRefresh }: Props) {
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null)

  return (
    <>
      {regions.map((region) => (
        <Rectangle
          key={region.name}
          bounds={[
            [region.bbox.south, region.bbox.west],
            [region.bbox.north, region.bbox.east],
          ]}
          pathOptions={{
            color: '#6b7280',
            weight: 1.5,
            fillColor: '#6b7280',
            fillOpacity: 0.04,
            dashArray: '8 6',
          }}
          eventHandlers={{
            click: (e) => {
              e.originalEvent.stopPropagation()
              setSelectedRegion(selectedRegion === region.name ? null : region.name)
            },
          }}
        >
          <Tooltip direction="center" permanent className="cached-region-label">
            {region.name}
          </Tooltip>
        </Rectangle>
      ))}

      {selectedRegion && (
        <div className="cached-region-popup">
          <p className="cached-region-popup-name">{selectedRegion}</p>
          <p className="cached-region-popup-date">
            Cached {new Date(regions.find((r) => r.name === selectedRegion)?.savedAt ?? 0).toLocaleDateString()}
          </p>
          <div className="cached-region-popup-actions">
            <button
              className="download-banner-dismiss"
              onClick={() => {
                onDelete(selectedRegion)
                setSelectedRegion(null)
              }}
            >
              Clear cache
            </button>
            <button
              className="download-banner-btn"
              onClick={() => {
                const region = regions.find((r) => r.name === selectedRegion)
                if (region) {
                  onRefresh(region.name, region.bbox)
                  setSelectedRegion(null)
                }
              }}
            >
              Refresh
            </button>
          </div>
        </div>
      )}
    </>
  )
}
