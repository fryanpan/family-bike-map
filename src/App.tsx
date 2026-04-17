import { useState, useEffect, useRef, useMemo, useCallback, lazy, Suspense } from 'react'
import { useGeolocation } from './hooks/useGeolocation'
const Map = lazy(() => import('./components/Map'))
const AuditPanel = lazy(() => import('./components/AuditPanel'))
import Legend from './components/Legend'
import SearchBar from './components/SearchBar'
import type { QuickOption } from './components/SearchBar'
import PlaceCard from './components/PlaceCard'
import RoutingHeader from './components/RoutingHeader'
import FlagSegmentModal from './components/FlagSegmentModal'
import PreferencesModal from './components/PreferencesModal'
import { saveFeedbackEntry, type FeedbackVerdict } from './services/feedbackQueue'
import { loadActivePreference } from './services/preferencesStore'
import type { RiderPreference } from './data/preferences'
import ProfileSelector from './components/ProfileSelector'
import DirectionsPanel from './components/DirectionsPanel'
import { DEFAULT_PROFILES } from './data/profiles'
import { scoreRoute } from './services/routeScorer'
import { clientRoute } from './services/clientRouter'
import { primeInMemoryCacheFromIdb, latLngToTile, getCachedTile } from './services/overpass'
import { logRoute } from './services/routeLog'
import { reverseGeocode } from './services/geocoding'
import {
  healSegmentGaps,
  getDefaultPreferredItems,
  computeRouteQuality,
} from './utils/classify'
import { CITY_PRESETS } from './services/audit'
import { fetchRules } from './services/rules'
import type { ClassificationRule } from './services/rules'
import { BERLIN_PROFILE } from './data/cityProfiles/berlin'
import RouteList from './components/RouteList'
import type { Place, Route, RouteSegment, ProfileMap } from './utils/types'
import { Sentry } from './sentry'

type UiState = 'search' | 'place-detail' | 'routing'

// User-settable Home and School. No defaults — first-time users see a
// "Tap to add" hint until they search for a place and save it from the
// place card. The full Place (with geocoded lat/lng from Nominatim) is
// persisted in localStorage so subsequent sessions have exact coords.
const STORAGE_KEY = 'bike-route-profiles'
const CUSTOM_PREFERRED_KEY = 'bike-route-custom-preferred'
const TRAVEL_MODE_KEY = 'bike-route-travel-mode'
const HOME_KEY = 'bike-route-home'
const SCHOOL_KEY = 'bike-route-school'

function loadSavedPlace(key: string): Place | null {
  try {
    const saved = localStorage.getItem(key)
    if (!saved) return null
    const parsed = JSON.parse(saved) as Place
    if (typeof parsed.lat === 'number' && typeof parsed.lng === 'number' && parsed.label) {
      return parsed
    }
  } catch {
    // fall through
  }
  return null
}

const ADD_HOME_HINT = 'To add a home, search for a place and tap "Save as Home" on the place card.'
const ADD_SCHOOL_HINT = 'To add a school, search for a place and tap "Save as School" on the place card.'

