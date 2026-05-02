// Map engine abstraction shared across Leaflet (OSM Carto + MapTiler)
// and Google Maps. The interface is imperative — we add/update/remove
// polylines and markers via opaque handles so the consumer can rebuild
// only what changed without re-mounting the whole map.
//
// React-Leaflet was the prior abstraction; it doesn't generalise to
// Google Maps because Google Maps doesn't have an idiomatic React
// binding. The new shape is engine-agnostic: each consumer (Map.tsx,
// BikeMapOverlay.tsx) owns a small useEffect that diffs its data
// against the engine.

export type LatLng = [number, number]   // [lat, lng]
export type LatLngBounds = [LatLng, LatLng] // [southWest, northEast]

export type MapEngineKind = 'leaflet-osm' | 'leaflet-maptiler' | 'google-maps'

/**
 * Concrete cartographic style. Each engine accepts a subset:
 *   - leaflet-osm:      'osm-carto' | 'cartocdn-voyager' | 'cartocdn-positron'
 *   - leaflet-maptiler: 'maptiler-streets-light' | 'maptiler-streets' |
 *                       'maptiler-streets-dark' | 'maptiler-outdoor' |
 *                       'maptiler-satellite'
 *   - google-maps:      'google-roadmap' | 'google-satellite' |
 *                       'google-hybrid'  | 'google-terrain'
 * `resolveEngine` clamps an out-of-engine choice back to that engine's
 * default, so callers can store user preference unconditionally.
 */
export type BaseStyle =
  // Leaflet OSM raster
  | 'osm-carto'
  | 'cartocdn-voyager'
  | 'cartocdn-positron'
  // MapTiler
  | 'maptiler-streets-light'
  | 'maptiler-streets'
  | 'maptiler-streets-dark'
  | 'maptiler-outdoor'
  | 'maptiler-satellite'
  // Google Maps
  | 'google-roadmap'
  | 'google-satellite'
  | 'google-hybrid'
  | 'google-terrain'

export interface MapInitOptions {
  center: LatLng
  zoom: number
  baseStyle: BaseStyle
  /** API keys used by some engines (MapTiler, Google). Engines that
   *  don't need them ignore the field. */
  maptilerKey?: string
  googleMapsKey?: string
  /** Google-only: when true (default), the basemap shows navigational
   *  POIs (parks, schools, transit, landmarks) but hides noisy commercial
   *  POIs (restaurants, shops). When false, all POIs are hidden — the
   *  pre-2026-05 behaviour. Ignored by Leaflet engines. */
  googleShowLandmarks?: boolean
}

export interface PolylineStyle {
  color: string
  weight: number
  opacity: number
  /** When true, dashes the line. Engines pick a sensible default dash. */
  dashed?: boolean
  /** Optional explicit dash pattern (SVG dash-array syntax, e.g. "1 3"
   *  for fine stipple). Wins over the `dashed` default when set. Used
   *  for the rough-surface stipple overlay. Ignored by Google Maps
   *  (their Polyline doesn't have a dashArray analogue). */
  dashArray?: string
  /** When false the polyline is non-interactive (no click events, no
   *  hover cursor). Default true. */
  interactive?: boolean
  /** When true (and interactive=true) tells Leaflet's canvas renderer
   *  to render this polyline; ignored by Google Maps. Used for
   *  performance on the bike-infra overlay. */
  useCanvasRenderer?: boolean
}

export interface PolylineHandlers {
  onClick?: (latLng: LatLng) => void
  /** Sticky tooltip: appears on hover, follows the cursor. Pass HTML
   *  string. */
  tooltipHtml?: string
}

export interface MarkerIconHtml {
  kind: 'html'
  /** Inline HTML rendered inside the marker container. */
  html: string
  /** Pixel dimensions of the icon. */
  size: [number, number]
  /** Anchor point relative to the icon's top-left. */
  anchor: [number, number]
  /** Optional className applied to the marker container. */
  className?: string
}

export interface MarkerIconImage {
  kind: 'image'
  url: string
  size: [number, number]
  anchor: [number, number]
}

export type MarkerIcon = MarkerIconHtml | MarkerIconImage

export interface MarkerHandlers {
  onClick?: () => void
  /** Sticky tooltip on the marker. */
  tooltipHtml?: string
}

export interface MarkerOptions {
  /** When set, marker renders behind other markers (smaller z-index). */
  zIndexOffset?: number
}

export interface PopupOptions {
  maxWidth?: number
  className?: string
  /** Called when the popup is dismissed (by user click-away or close). */
  onClose?: () => void
}

export interface FitBoundsOptions {
  /**
   * Padding in pixels expressed as `[x, y]` (Leaflet `Point` convention):
   *   - `paddingTopLeft  = [left, top]`
   *   - `paddingBottomRight = [right, bottom]`
   * So mobile values like `[40, 100]` = 40 px horizontal, 100 px
   * vertical reserved for chrome at the top-left corner.
   */
  paddingTopLeft?: [number, number]
  paddingBottomRight?: [number, number]
  animate?: boolean
}

