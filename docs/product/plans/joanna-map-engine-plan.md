# Pluggable Map Rendering Engine

> Source: Joanna user research, Solutions row #2 — pivot to pluggable engines (Bryan, 2026-04-29)
> Scope: ship 3 selectable engines via Admin Settings, applied to BOTH base tiles AND overlay/route polylines
> Carries over the prior agent's `ui-base-map-cobble-tap-targets` work (cobble visibility + tap targets) into the new abstraction

## Goal

Make `Map.tsx` and `BikeMapOverlay.tsx` rendering-engine agnostic. Three engines available:

1. **`leaflet-osm`** (default) — Leaflet + OSM Carto raster
2. **`leaflet-maptiler`** — Leaflet + MapTiler Streets v2 light raster (needs `VITE_MAPTILER_KEY`)
3. **`google-maps`** — Google Maps JS API (needs `VITE_GOOGLE_MAPS_KEY`)

User picks the engine in Admin Tools → Settings. Switching requires a page reload (documented in the dropdown).

## Architecture

### `MapEngine` interface (imperative)

Define in `src/services/mapEngine/types.ts`:

```ts
interface MapEngine {
  mount(container: HTMLElement, options: MapInitOptions): Promise<void>
  unmount(): void

  // View state
  getCenter(): LatLng
  getZoom(): number
  setView(center: LatLng, zoom?: number): void
  flyTo(center: LatLng, zoom?: number): void
  getBounds(): LatLngBounds
  fitBounds(bounds: LatLngBounds, options?: FitBoundsOptions): void

  // Events
  on(event: MapEventName, handler: (ev: MapEvent) => void): () => void

  // Polylines
  addPolyline(coords: LatLng[], style: PolylineStyle, handlers?: PolylineHandlers): PolylineHandle
  updatePolyline(handle: PolylineHandle, partial: Partial<PolylineStyle>): void
  removePolyline(handle: PolylineHandle): void

  // Markers (icon = HTML or pin descriptor)
  addMarker(latLng: LatLng, icon: MarkerIcon, handlers?: MarkerHandlers): MarkerHandle
  removeMarker(handle: MarkerHandle): void

  // Popups (anchored content, can be rich HTML)
  openPopup(anchor: PolylineHandle | MarkerHandle | LatLng, html: string, options?: PopupOptions): PopupHandle
  closePopup(handle: PopupHandle): void

  // Engine identity (so consumers can branch when they must)
  readonly kind: 'leaflet' | 'google'
}
```

Three adapters implement it:
- `LeafletEngine` — wraps a `L.Map` instance. Tile URL is configurable per `MapInitOptions.baseStyle = 'osm-carto' | 'maptiler-streets-light'`.
- `GoogleMapsEngine` — uses `@googlemaps/js-api-loader` (loaded dynamically) to bootstrap, then `google.maps.Map`. `addPolyline` → `google.maps.Polyline` (note: uses `strokeWeight` not `weight`; engine maps the unified style API to it).

### Refactored consumers

`Map.tsx`:
- Drops `<MapContainer>`, `<TileLayer>`, `<Polyline>`, `<Marker>`, `<Tooltip>`, `<Popup>`.
- Mounts a `<div ref={containerRef}>` and creates a `MapEngine` in a `useEffect`.
- Each rendering concern becomes a hook that imperatively diffs against the engine: `useRoutePolylines(engine, route, ...)`, `useStartEndMarkers(engine, ...)`, `useCurrentLocationMarker(engine, ...)`, `useFitBoundsOnRouteChange(engine, route)`, etc.
- Tap targets: each visible polyline gets a parallel transparent polyline (weight 24, opacity 0) for hit-testing.

`BikeMapOverlay.tsx`:
- Drops `useMap`, `useMapEvents`, raw `L.polyline`, `L.layerGroup`, `L.canvas`.
- Receives a `MapEngine` instance via prop or context, builds layers via `engine.addPolyline`.
- Cobble visibility: `engine.getZoom()` gates the marker pass; subscribes to zoomend via `engine.on('zoomend', ...)`.
- Tap targets: same parallel transparent polyline trick.

### Settings wiring

`adminSettings.ts`:
- Add `mapEngine: 'leaflet-osm' | 'leaflet-maptiler' | 'google-maps'`, default `'leaflet-osm'`.
- Add helper `resolveActiveEngine(settings, env): MapEngineKind` that:
  - Returns `'leaflet-osm'` if user picked maptiler but `VITE_MAPTILER_KEY` is missing.
  - Returns `'leaflet-osm'` if user picked google-maps but `VITE_GOOGLE_MAPS_KEY` is missing.
  - Logs a console warning in fallback case.

`AdminSettingsTab.tsx`: add a `<select>` with three options. Note in helper text that the change takes effect on next reload.

### Carry-forward UI work (folded into the new abstraction)

- **Cobble visibility (zoom < 16)**: `BikeMapOverlay` reads `engine.getZoom()` and listens to `zoomend`. Logic identical to prior agent's `ace8f40` but routed through the engine.
- **Tap targets**: parallel transparent polyline at weight 24 / opacity 0. For Leaflet this is plain. For Google Maps, same trick (`google.maps.Polyline` supports it; `clickable: true` + `strokeOpacity: 0` + `strokeWeight: 24`).

## Commit order

1. `feat(map-engine): MapEngine interface + types`
2. `feat(map-engine): LeafletEngine adapter (osm + maptiler)`
3. `refactor(map): use MapEngine in Map.tsx + BikeMapOverlay.tsx`
4. `feat(map-engine): GoogleMapsEngine adapter`
5. `feat(admin): map engine dropdown + env-key fallback`
6. `feat(overlay): cobble markers gated on zoom >= 16` (carry-forward)
7. `feat(map,overlay): wider transparent hit polylines for mobile taps` (carry-forward)

## Verification

- `bun test` (unit tests pass)
- `bunx tsc --noEmit` (no type errors)
- `bunx wrangler dev --port 8789` — drive the running app via claude-in-chrome:
  - leaflet-osm: base tiles render, overlay polylines render, route polyline renders, mode switch repaints
  - leaflet-maptiler: same, with MapTiler tiles
  - google-maps: deferred if `VITE_GOOGLE_MAPS_KEY` not provisioned — flag in PR
- Manual mobile tap-target test deferred (Bryan validates on phone)

## Out of scope / deferred

- Canvas-renderer parity for Google's overlay (`google.maps.Polyline` is SVG-based; many polylines may slow on mobile). Document in PR.
- Hot-swap engine without reload (too fragile; document the requirement).
