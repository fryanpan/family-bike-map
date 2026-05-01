// Leaflet adapter for the MapEngine interface.
//
// Used for both the OSM Carto and the MapTiler "Streets v2 light" base
// styles — they differ only in the tile URL we hand to L.tileLayer.
//
// Internally keeps a Map of opaque-handle id → underlying Leaflet
// object so consumers don't have to traffic in Leaflet types. A single
// shared canvas renderer powers polylines that opt into it (the bike-
// infra overlay; canvas is 5–10x faster than SVG on mobile for many
// lines).

import L from 'leaflet'
import { CachedTileLayer } from '../cachedTileLayer'
import type {
  MapEngine, MapInitOptions, MapEventName, MapEvent,
  LatLng, LatLngBounds, FitBoundsOptions,
  PolylineStyle, PolylineHandlers, PolylineHandle,
  MarkerIcon, MarkerHandlers, MarkerOptions, MarkerHandle,
  PopupOptions, PopupHandle,
  PathLayerFeature, PathLayerHandlers, PathLayerHandle,
} from './types'

// Fix Leaflet default icons broken by Vite's asset bundling. Same fix
// the legacy Map.tsx did at module load — moved here so the abstraction
// owns it.
import markerIconUrl from 'leaflet/dist/images/marker-icon.png'
import markerIcon2xUrl from 'leaflet/dist/images/marker-icon-2x.png'
import markerShadowUrl from 'leaflet/dist/images/marker-shadow.png'
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl
L.Icon.Default.mergeOptions({
  iconUrl: markerIconUrl,
  iconRetinaUrl: markerIcon2xUrl,
  shadowUrl: markerShadowUrl,
})

let nextHandleId = 1
function makeId(): number { return nextHandleId++ }

// Raster tile providers — each entry is a URL template + attribution.
// Picked by `BaseStyle` in mount(). Anything not matched falls through
// to the OSM Carto default.
const ATTR_OSM      = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
const ATTR_CARTO    = '&copy; <a href="https://carto.com/attributions">CARTO</a> ' + ATTR_OSM
const ATTR_MAPTILER = '&copy; <a href="https://www.maptiler.com/copyright/">MapTiler</a> ' + ATTR_OSM

const OSM_TILES: Record<string, { url: string; attribution: string }> = {
  'osm-carto': {
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: ATTR_OSM,
  },
  'cartocdn-voyager': {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
    attribution: ATTR_CARTO,
  },
  'cartocdn-positron': {
    url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    attribution: ATTR_CARTO,
  },
}

// MapTiler style → tileset path. Each style is hosted at
// /maps/<id>/256/{z}/{x}/{y}.<ext>?key=…
const MAPTILER_STYLES: Record<string, { path: string; ext: string }> = {
  'maptiler-streets-light': { path: 'streets-v2-light', ext: 'png' },
  'maptiler-streets':       { path: 'streets-v2',       ext: 'png' },
  'maptiler-streets-dark':  { path: 'streets-v2-dark',  ext: 'png' },
  'maptiler-outdoor':       { path: 'outdoor-v2',       ext: 'png' },
  'maptiler-satellite':     { path: 'satellite-v2',     ext: 'jpg' },
}

function maptilerTile(style: string, key: string) {
  const entry = MAPTILER_STYLES[style] ?? MAPTILER_STYLES['maptiler-streets-light']
  return {
    url: `https://api.maptiler.com/maps/${entry.path}/256/{z}/{x}/{y}.${entry.ext}?key=${key}`,
    attribution: ATTR_MAPTILER,
  }
}

export class LeafletEngine implements MapEngine {
  readonly kind = 'leaflet' as const

  private map: L.Map | null = null
  private tileLayer: L.TileLayer | null = null
  /** Shared canvas renderer — assigned to polylines that opt in via
   *  PolylineStyle.useCanvasRenderer. Created on mount. */
  private canvasRenderer: L.Renderer | null = null
  private polylines  = new Map<number, L.Polyline>()
  private pathLayers = new Map<number, number[]>()  // layer id → polyline ids
  private markers    = new Map<number, L.Marker>()
  private popups     = new Map<number, L.Popup>()

  async mount(container: HTMLElement, options: MapInitOptions): Promise<void> {
    if (this.map) throw new Error('LeafletEngine already mounted')
    this.map = L.map(container, {
      center: options.center,
      zoom: options.zoom,
      zoomControl: true,
    })
    this.canvasRenderer = L.canvas({ padding: 0.5 })

    const isMaptiler = options.baseStyle.startsWith('maptiler-')
    const tile = isMaptiler && options.maptilerKey
      ? maptilerTile(options.baseStyle, options.maptilerKey)
      : OSM_TILES[options.baseStyle] ?? OSM_TILES['osm-carto']
    // Use CachedTileLayer so base tiles paint from IndexedDB on a return
    // visit before any network fetch starts (sub-second second-load goal).
    // Drop-in replacement for L.TileLayer — same constructor signature.
    this.tileLayer = new CachedTileLayer(tile.url, { attribution: tile.attribution }).addTo(this.map)
  }