function loadProfiles(): ProfileMap {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved) as ProfileMap
      // Only merge overrides for profile keys that still exist in the
      // current DEFAULT_PROFILES. Cached profiles with stale keys
      // (e.g. `toddler`, `trailer` from before the 5-mode rename) are
      // silently dropped — we never want them to appear as extra chips.
      const merged: ProfileMap = { ...DEFAULT_PROFILES }
      for (const key of Object.keys(DEFAULT_PROFILES)) {
        if (parsed[key]) merged[key] = parsed[key]
      }
      return merged
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
    const profile = (modeParam && DEFAULT_PROFILES[modeParam]) ? modeParam : 'kid-starting-out'
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
      const profile = (savedMode && DEFAULT_PROFILES[savedMode]) ? savedMode : 'kid-starting-out'
      return { profileKey: profile, preferredItems: items, showOtherPaths }
    }
    if (savedMode && DEFAULT_PROFILES[savedMode]) {
      return { profileKey: savedMode, preferredItems: getDefaultPreferredItems(savedMode), showOtherPaths }
    }
  } catch { /* ignore */ }

  return { profileKey: 'kid-starting-out', preferredItems: getDefaultPreferredItems('kid-starting-out'), showOtherPaths }
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

  // Session-scoped avoid list — OSM way IDs the user has asked to reroute
  // around via the "Reroute around this" action on a route segment.
  // Cleared when the user exits routing state.
  const [avoidedWayIds, setAvoidedWayIds] = useState<Set<number>>(new Set())

  // Segment flag modal state
  const [flagSegmentTarget, setFlagSegmentTarget] = useState<RouteSegment | null>(null)

  // Active rider preference (Layer 3). Null on first load until the
  // user saves + activates one via the PreferencesModal.
  const [activePreference, setActivePreference] = useState<RiderPreference | null>(() => loadActivePreference())
  const [prefsModalOpen, setPrefsModalOpen] = useState(false)
  const refreshActivePreference = useCallback(() => {
    setActivePreference(loadActivePreference())
  }, [])

  // User-configurable home/school. Null on first launch; set via the
  // "Save as Home/School" button in the place card. Persisted to
  // localStorage with full geocoded lat/lng so exact coords survive
  // across sessions.
  const [homePlace, setHomePlace]     = useState<Place | null>(() => loadSavedPlace(HOME_KEY))
  const [schoolPlace, setSchoolPlace] = useState<Place | null>(() => loadSavedPlace(SCHOOL_KEY))

  const saveHomePlace = useCallback((place: Place) => {
    setHomePlace(place)
    try { localStorage.setItem(HOME_KEY, JSON.stringify(place)) } catch { /* quota */ }
  }, [])
  const saveSchoolPlace = useCallback((place: Place) => {
    setSchoolPlace(place)
    try { localStorage.setItem(SCHOOL_KEY, JSON.stringify(place)) } catch { /* quota */ }
  }, [])

  // Mobile preview mode: ?mobile=1 (iPhone 16 Pro Max), ?mobile=pixel
  // (Pixel 10 Pro), or ?mobile=WIDTHxHEIGHT. Wraps #root in a phone-sized
  // frame and disables desktop @media rules via body.mobile-preview.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const val = params.get('mobile')
    if (!val) return

    const PRESETS: Record<string, [number, number, string]> = {
      '1':      [430, 932, 'iPhone 16 Pro Max'],
      'iphone': [430, 932, 'iPhone 16 Pro Max'],
      'pixel':  [412, 914, 'Pixel 10 Pro'],
      'se':     [375, 667, 'iPhone SE'],
    }

    let w = 430, h = 932, label = 'iPhone 16 Pro Max'
    const preset = PRESETS[val]
    if (preset) {
      [w, h, label] = preset
    } else {
      const m = val.match(/^(\d+)x(\d+)$/)
      if (m) { w = parseInt(m[1]); h = parseInt(m[2]); label = `${w}×${h}` }
    }

    document.body.classList.add('mobile-preview')
    document.documentElement.style.setProperty('--mobile-preview-w', `${w}px`)
    document.documentElement.style.setProperty('--mobile-preview-h', `${h}px`)

    const tag = document.createElement('div')
    tag.className = 'mobile-preview-label'
    tag.textContent = `📱 ${label} preview`
    tag.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);color:#fff;font-size:12px;font-weight:600;background:rgba(0,0,0,.6);padding:4px 10px;border-radius:8px;z-index:10000;pointer-events:none;'
    document.body.appendChild(tag)

    return () => {
      document.body.classList.remove('mobile-preview')
      tag.remove()
    }
  }, [])

  const { location: currentLocation } = useGeolocation()

  const [routes, setRoutes]                   = useState<Route[]>([])
  const [selectedRouteIndex, setSelectedRouteIndex] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  // Derived: the currently selected route (or null if none)
  const route = routes[selectedRouteIndex] ?? null

  // The overlay is always wanted, but we gate it until the per-tile IDB
  // prime has finished so the first loadVisibleTiles pass can read already-
  // fetched tiles from the warmed _tileCache rather than round-tripping to
  // Overpass for tiles we already have on disk. See commit message for the
  // race-condition rationale.
  const [idbReady, setIdbReady] = useState(false)
  const overlayEnabled = idbReady
  const [overlayStatus, setOverlayStatus]   = useState('idle')
  const [auditOpen, setAuditOpen]           = useState(() => {
    const params = new URLSearchParams(window.location.search)
    return params.has('admin')
  })

  // Region classification rules (fetched from KV based on map viewport)
  const [regionRules, setRegionRules] = useState<ClassificationRule[]>([])
  const [activeRegion, setActiveRegion] = useState<string | null>(null)

  // Layer 2 region overlay (hard-coded per-city rules that adjust the
  // LtsClassification between classifyEdge and applyModeRule). Only
  // Berlin is implemented today — other cities fall through with
  // regionProfile = null.
  const regionProfile = useMemo(() => {
    if (activeRegion === 'berlin') return BERLIN_PROFILE
    return null
  }, [activeRegion])

  // Tile cache state. The client router lazy-fetches tiles on demand, so
  // there is no longer an "auto-show download banner" flow. Power users can
  const tileCacheCheckedRef = useRef(false)

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

  // On app load: prime the in-memory cache from the lazy per-tile
  // IndexedDB store (src/services/tileStore.ts), so any tile the user
  // has visited in the last 30 days is available instantly on this
  // session's first render.
  //
  // The overlay is gated on idbReady — it only starts fetching once the
  // per-tile IDB prime has finished (or failed), so OverlayController's
  // initial loadVisibleTiles call reads from a warmed _tileCache instead
  // of racing IDB with Overpass.
  useEffect(() => {
    if (tileCacheCheckedRef.current) return
    tileCacheCheckedRef.current = true

    void (async () => {
      try {
        await primeInMemoryCacheFromIdb()
      } catch {
        // IndexedDB failure is non-critical
      } finally {
        setIdbReady(true)
      }
    })()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

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
    avoidOverride?: Set<number>,
  ) {
    const profile = profiles[profileKey]
    if (!profile) return

    // When rerouteAroundSegment triggers a recompute it passes the
    // just-updated avoid set explicitly so we don't read a stale closure
    // value of `avoidedWayIds` here. Falls back to the state otherwise.
    const avoids = avoidOverride ?? avoidedWayIds

    setIsLoading(true)
    setError(null)
    setRoutes([])
    setSelectedRouteIndex(0)

    try {
      // Client-side router is the only routing path. If the user has waypoints,
      // we chain single-leg clientRoute calls through each waypoint in order and
      // concatenate the results. Valhalla and BRouter are benchmark-only now.
      const legPoints: Array<{ lat: number; lng: number }> = [
        { lat: start.lat, lng: start.lng },
        ...wps,
        { lat: end.lat, lng: end.lng },
      ]

      const legs: Route[] = []
      for (let i = 0; i < legPoints.length - 1; i++) {
        const a = legPoints[i]
        const b = legPoints[i + 1]
        const leg = await clientRoute(
          a.lat, a.lng, b.lat, b.lng,
          profileKey, preferredItemNames, regionRules, regionProfile, avoids,
          activePreference,
        )
        if (!leg) throw new Error('No route found for this segment')
        legs.push(leg)
      }

      const combined: Route = legs.length === 1
        ? legs[0]
        : {
            coordinates: legs.flatMap((l, i) =>
              i === 0 ? l.coordinates : l.coordinates.slice(1),
            ),
            maneuvers: legs.flatMap((l) => l.maneuvers),
            summary: {
              distance: legs.reduce((sum, l) => sum + l.summary.distance, 0),
              duration: legs.reduce((sum, l) => sum + l.summary.duration, 0),
            },
            segments: legs.flatMap((l) => l.segments ?? []),
            engine: 'client',
          }

      const initialRoutes = [combined]
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
    setAvoidedWayIds(new Set())
    setUiState('search')
  }

  // Add the OSM way IDs of a route segment to the session avoid list
  // and recompute the route. "Reroute around this" action.
  //
  // Computes the next avoid set locally and passes it explicitly to
  // computeRoute — avoids stale-closure / double-tap-race issues where
  // React hasn't flushed the setState before the recompute reads the
  // prior value.
  const rerouteAroundSegment = useCallback((wayIds: number[]) => {
    if (wayIds.length === 0 || !startPoint || !endPoint) return
    setAvoidedWayIds((prev) => {
      const next = new Set(prev)
      for (const id of wayIds) next.add(id)
      // Fire-and-forget the recompute with the just-built set. Even if
      // a second tap fires before state commits, the second call sees
      // the union of both additions because setAvoidedWayIds is a
      // reducer and next rerouteAroundSegment closes over the same prev
      // semantics.
      void computeRoute(startPoint, endPoint, selectedProfile, waypoints, next)
      return next
    })
  }, [startPoint, endPoint, selectedProfile, waypoints]) // eslint-disable-line react-hooks/exhaustive-deps



  const overlayStatusMsg =
    overlayStatus === 'loading' ? '⏳ Loading bike map…' :
    overlayStatus === 'zoom'    ? '🔍 Zoom in to see bike infrastructure' :
    overlayStatus === 'error'   ? '⚠️ Could not load bike map — pan or zoom to retry' :
    null

  // Saved-place quick option: shows "Tap to add" hint when unset,
  // otherwise invokes the given routing action with the saved place.
  const savedOption = (
    saved: Place | null,
    kind: 'Home' | 'School',
    icon: string,
    onUse: (p: Place) => void,
  ): QuickOption => ({
    label: saved ? kind : `Tap to add ${kind}`,
    icon,
    sublabel: saved ? saved.shortLabel : undefined,
    onSelect: saved
      ? () => onUse(saved)
      : () => window.alert(kind === 'Home' ? ADD_HOME_HINT : ADD_SCHOOL_HINT),
  })

  // Quick options for search (initial state): shortcuts route directly
  const searchQuickOptions: QuickOption[] = [
    savedOption(homePlace,   'Home',   '🏠', startRoutingTo),
    savedOption(schoolPlace, 'School', '🏫', startRoutingTo),
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
    savedOption(homePlace,   'Home',   '🏠', handleStartSelect),
    savedOption(schoolPlace, 'School', '🏫', handleStartSelect),
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
    savedOption(homePlace,   'Home',   '🏠', handleEndSelect),
    savedOption(schoolPlace, 'School', '🏫', handleEndSelect),
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
            onRerouteAround={uiState === 'routing' ? rerouteAroundSegment : undefined}
            onFlagSegment={uiState === 'routing' ? setFlagSegmentTarget : undefined}
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

        {/* Bike layer status + audit gear + preferences */}
        <div className="map-bike-layer-toggle">
          <div className="map-bike-layer-buttons">
            <button
              className="audit-gear-btn"
              onClick={() => setPrefsModalOpen(true)}
              title={activePreference
                ? `Personal preferences — active: ${activePreference.name}`
                : 'Personal preferences (tap to add)'}
            >
              {activePreference ? '🧑' : '🙂'}
            </button>
            <button
              className="audit-gear-btn"
              onClick={() => {
                setAuditOpen(true)
                const params = new URLSearchParams(window.location.search)
                if (!params.has('admin')) {
                  params.set('admin', 'samples')
                  window.history.pushState({}, '', `?${params.toString()}`)
                }
              }}
              title="Classification audit"
            >
              ⚙️
            </button>
          </div>
          {overlayStatusMsg && <p className="bike-layer-status">{overlayStatusMsg}</p>}
        </div>

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
              onSaveAsHome={saveHomePlace}
              onSaveAsSchool={saveSchoolPlace}
              currentHome={homePlace}
              currentSchool={schoolPlace}
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

      {prefsModalOpen && (
        <PreferencesModal
          onClose={() => setPrefsModalOpen(false)}
          onChange={refreshActivePreference}
        />
      )}

      {flagSegmentTarget && (
        <FlagSegmentModal
          seg={flagSegmentTarget}
          region={activeRegion}
          onSave={(verdict: FeedbackVerdict, note: string) => {
            // Look up the segment's first way in cached tiles so the
            // admin can later write a region rule from its tags.
            const firstWayId = flagSegmentTarget.wayIds?.[0]
            const midCoord = flagSegmentTarget.coordinates[Math.floor(flagSegmentTarget.coordinates.length / 2)]
            let currentTags: Record<string, string> = {}
            if (firstWayId != null && midCoord) {
              const { row, col } = latLngToTile(midCoord[0], midCoord[1])
              const tile = getCachedTile(row, col)
              const way = tile?.find((w) => w.osmId === firstWayId)
              if (way) currentTags = way.tags
            }
            saveFeedbackEntry({
              region: activeRegion,
              wayIds: flagSegmentTarget.wayIds ?? [],
              coordinates: flagSegmentTarget.coordinates,
              currentItemName: flagSegmentTarget.itemName,
              currentTags,
              verdict,
              note: note || undefined,
            })
          }}
          onClose={() => setFlagSegmentTarget(null)}
        />
      )}

      {auditOpen && (
        <Suspense fallback={null}>
          <AuditPanel onClose={() => {
            setAuditOpen(false)
            const params = new URLSearchParams(window.location.search)
            params.delete('admin')
            window.history.pushState({}, '', params.toString() ? `?${params.toString()}` : window.location.pathname)
          }} />
        </Suspense>
      )}
    </div>
  )
}
