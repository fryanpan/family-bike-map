// Google Maps adapter for the MapEngine interface.
//
// Loads the Google Maps JS API on demand via the official
// @googlemaps/js-api-loader (loaded as an ES module from a CDN — no
// extra npm dependency). The bootstrap is async; mount() resolves once
// the SDK is ready and the map has been constructed.
//
// Mapping notes:
//   - Google Polyline uses `strokeColor`, `strokeWeight`, `strokeOpacity`
//     (not `color/weight/opacity`); we map our unified PolylineStyle
//     to those at addPolyline time.
//   - Dashed lines use the `icons` repeating-symbol trick (Google
//     doesn't have a `dashArray` equivalent).
//   - Marker icons are constructed from raw HTML via OverlayView for
//     parity with Leaflet divIcons. Image markers go through the
//     standard `icon` field.
//   - Popups → InfoWindow.

import type {
  MapEngine, MapInitOptions, MapEventName, MapEvent,
  LatLng, LatLngBounds, FitBoundsOptions,
  PolylineStyle, PolylineHandlers, PolylineHandle,
  MarkerIcon, MarkerHandlers, MarkerOptions, MarkerHandle,
  PopupOptions, PopupHandle,
  PathLayerFeature, PathLayerHandlers, PathLayerHandle,
} from './types'

let nextHandleId = 1
function makeId(): number { return nextHandleId++ }

/**
 * Convert an SVG `stroke-dasharray` string (e.g. "1 4" = 1px on, 4px
 * off) into a Google Maps repeating-icon recipe that approximates the
 * same stipple. Google Polylines have no native `dashArray`, so we
 * draw an invisible line and stamp a short vertical segment along it
 * at `(on + off)px` intervals; the segment's length along the polyline
 * is `on` px, its perpendicular thickness is the line weight.
 *
 * Only the first two values of the dasharray are honoured — alternating
 * patterns aren't representable as a single icon. Returns null if the
 * string can't be parsed.
 */
function dashArrayToIconSequence(
  dashArray: string,
  weight: number,
  opacity: number,
): google.maps.IconSequence | null {
  const parts = dashArray.split(/[\s,]+/).map((s) => parseFloat(s)).filter((n) => Number.isFinite(n) && n > 0)
  if (parts.length < 2) return null
  const on = parts[0]
  const off = parts[1]
  return {
    icon: {
      // 'M 0,-1 0,1' is a vertical 2-unit segment in the symbol's local
      // frame. Symbol y aligns with the polyline direction, so this draws
      // a dash *along* the line; scale=on/2 makes the dash on px long.
      path: 'M 0,-1 0,1',
      strokeOpacity: opacity,
      strokeWeight: weight,
      scale: on / 2,
    },
    offset: '0',
    repeat: (on + off) + 'px',
  }
}

/**
 * Convert "#rrggbb" or "#rgb" + opacity (0..1) into deck.gl's
 * [r, g, b, a] 0-255 array format. deck.gl PathLayer's getColor returns
 * this shape; we keep one helper per engine instead of per layer so the
 * conversion code lives in one place.
 */
function hexToRgba(hex: string, opacity: number): [number, number, number, number] {
  let h = hex.replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const r = parseInt(h.slice(0, 2), 16) || 0
  const g = parseInt(h.slice(2, 4), 16) || 0
  const b = parseInt(h.slice(4, 6), 16) || 0
  return [r, g, b, Math.round(Math.max(0, Math.min(1, opacity)) * 255)]
}

// Cached Google API promise — multiple LeafletEngine→GoogleEngine swaps
// would otherwise re-load the SDK on each remount.
let googleApiPromise: Promise<typeof google.maps> | null = null

async function loadGoogleMapsApi(apiKey: string): Promise<typeof google.maps> {
  if (googleApiPromise) return googleApiPromise
  googleApiPromise = (async () => {
    // The 2.x loader exposes setOptions() + importLibrary() instead of
    // the deprecated `new Loader().load()` constructor flow. We only
    // need the maps + marker libraries; importing them here primes the
    // shared `google.maps` namespace for everything else we use.
    const { setOptions, importLibrary } = await import('@googlemaps/js-api-loader')
    setOptions({ key: apiKey, v: 'weekly' })
    await importLibrary('maps')
    await importLibrary('marker')
    return google.maps
  })()
  return googleApiPromise
}

