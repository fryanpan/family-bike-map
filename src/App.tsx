import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { useGeolocation } from './hooks/useGeolocation'
const Map = lazy(() => import('./components/Map'))
const AuditPanel = lazy(() => import('./components/AuditPanel'))
import Legend from './components/Legend'
import SearchBar from './components/SearchBar'
import type { QuickOption } from './components/SearchBar'
import PlaceCard from './components/PlaceCard'
import RoutingHeader from './components/RoutingHeader'
import ProfileSelector from './components/ProfileSelector'
import DirectionsPanel from './components/DirectionsPanel'
import { getRoute, DEFAULT_PROFILES } from './services/routing'
import { scoreRoute } from './services/routeScorer'
import { getBRouterRoutes } from './services/brouter'
import { clientRoute, prefetchTiles } from './services/clientRouter'
import {
  isLocationCached, detectRegion, saveRegion, loadRegion,
  getAllRegions, deleteRegion, bboxFromCenter, estimateTiles,
  type CachedRegion,
} from './services/tileCache'
import { injectCachedTile, latLngToTile, tileKey } from './services/overpass'
import { logRoute } from './services/routeLog'
import { reverseGeocode } from './services/geocoding'
import {
  healSegmentGaps,
  getDefaultPreferredItems,
  getCostingFromPreferences,
  computeRouteQuality,
} from './utils/classify'
import { CITY_PRESETS } from './services/audit'
import { fetchRules } from './services/rules'
import type { ClassificationRule } from './services/rules'
import RouteList from './components/RouteList'
import type { Place, Route, ProfileMap, OsmWay } from './utils/types'
import { Sentry } from './sentry'

type UiState = 'search' | 'place-detail' | 'routing'

const HOME_PLACE: Place = {
  lat: 52.5016,
  lng: 13.4103,
  label: 'Dresdener Str 112, Berlin',
  shortLabel: 'Dresdener Str 112',
}

const SCHOOL_PLACE: Place = {
  lat: 52.5105,
  lng: 13.4247,
  label: 'Wilhelmine-Gemberg-Weg 10, Berlin',
  shortLabel: 'Wilhelmine-Gemberg-Weg 10',
}

const STORAGE_KEY = 'bike-route-profiles'
const CUSTOM_PREFERRED_KEY = 'bike-route-custom-preferred'
const TRAVEL_MODE_KEY = 'bike-route-travel-mode'

function loadProfiles(): ProfileMap {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as ProfileMap
      return { ...DEFAULT_PROFILES, ...parsed }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_PROFILES }
}

function saveProfiles(profiles: ProfileMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles))
  } catch { /* ignore */ }
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) if (!b.has(item)) return false
  return true
}

/** Read initial profile + preferred items from URL params, then localStorage, then defaults. */
function getInitialState(): { profileKey: string; preferredItems: Set<string>; showOtherPaths: boolean } {
  const params = new URLSearchParams(window.location.search)
  const modeParam = params.get('travelMode')
  const preferredParam = params.get('preferred')
  const showOtherParam = params.get('showOther')

  const showOtherPaths = showOtherParam === '1'

  // URL preferred param takes top priority
  if (preferredParam !== null) {
    const items = new Set(preferredParam.split(',').filter(Boolean))
    const profile = (modeParam && DEFAULT_PROFILES[modeParam]) ? modeParam : 'toddler'
    return { profileKey: profile, preferredItems: items, showOtherPaths }
  }

  // URL travel mode param (no custom preferred)
  if (modeParam && DEFAULT_PROFILES[modeParam]) {
    return { profileKey: modeParam, preferredItems: getDefaultPreferredItems(modeParam), showOtherPaths }
  }

  // Fall back to localStorage
  try {
    const savedMode = localStorage.getItem(TRAVEL_MODE_KEY)
    const savedCustom = localStorage.getItem(CUSTOM_PREFERRED_KEY)
    if (savedCustom) {
      const items = new Set(JSON.parse(savedCustom) as string[])
      const profile = (savedMode && DEFAULT_PROFILES[savedMode]) ? savedMode : 'toddler'
      return { profileKey: profile, preferredItems: items, showOtherPaths }
    }
    if (savedMode && DEFAULT_PROFILES[savedMode]) {
      return { profileKey: savedMode, preferredItems: getDefaultPreferredItems(savedMode), showOtherPaths }
    }
  } catch { /* ignore */ }

  return { profileKey: 'toddler', preferredItems: getDefaultPreferredItems('toddler'), showOtherPaths }
}