  unmount(): void {
    if (!this.map) return
    this.map.remove()
    this.map = null
    this.tileLayer = null
    this.canvasRenderer = null
    this.polylines.clear()
    this.pathLayers.clear()
    this.markers.clear()
    this.popups.clear()
  }

  private requireMap(): L.Map {
    if (!this.map) throw new Error('LeafletEngine not mounted')
    return this.map
  }

  // ── View ────────────────────────────────────────────────────────────
  getCenter(): LatLng {
    const c = this.requireMap().getCenter()
    return [c.lat, c.lng]
  }
  getZoom(): number { return this.requireMap().getZoom() }
  setView(center: LatLng, zoom?: number): void {
    this.requireMap().setView(center, zoom ?? this.getZoom())
  }
  flyTo(center: LatLng, zoom?: number): void {
    this.requireMap().flyTo(center, zoom ?? this.getZoom(), { duration: 0.8 })
  }
  getBounds(): LatLngBounds {
    const b = this.requireMap().getBounds()
    const sw = b.getSouthWest()
    const ne = b.getNorthEast()
    return [[sw.lat, sw.lng], [ne.lat, ne.lng]]
  }
  fitBounds(bounds: LatLngBounds, options: FitBoundsOptions = {}): void {
    this.requireMap().fitBounds(
      L.latLngBounds(bounds[0], bounds[1]),
      {
        paddingTopLeft: options.paddingTopLeft,
        paddingBottomRight: options.paddingBottomRight,
        animate: options.animate,
      },
    )
  }
  invalidateSize(): void { this.requireMap().invalidateSize() }
  latLngToContainerPoint(latLng: LatLng): [number, number] {
    const p = this.requireMap().latLngToContainerPoint(L.latLng(latLng[0], latLng[1]))
    return [p.x, p.y]
  }

  // ── Events ──────────────────────────────────────────────────────────
  on(event: MapEventName, handler: (ev: MapEvent) => void): () => void {
    const map = this.requireMap()
    let listener: (...args: unknown[]) => void
    if (event === 'click') {
      listener = (e: unknown) => {
        const me = e as L.LeafletMouseEvent
        handler({ type: 'click', latLng: [me.latlng.lat, me.latlng.lng] })
      }
      map.on('click', listener as L.LeafletEventHandlerFn)
      return () => { map.off('click', listener as L.LeafletEventHandlerFn) }
    }
    if (event === 'zoomend') {
      listener = () => { handler({ type: 'zoomend', zoom: map.getZoom() }) }
      map.on('zoomend', listener as L.LeafletEventHandlerFn)
      return () => { map.off('zoomend', listener as L.LeafletEventHandlerFn) }
    }
    if (event === 'moveend') {
      listener = () => { handler({ type: 'moveend', bounds: this.getBounds() }) }
      map.on('moveend', listener as L.LeafletEventHandlerFn)
      return () => { map.off('moveend', listener as L.LeafletEventHandlerFn) }
    }
    if (event === 'resize') {
      listener = () => { handler({ type: 'resize' }) }
      map.on('resize', listener as L.LeafletEventHandlerFn)
      return () => { map.off('resize', listener as L.LeafletEventHandlerFn) }
    }
    return () => { /* no-op for unknown event */ }
  }

  // ── Polylines ───────────────────────────────────────────────────────
  addPolyline(coords: LatLng[], style: PolylineStyle, handlers?: PolylineHandlers): PolylineHandle {
    const map = this.requireMap()
    const opts: L.PolylineOptions = {
      color: style.color,
      weight: style.weight,
      opacity: style.opacity,
      interactive: style.interactive ?? true,
    }
    if (style.dashArray) opts.dashArray = style.dashArray
    else if (style.dashed) opts.dashArray = '10 6'
    if (style.useCanvasRenderer && this.canvasRenderer) opts.renderer = this.canvasRenderer
    const ply = L.polyline(coords, opts).addTo(map)
    if (handlers?.onClick) {
      ply.on('click', (e) => {
        L.DomEvent.stopPropagation(e.originalEvent)
        handlers.onClick!([e.latlng.lat, e.latlng.lng])
      })
    }
    if (handlers?.tooltipHtml) {
      ply.bindTooltip(handlers.tooltipHtml, { sticky: true, direction: 'top', offset: [0, -6] })
    }
    const id = makeId()
    this.polylines.set(id, ply)
    return { __brand: 'polyline', id }
  }

  updatePolyline(handle: PolylineHandle, partial: Partial<PolylineStyle>): void {
    const ply = this.polylines.get(handle.id)
    if (!ply) return
    const next: L.PathOptions = {}
    if (partial.color !== undefined)       next.color = partial.color
    if (partial.weight !== undefined)      next.weight = partial.weight
    if (partial.opacity !== undefined)     next.opacity = partial.opacity
    if (partial.dashArray !== undefined)   next.dashArray = partial.dashArray
    else if (partial.dashed !== undefined) next.dashArray = partial.dashed ? '10 6' : ''
    ply.setStyle(next)
  }