export class GoogleMapsEngine implements MapEngine {
  readonly kind = 'google' as const

  private map: google.maps.Map | null = null
  private polylines = new Map<number, google.maps.Polyline>()
  private polylineDashIcons = new Map<number, google.maps.IconSequence[]>() // for dashed
  private markers   = new Map<number, google.maps.Marker | google.maps.OverlayView>()
  private popups    = new Map<number, google.maps.InfoWindow>()
  // deck.gl GoogleMapsOverlay — lazily created on first addPathLayer.
  // We keep one overlay and feed it an array of PathLayers; each call
  // to addPathLayer adds a layer, removePathLayer drops it. Lazy init
  // keeps deck.gl out of the bundle's critical path until needed.
  private deckOverlay: import('@deck.gl/google-maps').GoogleMapsOverlay | null = null
  private deckLayers = new Map<number, import('@deck.gl/layers').PathLayer>()
  private pathLayerHandlers = new Map<number, PathLayerHandlers>()
  private pathLayerFeatures = new Map<number, PathLayerFeature[]>()

  async mount(container: HTMLElement, options: MapInitOptions): Promise<void> {
    if (this.map) throw new Error('GoogleMapsEngine already mounted')
    if (!options.googleMapsKey) {
      throw new Error('GoogleMapsEngine requires googleMapsKey in MapInitOptions')
    }
    await loadGoogleMapsApi(options.googleMapsKey)
    // Map BaseStyle → Google's MapTypeId. roadmap is the default vector
    // streets view; satellite/hybrid/terrain use Google's imagery tiles.
    const mapTypeId =
      options.baseStyle === 'google-satellite' ? google.maps.MapTypeId.SATELLITE :
      options.baseStyle === 'google-hybrid'    ? google.maps.MapTypeId.HYBRID :
      options.baseStyle === 'google-terrain'   ? google.maps.MapTypeId.TERRAIN :
      google.maps.MapTypeId.ROADMAP
    // Landmark POI strategy:
    //   showLandmarks=true (default) — keep helpful navigational POIs
    //     (parks, schools, transit, places of worship, government,
    //     attractions) but hide the noisy commercial layer (restaurants,
    //     shops, business). This is the bike-with-kids-friendly mode:
    //     parents look for parks and transit landmarks; not for the
    //     nearest cafe.
    //   showLandmarks=false — hide ALL POIs. Useful when the bike-infra
    //     overlay is dense and any extra clutter hurts.
    // Only applied to roadmap; satellite/hybrid/terrain tiles paint POIs
    // into the imagery so styles array doesn't reach them.
    const showLandmarks = options.googleShowLandmarks ?? true
    const styles: google.maps.MapTypeStyle[] = showLandmarks
      ? [
          { featureType: 'poi.business',       stylers: [{ visibility: 'off' }] },
          { featureType: 'poi.sports_complex', stylers: [{ visibility: 'simplified' }] },
        ]
      : [{ featureType: 'poi', stylers: [{ visibility: 'off' }] }]
    this.map = new google.maps.Map(container, {
      center: { lat: options.center[0], lng: options.center[1] },
      zoom: options.zoom,
      mapTypeId,
      styles,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
    })
  }

  unmount(): void {
    if (!this.map) return
    // Google has no map.destroy(); detach by clearing the container.
    for (const ply of this.polylines.values()) ply.setMap(null)
    for (const m of this.markers.values()) {
      const anyMarker = m as { setMap?: (m: google.maps.Map | null) => void }
      anyMarker.setMap?.(null)
    }
    for (const p of this.popups.values()) p.close()
    if (this.deckOverlay) {
      this.deckOverlay.setMap(null)
      this.deckOverlay.finalize?.()
      this.deckOverlay = null
    }
    this.deckLayers.clear()
    this.pathLayerHandlers.clear()
    this.pathLayerFeatures.clear()
    this.polylines.clear()
    this.polylineDashIcons.clear()
    this.markers.clear()
    this.popups.clear()
    this.map = null
  }

  private requireMap(): google.maps.Map {
    if (!this.map) throw new Error('GoogleMapsEngine not mounted')
    return this.map
  }