/** Resolve the user's current location as a Place (async, returns null on failure). */
async function resolveCurrentLocation(): Promise<Place | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve(null); return }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords
        const geocoded = await reverseGeocode(lat, lng)
        resolve({
          lat,
          lng,
          label: geocoded?.label ?? 'Current Location',
          shortLabel: geocoded?.shortLabel ?? 'Current Location',
        })
      },
      () => resolve(null),
    )
  })
}

const TILE_DEGREES = 0.1

/** Inject OsmWay[] from a cached region into the in-memory overpass tile cache. */
function injectRegionIntoTileCache(
  ways: OsmWay[],
  bbox: { south: number; west: number; north: number; east: number },
): void {
  // Group ways by tile
  // Group ways by tile. Use a plain object instead of Map to avoid shadowed Map.
  const tileMap: Record<string, OsmWay[]> = {}
  const minRow = Math.floor(bbox.south / TILE_DEGREES)
  const maxRow = Math.floor(bbox.north / TILE_DEGREES)
  const minCol = Math.floor(bbox.west / TILE_DEGREES)
  const maxCol = Math.floor(bbox.east / TILE_DEGREES)

  // Initialize all tiles in the bbox (even empty ones) so the router
  // doesn't try to fetch them from Overpass
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      tileMap[tileKey(r, c)] = []
    }
  }

  // Assign each way to its tile based on first coordinate
  for (const way of ways) {
    if (way.coordinates.length === 0) continue
    const [lat, lng] = way.coordinates[0]
    const tile = latLngToTile(lat, lng)
    const key = tileKey(tile.row, tile.col)
    if (tileMap[key]) tileMap[key].push(way)
    else tileMap[key] = [way]
  }

  // Inject into the in-memory cache
  for (const key of Object.keys(tileMap)) {
    const [rowStr, colStr] = key.split(':')
    injectCachedTile(parseInt(rowStr), parseInt(colStr), tileMap[key])
  }
}