export type MapEventName = 'zoomend' | 'moveend' | 'click' | 'resize'

export interface MapClickEvent {
  type: 'click'
  latLng: LatLng
}

export interface MapZoomEvent {
  type: 'zoomend'
  zoom: number
}

export interface MapMoveEvent {
  type: 'moveend'
  bounds: LatLngBounds
}

export interface MapResizeEvent {
  type: 'resize'
}

export type MapEvent = MapClickEvent | MapZoomEvent | MapMoveEvent | MapResizeEvent

// Opaque handles. Engines hold the underlying object internally.
export interface PolylineHandle { readonly __brand: 'polyline'; readonly id: number }
export interface MarkerHandle    { readonly __brand: 'marker';   readonly id: number }
export interface PopupHandle     { readonly __brand: 'popup';    readonly id: number }
export interface PathLayerHandle { readonly __brand: 'pathLayer'; readonly id: number }

/**
 * Bulk path features for `addPathLayer`. Each feature has its own
 * geometry + style (color/width/opacity). Used for the bike-infra
 * overlay where thousands of segments at city-overview zooms are too
 * many for one-Polyline-per-segment rendering.
 *
 * On Google Maps this is rendered via deck.gl's PathLayer (one WebGL
 * draw call regardless of feature count). On Leaflet the engine falls
 * back to per-polyline addPolyline since Leaflet's canvas renderer
 * already batches efficiently.
 */
export interface PathLayerFeature {
  /** Stable id for click-back identification. Must be unique within the layer. */
  readonly id: string | number
  readonly coordinates: LatLng[]
  readonly color: string
  readonly width: number
  readonly opacity: number
  /** Optional dash pattern for stipple effects (e.g. rough surfaces). */
  readonly dashArray?: string
  /** Arbitrary payload echoed back to onClick handlers. */
  readonly meta?: unknown
}

export interface PathLayerHandlers {
  /** Fired when a path is clicked. The feature's id and meta are echoed
   *  back so the consumer can dispatch on it without holding a closure
   *  per feature. */
  onClick?: (featureId: string | number, latLng: LatLng, meta: unknown) => void
}

export interface MapEngine {
  readonly kind: 'leaflet' | 'google'

  /** Mount the map in the given container. May be async (Google bootstrap). */
  mount(container: HTMLElement, options: MapInitOptions): Promise<void>
  /** Tear down the map and release internal resources. */
  unmount(): void

  // ── View state ────────────────────────────────────────────────────────
  getCenter(): LatLng
  getZoom(): number
  setView(center: LatLng, zoom?: number): void
  flyTo(center: LatLng, zoom?: number): void
  getBounds(): LatLngBounds
  fitBounds(bounds: LatLngBounds, options?: FitBoundsOptions): void
  /** Force the engine to recompute container size — call after CSS
   *  layout changes that resize the map's parent. */
  invalidateSize(): void
  /** Convert a lat/lng to a pixel offset relative to the map container's
   *  top-left corner. Used for positioning React overlays (segment
   *  popups) at click points. */
  latLngToContainerPoint(latLng: LatLng): [number, number]

  // ── Events ────────────────────────────────────────────────────────────
  on(event: MapEventName, handler: (ev: MapEvent) => void): () => void

  // ── Polylines ─────────────────────────────────────────────────────────
  addPolyline(coords: LatLng[], style: PolylineStyle, handlers?: PolylineHandlers): PolylineHandle
  updatePolyline(handle: PolylineHandle, partial: Partial<PolylineStyle>): void
  removePolyline(handle: PolylineHandle): void

  // ── Path layers (bulk) ────────────────────────────────────────────────
  /** Render many paths as a single batched layer. Use for hundreds-to-
   *  thousands of small lines (bike-infra overlay) where one Polyline
   *  per feature is too expensive. Returns one handle for the whole
   *  batch; replace by calling removePathLayer + addPathLayer. */
  addPathLayer(features: PathLayerFeature[], handlers?: PathLayerHandlers): PathLayerHandle
  removePathLayer(handle: PathLayerHandle): void

  // ── Markers ───────────────────────────────────────────────────────────
  addMarker(latLng: LatLng, icon: MarkerIcon, handlers?: MarkerHandlers, options?: MarkerOptions): MarkerHandle
  removeMarker(handle: MarkerHandle): void

  // ── Popups ────────────────────────────────────────────────────────────
  /** Open a popup anchored to a polyline (midpoint), marker (its
   *  position), or fixed lat/lng. Content may be either an HTML string
   *  (most uses) or a DOM Node (when React needs to portal into it). */
  openPopup(
    anchor: PolylineHandle | MarkerHandle | LatLng,
    content: string | HTMLElement,
    options?: PopupOptions,
  ): PopupHandle
  /** Update the HTML of an open popup (used for lazy-loaded content
   *  like Street View images). */
  updatePopup(handle: PopupHandle, content: string | HTMLElement): void
  closePopup(handle: PopupHandle): void
}