  // ── View ────────────────────────────────────────────────────────────
  getCenter(): LatLng {
    const c = this.requireMap().getCenter()
    return [c?.lat() ?? 0, c?.lng() ?? 0]
  }
  getZoom(): number { return this.requireMap().getZoom() ?? 0 }
  setView(center: LatLng, zoom?: number): void {
    const map = this.requireMap()
    map.setCenter({ lat: center[0], lng: center[1] })
    if (zoom !== undefined) map.setZoom(zoom)
  }
  flyTo(center: LatLng, zoom?: number): void {
    const map = this.requireMap()
    map.panTo({ lat: center[0], lng: center[1] })
    if (zoom !== undefined) map.setZoom(zoom)
  }
  getBounds(): LatLngBounds {
    const b = this.requireMap().getBounds()
    if (!b) return [[0, 0], [0, 0]]
    const sw = b.getSouthWest()
    const ne = b.getNorthEast()
    return [[sw.lat(), sw.lng()], [ne.lat(), ne.lng()]]
  }
  fitBounds(bounds: LatLngBounds, options: FitBoundsOptions = {}): void {
    const map = this.requireMap()
    const llb = new google.maps.LatLngBounds(
      { lat: bounds[0][0], lng: bounds[0][1] },
      { lat: bounds[1][0], lng: bounds[1][1] },
    )
    // Google's fitBounds takes a Padding object — { top, left, bottom,
    // right } — which is similar to our paddingTopLeft/BottomRight.
    const padding: google.maps.Padding = {
      top:    options.paddingTopLeft?.[0]     ?? 0,
      left:   options.paddingTopLeft?.[1]     ?? 0,
      bottom: options.paddingBottomRight?.[0] ?? 0,
      right:  options.paddingBottomRight?.[1] ?? 0,
    }
    map.fitBounds(llb, padding)
  }
  invalidateSize(): void {
    if (!this.map) return
    google.maps.event.trigger(this.map, 'resize')
  }
  latLngToContainerPoint(latLng: LatLng): [number, number] {
    const map = this.requireMap()
    const proj = map.getProjection()
    const bounds = map.getBounds()
    const div = map.getDiv()
    if (!proj || !bounds) return [0, 0]
    const ne = bounds.getNorthEast()
    const sw = bounds.getSouthWest()
    const topRight = proj.fromLatLngToPoint(ne)
    const bottomLeft = proj.fromLatLngToPoint(sw)
    const point = proj.fromLatLngToPoint(new google.maps.LatLng(latLng[0], latLng[1]))
    if (!topRight || !bottomLeft || !point) return [0, 0]
    const scale = 1 << (map.getZoom() ?? 0)
    const x = (point.x - bottomLeft.x) * scale
    const y = (point.y - topRight.y)   * scale
    // Clamp to container bounds so callers don't position outside the
    // visible map.
    return [
      Math.max(0, Math.min(div.clientWidth, x)),
      Math.max(0, Math.min(div.clientHeight, y)),
    ]
  }

  // ── Events ──────────────────────────────────────────────────────────
  on(event: MapEventName, handler: (ev: MapEvent) => void): () => void {
    const map = this.requireMap()
    let listener: google.maps.MapsEventListener | null = null
    if (event === 'click') {
      listener = map.addListener('click', (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return
        handler({ type: 'click', latLng: [e.latLng.lat(), e.latLng.lng()] })
      })
    } else if (event === 'zoomend') {
      listener = map.addListener('zoom_changed', () => {
        handler({ type: 'zoomend', zoom: map.getZoom() ?? 0 })
      })
    } else if (event === 'moveend') {
      listener = map.addListener('idle', () => {
        // 'idle' fires after pan/zoom settles — closest analogue to
        // Leaflet's moveend.
        handler({ type: 'moveend', bounds: this.getBounds() })
      })
    } else if (event === 'resize') {
      listener = map.addListener('resize', () => {
        handler({ type: 'resize' })
      })
    }
    return () => { listener?.remove() }
  }