export default function App() {
  const [profiles, setProfiles] = useState<ProfileMap>(loadProfiles)

  const initialState = getInitialState()
  const [selectedProfile, setSelectedProfile] = useState(initialState.profileKey)
  const [preferredItemNames, setPreferredItemNames] = useState<Set<string>>(
    () => initialState.preferredItems
  )
  const [showOtherPaths, setShowOtherPaths] = useState(initialState.showOtherPaths)



  // --- UI state machine ---
  const [uiState, setUiState] = useState<UiState>('search')
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null)

  const [startPoint, setStartPoint] = useState<Place | null>(null)
  const [endPoint, setEndPoint]     = useState<Place | null>(null)
  const [waypoints, setWaypoints]   = useState<Array<{ lat: number; lng: number }>>([])

  const { location: currentLocation } = useGeolocation()

  const [routes, setRoutes]                   = useState<Route[]>([])
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  // Derived: the currently selected route (or null if none)
  const route = routes[selectedRouteIndex] ?? null

  const overlayEnabled = true
  const [overlayStatus, setOverlayStatus]   = useState('idle')
  const [auditOpen, setAuditOpen]           = useState(false)

  // Region classification rules (fetched from KV based on map viewport)
  const [regionRules, setRegionRules] = useState<ClassificationRule[]>([])
  const [activeRegion, setActiveRegion] = useState<string | null>(null)

  // Tile cache state
  const [tileCacheBanner, setTileCacheBanner] = useState<{
    show: boolean
    regionName: string
    bbox: { south: number; west: number; north: number; east: number }
  } | null>(null)
  const [tileCacheProgress, setTileCacheProgress] = useState<number | null>(null)
  const tileCacheCheckedRef = useRef(false)

  // Rectangle draw mode + cached regions display
  const [drawingCache, setDrawingCache] = useState(false)
  const [cachedRegions, setCachedRegions] = useState<CachedRegion[]>([])

  // Search-triggered cache banner (separate from initial load banner)
  const [searchCacheBanner, setSearchCacheBanner] = useState<{
    lat: number; lng: number
  } | null>(null)

  // Detect which city preset the map center falls within
  useEffect(() => {
    const loc = currentLocation ?? { lat: 52.52, lng: 13.405 } // default Berlin
    const match = CITY_PRESETS.find((c) =>
      loc.lat >= c.bbox.south && loc.lat <= c.bbox.north &&
      loc.lng >= c.bbox.west && loc.lng <= c.bbox.east
    )
    const region = match ? match.name.toLowerCase() : null
    if (region && region !== activeRegion) {
      setActiveRegion(region)
      fetchRules(region).then((r) => setRegionRules(r.rules))
        .catch(() => { /* ignore */ })
    }
  }, [currentLocation, activeRegion])

  // On app load: check if current location is inside a cached region.
  // If cached, load tiles from IndexedDB. If not, show download banner.
  useEffect(() => {
    if (tileCacheCheckedRef.current) return
    tileCacheCheckedRef.current = true

    const loc = currentLocation ?? { lat: 52.52, lng: 13.405 }
    void (async () => {
      try {
        const { cached, regionName } = await isLocationCached(loc.lat, loc.lng, 2)
        if (cached && regionName) {
          // Load from IndexedDB into in-memory tile cache
          const region = await loadRegion(regionName)
          if (region) {
            injectRegionIntoTileCache(region.ways, region.bbox)
          }
        } else {
          // Show download banner
          const detected = detectRegion(loc.lat, loc.lng)
          setTileCacheBanner({ show: true, regionName: detected.name, bbox: detected.bbox })
        }
      } catch {
        // IndexedDB failure is non-critical
      }
    })()
  }, [currentLocation]) // eslint-disable-line react-hooks/exhaustive-deps

  async function handleDownloadTiles() {
    if (!tileCacheBanner) return
    const { regionName, bbox } = tileCacheBanner
    setTileCacheBanner(null)
    setTileCacheProgress(0)

    try {
      const ways = await prefetchTiles(bbox, (pct) => setTileCacheProgress(pct))
      await saveRegion(regionName, bbox, ways)
      injectRegionIntoTileCache(ways, bbox)
    } catch {
      // Download failure is non-critical
    } finally {
      setTileCacheProgress(null)
    }
  }

  // Load cached regions list on mount
  useEffect(() => {
    getAllRegions().then((regions) => {
      // Strip ways for lightweight state (only need name + bbox + savedAt)
      setCachedRegions(regions.map((r) => ({ ...r, ways: [] })))
    }).catch(() => { /* ignore */ })
  }, [])

  function refreshCachedRegionsList() {
    getAllRegions().then((regions) => {
      setCachedRegions(regions.map((r) => ({ ...r, ways: [] })))
    }).catch(() => { /* ignore */ })
  }

  /** Handle rectangle draw confirm: download tiles for the drawn bbox. */
  async function handleDrawConfirm(bbox: { south: number; west: number; north: number; east: number }) {
    setDrawingCache(false)
    setTileCacheProgress(0)

    const centerLat = (bbox.south + bbox.north) / 2
    const centerLng = (bbox.west + bbox.east) / 2
    const detected = detectRegion(centerLat, centerLng)
    const regionName = detected.name

    try {
      const ways = await prefetchTiles(bbox, (pct) => setTileCacheProgress(pct))
      await saveRegion(regionName, bbox, ways)
      injectRegionIntoTileCache(ways, bbox)
      refreshCachedRegionsList()
    } catch {
      // Download failure is non-critical
    } finally {
      setTileCacheProgress(null)
    }
  }

  /** Handle delete of a cached region. */
  async function handleDeleteRegion(name: string) {
    try {
      await deleteRegion(name)
      refreshCachedRegionsList()
    } catch { /* ignore */ }
  }

  /** Handle refresh of a cached region: re-download tiles. */
  async function handleRefreshRegion(
    name: string,
    bbox: { south: number; west: number; north: number; east: number },
  ) {
    setTileCacheProgress(0)
    try {
      const ways = await prefetchTiles(bbox, (pct) => setTileCacheProgress(pct))
      await saveRegion(name, bbox, ways)
      injectRegionIntoTileCache(ways, bbox)
      refreshCachedRegionsList()
    } catch { /* ignore */ }
    finally { setTileCacheProgress(null) }
  }

  /** Check if a destination is cached; if not, show the search cache banner. */
  async function checkLocationCache(lat: number, lng: number) {
    try {
      const { cached } = await isLocationCached(lat, lng, 3)
      if (!cached) {
        setSearchCacheBanner({ lat, lng })
      }
    } catch { /* ignore */ }
  }

  /** Download 3km radius around the search banner target. */
  async function handleSearchBannerDownload() {
    if (!searchCacheBanner) return
    const { lat, lng } = searchCacheBanner
    setSearchCacheBanner(null)
    setTileCacheProgress(0)
    const bbox = bboxFromCenter(lat, lng, 3)
    const detected = detectRegion(lat, lng)
    try {
      const ways = await prefetchTiles(bbox, (pct) => setTileCacheProgress(pct))
      await saveRegion(detected.name, bbox, ways)
      injectRegionIntoTileCache(ways, bbox)
      refreshCachedRegionsList()
    } catch { /* ignore */ }
    finally { setTileCacheProgress(null) }
  }

  // Derived: has the user customized their travel mode's preferred path types?
  const isCustomTravelMode = !setsEqual(preferredItemNames, getDefaultPreferredItems(selectedProfile))

  // Sync URL params and localStorage on every state change
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set('travelMode', selectedProfile)
    if (isCustomTravelMode) {
      params.set('preferred', [...preferredItemNames].join(','))
    } else {
      params.delete('preferred')
    }
    if (showOtherPaths) {
      params.set('showOther', '1')
    } else {
      params.delete('showOther')
    }
    window.history.replaceState({}, '', `?${params.toString()}`)

    try {
      localStorage.setItem(TRAVEL_MODE_KEY, selectedProfile)
      if (isCustomTravelMode) {
        localStorage.setItem(CUSTOM_PREFERRED_KEY, JSON.stringify([...preferredItemNames]))
      } else {
        localStorage.removeItem(CUSTOM_PREFERRED_KEY)
      }
    } catch { /* ignore */ }
  }, [selectedProfile, preferredItemNames, isCustomTravelMode, showOtherPaths])

  useEffect(() => {
    saveProfiles(profiles)
  }, [profiles])

  // Re-route when preferred items change so costing reflects the new preferences.
  const preferencesMountedRef = useRef(false)
  useEffect(() => {
    if (!preferencesMountedRef.current) { preferencesMountedRef.current = true; return }
    if (startPoint && endPoint) void computeRoute(startPoint, endPoint, selectedProfile, waypoints)
  }, [preferredItemNames]) // eslint-disable-line react-hooks/exhaustive-deps

  function moveToPreferred(name: string) {
    setPreferredItemNames((prev) => new Set([...prev, name]))
  }

  function moveToOther(name: string) {
    setPreferredItemNames((prev) => {
      const next = new Set(prev)
      next.delete(name)
      return next
    })
  }

  async function computeRoute(
    start: Place,
    end: Place,
    profileKey: string,
    wps: Array<{ lat: number; lng: number }>,
  ) {
    const profile = profiles[profileKey]
    if (!profile) return

    setIsLoading(true)
    setError(null)
    setRoutes([])
    setSelectedRouteIndex(0)

    try {
      // Try client-side router first (no waypoint support yet)
      let clientResult: Route | null = null
      if (wps.length === 0) {
        try {
          clientResult = await clientRoute(
            start.lat, start.lng, end.lat, end.lng,
            profileKey, preferredItemNames, regionRules,
          )
        } catch {
          // Client router failure is non-critical — fall back to Valhalla
        }
      }

      const costingOptions = getCostingFromPreferences(preferredItemNames, profileKey, profile)
      const valhallaResults = await getRoute(start, end, { ...profile, costingOptions }, wps, 0)
      // Tag Valhalla routes with engine
      const taggedValhalla = valhallaResults.map((r) => ({ ...r, engine: 'valhalla' }))

      // Client router is primary when it succeeds; Valhalla is fallback only
      const initialRoutes = clientResult
        ? [clientResult]
        : taggedValhalla
      setRoutes(initialRoutes)

      // Fire-and-forget route log for each route
      for (const result of initialRoutes) {
        logRoute({
          startLat: start.lat,
          startLng: start.lng,
          startLabel: start.label,
          endLat: end.lat,
          endLng: end.lng,
          endLabel: end.label,
          travelMode: profileKey,
          engine: result.engine ?? 'unknown',
          distanceM: Math.round(result.summary.distance * 1000),
          durationS: Math.round(result.summary.duration),
        })
      }

      // Enrich each route with segments, then reorder: "best" route first
      // (highest preferred %) as long as it's within 20% of fastest time.
      Promise.all(initialRoutes.map(async (result) => {
        const rawSegments = await scoreRoute(result.coordinates, profileKey, regionRules)
        const segments = healSegmentGaps(rawSegments, preferredItemNames)
        return segments.length ? { ...result, segments } : result
      })).then((scored) => {
        const fastest = Math.min(...scored.map((r) => r.summary.duration))
        const maxDuration = fastest * 1.75  // accept 75% longer for safer routes

        // Sort: highest preferred % first, but only if within 20% of fastest
        const reordered = [...scored].sort((a, b) => {
          const aQuality = a.segments ? computeRouteQuality(a.segments, preferredItemNames) : null
          const bQuality = b.segments ? computeRouteQuality(b.segments, preferredItemNames) : null
          const aPref = aQuality?.preferred ?? 0
          const bPref = bQuality?.preferred ?? 0
          const aEligible = a.summary.duration <= maxDuration
          const bEligible = b.summary.duration <= maxDuration
          // Eligible routes first, then by preferred % descending
          if (aEligible && !bEligible) return -1
          if (!aEligible && bEligible) return 1
          return bPref - aPref
        })

        setRoutes(reordered)
        setSelectedRouteIndex(0)
      })

      // BRouter comparison routes — disabled in single-route mode
      // TODO: re-enable when routing mode toggle is added to settings
      false && getBRouterRoutes(start, end, profileKey).then((brouterResults) => {
        // Log BRouter routes
        for (const result of brouterResults) {
          logRoute({
            startLat: start.lat,
            startLng: start.lng,
            startLabel: start.label,
            endLat: end.lat,
            endLng: end.lng,
            endLabel: end.label,
            travelMode: profileKey,
            engine: 'brouter',
            distanceM: Math.round(result.summary.distance * 1000),
            durationS: Math.round(result.summary.duration),
          })
        }
        setRoutes((prev) => [...prev, ...brouterResults])
        // Score BRouter routes with the unified scorer too
        for (const result of brouterResults) {
          const coords = result.coordinates
          scoreRoute(coords, profileKey, regionRules).then((rawSegs) => {
            const segments = healSegmentGaps(rawSegs, preferredItemNames)
            if (segments.length) {
              setRoutes((prev) => prev.map((r) => r.coordinates === coords ? { ...r, segments } : r))
            }
          })
        }
      }).catch(() => {
        // BRouter failure is non-critical — Valhalla routes still available
      })
    } catch (e) {
      const msg = (e as Error).message ?? 'Could not find a route'
      setError(msg)
      Sentry.captureException(e, { extra: { profileKey, start: `${start.lat},${start.lng}`, end: `${end.lat},${end.lng}` } })
    } finally {
      setIsLoading(false)
    }
  }

  // --- Transition: search → place-detail ---
  function handlePlaceSelect(place: Place) {
    setSelectedPlace(place)
    setUiState('place-detail')
    void checkLocationCache(place.lat, place.lng)
  }

  // --- Start routing to a destination from current location ---
  async function startRoutingTo(destination: Place) {
    setEndPoint(destination)
    setUiState('routing')

    // Use the already-tracked location if available (instant, no extra prompt),
    // otherwise fall back to a one-shot geolocation request.
    let loc: Place | null = null
    if (currentLocation) {
      const geocoded = await reverseGeocode(currentLocation.lat, currentLocation.lng)
      loc = {
        ...currentLocation,
        label: geocoded?.label ?? 'Current Location',
        shortLabel: geocoded?.shortLabel ?? 'Current Location',
      }
    } else {
      loc = await resolveCurrentLocation()
    }

    if (loc) {
      setStartPoint(loc)
      void computeRoute(loc, destination, selectedProfile, waypoints)
    }
  }

  function handleDirectionsFromPlace() {
    if (selectedPlace) startRoutingTo(selectedPlace)
  }

  // --- Routing mode: start/end selection ---
  function handleStartSelect(place: Place) {
    setStartPoint(place)
    if (endPoint) computeRoute(place, endPoint, selectedProfile, waypoints)
  }

  function handleEndSelect(place: Place) {
    setEndPoint(place)
    if (startPoint) computeRoute(startPoint, place, selectedProfile, waypoints)
  }


  function handleProfileChange(key: string) {
    setSelectedProfile(key)
    // Reset preferred items to this travel mode's defaults
    setPreferredItemNames(getDefaultPreferredItems(key))
    if (startPoint && endPoint) computeRoute(startPoint, endPoint, key, waypoints)
  }

  function handleSwap() {
    const newStart = endPoint
    const newEnd = startPoint
    setStartPoint(newStart)
    setEndPoint(newEnd)
    setWaypoints([...waypoints].reverse())
    if (newStart && newEnd) void computeRoute(newStart, newEnd, selectedProfile, [...waypoints].reverse())
  }

  const routeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function debouncedComputeRoute(wps: Array<{ lat: number; lng: number }>) {
    if (routeDebounceRef.current) clearTimeout(routeDebounceRef.current)
    routeDebounceRef.current = setTimeout(() => {
      if (startPoint && endPoint) computeRoute(startPoint, endPoint, selectedProfile, wps)
    }, 800)
  }

  function handleRemoveWaypoint(index: number) {
    const newWps = waypoints.filter((_, i) => i !== index)
    setWaypoints(newWps)
    debouncedComputeRoute(newWps)
  }

  function handleAddWaypoint(lat: number, lng: number) {
    const newWps = [...waypoints, { lat, lng }]
    setWaypoints(newWps)
    debouncedComputeRoute(newWps)
  }

  // --- Back to search ---
  function backToSearch() {
    setRoutes([])
    setSelectedRouteIndex(0)
    setStartPoint(null)
    setEndPoint(null)
    setSelectedPlace(null)
    setError(null)
    setUiState('search')
  }



  const overlayStatusMsg =
    overlayStatus === 'loading' ? '⏳ Loading bike map…' :
    overlayStatus === 'zoom'    ? '🔍 Zoom in to see bike infrastructure' :
    overlayStatus === 'error'   ? '⚠️ Could not load bike map — pan or zoom to retry' :
    null

  // Quick options for search (initial state): shortcuts route directly
  const searchQuickOptions: QuickOption[] = [
    {
      label: 'Home',
      icon: '🏠',
      onSelect: () => startRoutingTo(HOME_PLACE),
    },
    {
      label: 'School',
      icon: '🏫',
      onSelect: () => startRoutingTo(SCHOOL_PLACE),
    },
  ]

  // Quick options for routing inputs: fill the field
  const startQuickOptions: QuickOption[] = [
    {
      label: 'Current Location',
      icon: '📍',
      onSelect: async () => {
        const loc = await resolveCurrentLocation()
        if (loc) handleStartSelect(loc)
      },
      isLocation: true,
    },
    {
      label: 'Home',
      icon: '🏠',
      onSelect: () => handleStartSelect(HOME_PLACE),
    },
    {
      label: 'School',
      icon: '🏫',
      onSelect: () => handleStartSelect(SCHOOL_PLACE),
    },
  ]

  const endQuickOptions: QuickOption[] = [
    {
      label: 'Current Location',
      icon: '📍',
      onSelect: async () => {
        const loc = await resolveCurrentLocation()
        if (loc) handleEndSelect(loc)
      },
      isLocation: true,
    },
    {
      label: 'Home',
      icon: '🏠',
      onSelect: () => handleEndSelect(HOME_PLACE),
    },
    {
      label: 'School',
      icon: '🏫',
      onSelect: () => handleEndSelect(SCHOOL_PLACE),
    },
  ]

  // The place to show on the map as a single marker (place-detail state)
  const flyToPlace = uiState === 'place-detail' ? selectedPlace : null

  return (
    <div className={`app ui-${uiState}`}>
      <div className="map-wrap">
        <Suspense fallback={<div className="map-loading" />}>
          <Map
            startPoint={uiState === 'routing' ? startPoint : null}
            endPoint={uiState === 'routing' ? endPoint : null}
            route={route}
            routes={routes}
            selectedRouteIndex={selectedRouteIndex}
            onSelectRoute={setSelectedRouteIndex}
            waypoints={waypoints}
            onRemoveWaypoint={handleRemoveWaypoint}
            onAddWaypoint={uiState === 'routing' && route && route.engine === 'valhalla' ? handleAddWaypoint : undefined}
            overlayEnabled={overlayEnabled}
            profileKey={selectedProfile}
            onOverlayStatusChange={setOverlayStatus}
            currentLocation={currentLocation}
            preferredItemNames={preferredItemNames}
            showOtherPaths={showOtherPaths}
            flyToPlace={flyToPlace}
            regionRules={regionRules}
            drawingCache={drawingCache}
            onDrawConfirm={handleDrawConfirm}
            onDrawCancel={() => setDrawingCache(false)}
            cachedRegions={cachedRegions}
            onDeleteRegion={handleDeleteRegion}
            onRefreshRegion={handleRefreshRegion}
          />
        </Suspense>

        {/* Travel mode selector — only on map when NOT routing (routing state has it in the panel) */}
        {uiState !== 'routing' && (
          <div className="map-travel-mode">
            <ProfileSelector
              profiles={profiles}
              selected={selectedProfile}
              onSelect={handleProfileChange}
              isCustomTravelMode={isCustomTravelMode}
            />
          </div>
        )}

        {/* Legend (hidden during routing on mobile via CSS) */}
        <div className="map-legend-wrap">
          <Legend
            segments={route?.segments ?? null}
            overlayOn={overlayEnabled}
            profileKey={selectedProfile}
            preferredItemNames={preferredItemNames}
            onMoveToPreferred={moveToPreferred}
            onMoveToOther={moveToOther}
            showOtherPaths={showOtherPaths}
            onToggleOtherPaths={() => setShowOtherPaths((v) => !v)}
          />
        </div>

        {/* Bike layer status + audit gear + download area button */}
        <div className="map-bike-layer-toggle">
          <div className="map-bike-layer-buttons">
            <button
              className="audit-gear-btn"
              onClick={() => setAuditOpen(true)}
              title="Classification audit"
            >
              ⚙️
            </button>
            <button
              className={`cache-draw-btn${drawingCache ? ' cache-draw-btn-active' : ''}`}
              onClick={() => setDrawingCache((v) => !v)}
              title={drawingCache ? 'Cancel drawing' : 'Download area'}
            >
              {drawingCache ? 'Cancel' : 'DL'}
            </button>
          </div>
          {drawingCache && <p className="bike-layer-status">Draw a rectangle on the map</p>}
          {overlayStatusMsg && !drawingCache && <p className="bike-layer-status">{overlayStatusMsg}</p>}
        </div>

        {/* Tile cache download banner */}
        {tileCacheBanner?.show && (
          <div className="download-banner">
            <p className="download-banner-text">Download cycling data for {tileCacheBanner.regionName}? (~30 seconds)</p>
            <div className="download-banner-actions">
              <button
                className="download-banner-dismiss"
                onClick={() => setTileCacheBanner(null)}
              >
                Dismiss
              </button>
              <button className="download-banner-btn" onClick={handleDownloadTiles}>
                Download
              </button>
            </div>
          </div>
        )}

        {/* Tile cache download progress */}
        {tileCacheProgress !== null && (
          <div className="download-banner">
            <p className="download-banner-text">Downloading cycling data... {tileCacheProgress}%</p>
            <div className="download-banner-progress">
              <div className="download-banner-fill" style={{ width: `${tileCacheProgress}%` }} />
            </div>
          </div>
        )}

        {/* Search-triggered cache banner */}
        {searchCacheBanner && !tileCacheProgress && !tileCacheBanner?.show && (
          <div className="download-banner">
            <p className="download-banner-text">This area hasn't been cached. Download for better routing?</p>
            <div className="download-banner-actions">
              <button
                className="download-banner-dismiss"
                onClick={() => setSearchCacheBanner(null)}
              >
                Dismiss
              </button>
              <button className="download-banner-btn" onClick={handleSearchBannerDownload}>
                Download
              </button>
            </div>
          </div>
        )}

        {/* --- Floating UI card (changes per uiState) --- */}

        {/* SEARCH state: compact search bar */}
        {uiState === 'search' && (
          <div className="floating-card floating-search">
            <SearchBar
              label=""
              value={null}
              onSelect={handlePlaceSelect}
              placeholder="Search a place…"
              quickOptions={searchQuickOptions}
              biasPoint={currentLocation ?? undefined}
            />
          </div>
        )}

        {/* PLACE DETAIL state: bottom card with place info */}
        {uiState === 'place-detail' && selectedPlace && (
          <div className="floating-card floating-place-detail">
            <PlaceCard
              place={selectedPlace}
              onDirections={handleDirectionsFromPlace}
              onBack={backToSearch}
            />
          </div>
        )}

        {/* ROUTING state: top header + bottom summary */}
        {uiState === 'routing' && (
          <>
            <div className="floating-card floating-routing-header">
              <button className="routing-back-btn" onClick={backToSearch} aria-label="Back to search">←</button>
              <RoutingHeader
                startPoint={startPoint}
                endPoint={endPoint}
                onStartSelect={handleStartSelect}
                onEndSelect={handleEndSelect}
                onStartClear={() => { setStartPoint(null); setRoutes([]) }}
                onEndClear={() => { setEndPoint(null); setRoutes([]) }}
                onSwap={handleSwap}
                startQuickOptions={startQuickOptions}
                endQuickOptions={endQuickOptions}
              />
            </div>

            {isLoading && (
              <div className="floating-card floating-loading">
                <div className="spinner" />
                <span>Calculating route…</span>
              </div>
            )}

            {error && <div className="floating-card floating-error">⚠️ {error}</div>}

            {route && !isLoading && (
              <div className="floating-card floating-route-summary">
                <div className="route-panel-header">
                  <ProfileSelector
                    profiles={profiles}
                    selected={selectedProfile}
                    onSelect={handleProfileChange}
                    isCustomTravelMode={isCustomTravelMode}
                  />
                  <DirectionsPanel
                    route={route}
                    onClose={backToSearch}
                    preferredItemNames={preferredItemNames}
                    currentLocation={currentLocation}
                    travelMode={selectedProfile}
                    compact
                  />
                </div>
                <RouteList
                  routes={routes}
                  selectedIndex={selectedRouteIndex}
                  onSelect={setSelectedRouteIndex}
                  preferredItemNames={preferredItemNames}
                />
              </div>
            )}
          </>
        )}
      </div>

      {auditOpen && (
        <Suspense fallback={null}>
          <AuditPanel onClose={() => setAuditOpen(false)} />
        </Suspense>
      )}
    </div>
  )
}