  removePolyline(handle: PolylineHandle): void {
    const ply = this.polylines.get(handle.id)
    if (!ply) return
    ply.remove()
    this.polylines.delete(handle.id)
  }

  // ── Path layers (bulk) ──────────────────────────────────────────────
  // Leaflet's canvas renderer already batches many polylines into one
  // paint, so the "bulk" path is just a loop over addPolyline. We track
  // the resulting polyline ids in a single layer handle so the consumer
  // can drop the whole batch at once.
  addPathLayer(features: PathLayerFeature[], handlers?: PathLayerHandlers): PathLayerHandle {
    const layerId = makeId()
    const polyIds: number[] = []
    for (const f of features) {
      const onClick = handlers?.onClick
        ? (latLng: LatLng) => handlers.onClick!(f.id, latLng, f.meta)
        : undefined
      const ph = this.addPolyline(
        f.coordinates,
        {
          color: f.color,
          weight: f.width,
          opacity: f.opacity,
          dashArray: f.dashArray,
          useCanvasRenderer: true,
        },
        onClick ? { onClick } : undefined,
      )
      polyIds.push(ph.id)
    }
    this.pathLayers.set(layerId, polyIds)
    return { __brand: 'pathLayer', id: layerId }
  }

  removePathLayer(handle: PathLayerHandle): void {
    const ids = this.pathLayers.get(handle.id)
    if (!ids) return
    for (const id of ids) {
      const ply = this.polylines.get(id)
      if (ply) {
        ply.remove()
        this.polylines.delete(id)
      }
    }
    this.pathLayers.delete(handle.id)
  }

  // ── Markers ─────────────────────────────────────────────────────────
  addMarker(
    latLng: LatLng,
    icon: MarkerIcon,
    handlers?: MarkerHandlers,
    options: MarkerOptions = {},
  ): MarkerHandle {
    const map = this.requireMap()
    let leafletIcon: L.Icon | L.DivIcon
    if (icon.kind === 'html') {
      leafletIcon = L.divIcon({
        html: icon.html,
        className: icon.className ?? '',
        iconSize: icon.size,
        iconAnchor: icon.anchor,
      })
    } else {
      leafletIcon = L.icon({
        iconUrl: icon.url,
        iconSize: icon.size,
        iconAnchor: icon.anchor,
      })
    }
    const marker = L.marker(latLng, { icon: leafletIcon, zIndexOffset: options.zIndexOffset })
    if (handlers?.onClick) marker.on('click', () => handlers.onClick!())
    if (handlers?.tooltipHtml) {
      marker.bindTooltip(handlers.tooltipHtml, { direction: 'top', offset: [0, -20] })
    }
    marker.addTo(map)
    const id = makeId()
    this.markers.set(id, marker)
    return { __brand: 'marker', id }
  }

  removeMarker(handle: MarkerHandle): void {
    const m = this.markers.get(handle.id)
    if (!m) return
    m.remove()
    this.markers.delete(handle.id)
  }

  // ── Popups ──────────────────────────────────────────────────────────
  openPopup(
    anchor: PolylineHandle | MarkerHandle | LatLng,
    content: string | HTMLElement,
    options: PopupOptions = {},
  ): PopupHandle {
    const map = this.requireMap()
    const popup = L.popup({
      maxWidth: options.maxWidth,
      className: options.className,
    }).setContent(content as L.Content)
    let coord: L.LatLngExpression
    if (Array.isArray(anchor) && typeof anchor[0] === 'number' && typeof anchor[1] === 'number') {
      coord = anchor as LatLng
    } else if ('__brand' in anchor && anchor.__brand === 'marker') {
      const m = this.markers.get(anchor.id)
      if (!m) throw new Error('marker handle not found')
      coord = m.getLatLng()
    } else if ('__brand' in anchor && anchor.__brand === 'polyline') {
      const p = this.polylines.get(anchor.id)
      if (!p) throw new Error('polyline handle not found')
      const latLngs = p.getLatLngs() as L.LatLng[]
      coord = latLngs[Math.floor(latLngs.length / 2)] ?? latLngs[0]
    } else {
      throw new Error('invalid anchor for openPopup')
    }
    popup.setLatLng(coord).openOn(map)
    if (options.onClose) {
      const closer = () => {
        options.onClose!()
        map.off('popupclose', closer as L.LeafletEventHandlerFn)
      }
      map.on('popupclose', closer as L.LeafletEventHandlerFn)
    }
    const id = makeId()
    this.popups.set(id, popup)
    return { __brand: 'popup', id }
  }

  updatePopup(handle: PopupHandle, content: string | HTMLElement): void {
    const popup = this.popups.get(handle.id)
    if (!popup) return
    popup.setContent(content as L.Content)
    popup.update()
  }

  closePopup(handle: PopupHandle): void {
    const popup = this.popups.get(handle.id)
    if (!popup) return
    this.requireMap().closePopup(popup)
    this.popups.delete(handle.id)
  }
}