  // ── Polylines ───────────────────────────────────────────────────────
  addPolyline(coords: LatLng[], style: PolylineStyle, handlers?: PolylineHandlers): PolylineHandle {
    const map = this.requireMap()
    const id = makeId()
    const path = coords.map(([lat, lng]) => ({ lat, lng }))
    const opts: google.maps.PolylineOptions = {
      path,
      map,
      strokeColor: style.color,
      strokeWeight: style.weight,
      strokeOpacity: style.opacity,
      clickable: style.interactive ?? true,
      // Pin z-order to creation order. Without an explicit zIndex,
      // Google Maps reorders polylines as the viewport changes — visible
      // as the bike-infra white halo flickering on top of the colored
      // line in some pans. Leaflet stacks by add order natively; this
      // preserves that contract on Google.
      zIndex: id,
      // useCanvasRenderer is Leaflet-only; Google uses its own renderer.
    }
    if (style.dashArray) {
      const ic = dashArrayToIconSequence(style.dashArray, style.weight, style.opacity)
      if (ic) {
        opts.strokeOpacity = 0
        opts.icons = [ic]
      }
    } else if (style.dashed) {
      // Google's "dashed line" recipe: 0% strokeOpacity + repeating
      // dash icon. The icon's strokeWeight matches the line so the
      // dash thickness follows weight changes in updatePolyline.
      opts.strokeOpacity = 0
      opts.icons = [
        {
          icon: {
            path: 'M 0,-1 0,1',
            strokeOpacity: style.opacity,
            strokeWeight: style.weight,
            scale: 2,
          },
          offset: '0',
          repeat: '12px',
        },
      ]
    }
    const ply = new google.maps.Polyline(opts)
    if (handlers?.onClick) {
      ply.addListener('click', (e: google.maps.PolyMouseEvent) => {
        if (!e.latLng) return
        handlers.onClick!([e.latLng.lat(), e.latLng.lng()])
      })
    }
    // Google has no built-in tooltip; we approximate via a transient
    // InfoWindow on mouseover. Skipped here for parity simplicity —
    // hovering on Google Maps Polylines isn't a primary mobile flow.
    this.polylines.set(id, ply)
    if (opts.icons) this.polylineDashIcons.set(id, opts.icons)
    return { __brand: 'polyline', id }
  }

  updatePolyline(handle: PolylineHandle, partial: Partial<PolylineStyle>): void {
    const ply = this.polylines.get(handle.id)
    if (!ply) return
    const opts: google.maps.PolylineOptions = {}
    if (partial.color !== undefined)   opts.strokeColor = partial.color
    if (partial.weight !== undefined)  opts.strokeWeight = partial.weight
    if (partial.opacity !== undefined) opts.strokeOpacity = partial.opacity
    if (partial.dashArray !== undefined) {
      if (partial.dashArray) {
        const w = partial.weight ?? (ply.get('strokeWeight') as number | undefined) ?? 4
        const o = partial.opacity ?? 1
        const ic = dashArrayToIconSequence(partial.dashArray, w, o)
        if (ic) {
          opts.strokeOpacity = 0
          opts.icons = [ic]
          this.polylineDashIcons.set(handle.id, opts.icons)
        }
      } else {
        opts.icons = []
        this.polylineDashIcons.delete(handle.id)
      }
    } else if (partial.dashed !== undefined) {
      if (partial.dashed) {
        opts.strokeOpacity = 0
        const w = partial.weight ?? (ply.get('strokeWeight') as number | undefined) ?? 4
        const o = partial.opacity ?? 1
        opts.icons = [
          {
            icon: { path: 'M 0,-1 0,1', strokeOpacity: o, strokeWeight: w, scale: 2 },
            offset: '0',
            repeat: '12px',
          },
        ]
        this.polylineDashIcons.set(handle.id, opts.icons)
      } else {
        opts.icons = []
        this.polylineDashIcons.delete(handle.id)
      }
    }
    ply.setOptions(opts)
  }

  removePolyline(handle: PolylineHandle): void {
    const ply = this.polylines.get(handle.id)
    if (!ply) return
    ply.setMap(null)
    this.polylines.delete(handle.id)
    this.polylineDashIcons.delete(handle.id)
  }

  // ── Path layers (deck.gl bulk renderer) ─────────────────────────────
  // Renders all features in one WebGL draw call via deck.gl's
  // GoogleMapsOverlay + PathLayer. Critical for the bike-infra overlay
  // which can be thousands of segments at city-overview zooms — one
  // google.maps.Polyline per segment dies on mobile, but a single
  // batched layer holds 60fps. The overlay is created lazily on the
  // first call and shared across all PathLayers.
  addPathLayer(features: PathLayerFeature[], handlers?: PathLayerHandlers): PathLayerHandle {
    const map = this.requireMap()
    const layerId = makeId()
    void this.ensureDeckOverlay(map).then(({ GoogleMapsOverlay, PathLayer }) => {
      if (!this.map) return // unmounted while loading
      if (!this.deckOverlay) {
        this.deckOverlay = new GoogleMapsOverlay({ layers: [] })
        this.deckOverlay.setMap(this.map)
      }
      this.pathLayerFeatures.set(layerId, features)
      if (handlers) this.pathLayerHandlers.set(layerId, handlers)
      const layer = this.buildDeckPathLayer(PathLayer, layerId, features, handlers)
      this.deckLayers.set(layerId, layer)
      this.deckOverlay.setProps({ layers: Array.from(this.deckLayers.values()) })
    })
    return { __brand: 'pathLayer', id: layerId }
  }

  removePathLayer(handle: PathLayerHandle): void {
    if (!this.deckLayers.has(handle.id)) return
    this.deckLayers.delete(handle.id)
    this.pathLayerHandlers.delete(handle.id)
    this.pathLayerFeatures.delete(handle.id)
    if (this.deckOverlay) {
      this.deckOverlay.setProps({ layers: Array.from(this.deckLayers.values()) })
    }
  }

  // Lazy-load deck.gl modules. Both packages are dynamically imported on
  // first use so the deck.gl bundle (~150 KB gzip) doesn't ship with the
  // initial app shell. Cached by the import system after the first call.
  private async ensureDeckOverlay(_map: google.maps.Map): Promise<{
    GoogleMapsOverlay: typeof import('@deck.gl/google-maps').GoogleMapsOverlay
    PathLayer: typeof import('@deck.gl/layers').PathLayer
  }> {
    const [{ GoogleMapsOverlay }, { PathLayer }] = await Promise.all([
      import('@deck.gl/google-maps'),
      import('@deck.gl/layers'),
    ])
    return { GoogleMapsOverlay, PathLayer }
  }

  private buildDeckPathLayer(
    PathLayerCtor: typeof import('@deck.gl/layers').PathLayer,
    layerId: number,
    features: PathLayerFeature[],
    handlers?: PathLayerHandlers,
  ): import('@deck.gl/layers').PathLayer {
    // deck.gl's PathLayer accessor types are loose; cast at the seam.
    return new PathLayerCtor({
      id: 'family-bike-path-' + layerId,
      data: features as unknown as object[],
      // deck.gl expects [lng, lat] coordinate order; our LatLng is
      // [lat, lng], so we flip per vertex.
      getPath: ((f: PathLayerFeature) => f.coordinates.map(([lat, lng]) => [lng, lat])) as never,
      getColor: ((f: PathLayerFeature) => hexToRgba(f.color, f.opacity)) as never,
      getWidth: ((f: PathLayerFeature) => f.width) as never,
      widthUnits: 'pixels',
      widthMinPixels: 1,
      pickable: !!handlers?.onClick,
      // Smoother visual when paths cross — round joints/caps match
      // Leaflet's default polyline rendering.
      jointRounded: true,
      capRounded: true,
      onClick: handlers?.onClick
        ? (info: { object?: PathLayerFeature; coordinate?: number[] }) => {
            if (!info.object) return
            const c = info.coordinate
            const latLng: LatLng = c ? [c[1], c[0]] : info.object.coordinates[0]
            handlers.onClick!(info.object.id, latLng, info.object.meta)
          }
        : undefined,
    })
  }

  // ── Markers ─────────────────────────────────────────────────────────
  addMarker(
    latLng: LatLng,
    icon: MarkerIcon,
    handlers?: MarkerHandlers,
    options: MarkerOptions = {},
  ): MarkerHandle {
    const map = this.requireMap()
    const id = makeId()

    if (icon.kind === 'image') {
      const marker = new google.maps.Marker({
        position: { lat: latLng[0], lng: latLng[1] },
        map,
        icon: {
          url: icon.url,
          scaledSize: new google.maps.Size(icon.size[0], icon.size[1]),
          anchor: new google.maps.Point(icon.anchor[0], icon.anchor[1]),
        },
        zIndex: options.zIndexOffset,
      })
      if (handlers?.onClick) marker.addListener('click', () => handlers.onClick!())
      this.markers.set(id, marker)
      return { __brand: 'marker', id }
    }

    // HTML icon — wrap the HTML in a small custom OverlayView so it
    // anchors to the latLng. Google's standard Marker doesn't accept
    // raw HTML; the marker library's AdvancedMarkerElement does, but
    // requires a Google-managed mapId, so we go DIY for portability.
    const overlay = new google.maps.OverlayView()
    let div: HTMLDivElement | null = null
    overlay.onAdd = function () {
      const wrapper = document.createElement('div')
      wrapper.style.position = 'absolute'
      wrapper.style.cursor = handlers?.onClick ? 'pointer' : 'default'
      wrapper.style.width = `${icon.size[0]}px`
      wrapper.style.height = `${icon.size[1]}px`
      wrapper.innerHTML = icon.html
      if (icon.className) wrapper.className = icon.className
      if (handlers?.onClick) {
        wrapper.addEventListener('click', (e) => {
          e.stopPropagation()
          handlers.onClick!()
        })
      }
      const panes = this.getPanes()
      panes?.overlayMouseTarget.appendChild(wrapper)
      div = wrapper
    }
    overlay.draw = function () {
      if (!div) return
      const proj = this.getProjection()
      if (!proj) return
      const point = proj.fromLatLngToDivPixel(new google.maps.LatLng(latLng[0], latLng[1]))
      if (!point) return
      div.style.left = `${point.x - icon.anchor[0]}px`
      div.style.top  = `${point.y - icon.anchor[1]}px`
    }
    overlay.onRemove = function () {
      if (div?.parentNode) div.parentNode.removeChild(div)
      div = null
    }
    overlay.setMap(map)

    this.markers.set(id, overlay)
    return { __brand: 'marker', id }
  }

  removeMarker(handle: MarkerHandle): void {
    const m = this.markers.get(handle.id)
    if (!m) return
    const anyMarker = m as { setMap?: (m: google.maps.Map | null) => void }
    anyMarker.setMap?.(null)
    this.markers.delete(handle.id)
  }

  // ── Popups (InfoWindow) ─────────────────────────────────────────────
  openPopup(
    anchor: PolylineHandle | MarkerHandle | LatLng,
    content: string | HTMLElement,
    options: PopupOptions = {},
  ): PopupHandle {
    const map = this.requireMap()
    const iw = new google.maps.InfoWindow({
      content,
      maxWidth: options.maxWidth,
    })
    let coord: google.maps.LatLngLiteral
    if (Array.isArray(anchor) && typeof anchor[0] === 'number' && typeof anchor[1] === 'number') {
      coord = { lat: anchor[0], lng: anchor[1] }
    } else if ('__brand' in anchor && anchor.__brand === 'marker') {
      const m = this.markers.get(anchor.id)
      if (!m) throw new Error('marker handle not found')
      const anyMarker = m as { getPosition?: () => google.maps.LatLng | null | undefined }
      const pos = anyMarker.getPosition?.()
      if (!pos) throw new Error('marker has no position (HTML overlay) — pass LatLng instead')
      coord = { lat: pos.lat(), lng: pos.lng() }
    } else if ('__brand' in anchor && anchor.__brand === 'polyline') {
      const ply = this.polylines.get(anchor.id)
      if (!ply) throw new Error('polyline handle not found')
      const path = ply.getPath().getArray()
      const mid = path[Math.floor(path.length / 2)]
      coord = { lat: mid.lat(), lng: mid.lng() }
    } else {
      throw new Error('invalid anchor for openPopup')
    }
    iw.setPosition(coord)
    iw.open(map)
    if (options.onClose) {
      iw.addListener('closeclick', () => options.onClose!())
    }
    const id = makeId()
    this.popups.set(id, iw)
    return { __brand: 'popup', id }
  }

  updatePopup(handle: PopupHandle, content: string | HTMLElement): void {
    const iw = this.popups.get(handle.id)
    if (!iw) return
    iw.setContent(content)
  }

  closePopup(handle: PopupHandle): void {
    const iw = this.popups.get(handle.id)
    if (!iw) return
    iw.close()
    this.popups.delete(handle.id)
  }
}
