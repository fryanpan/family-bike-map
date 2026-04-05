import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { useGeolocation } from './hooks/useGeolocation'
const Map = lazy(() => import('./components/Map'))
const ProfileEditor = lazy(() => import('./components/ProfileEditor'))
const AuditPanel = lazy(() => import('./components/AuditPanel'))
import Legend from './components/Legend'
import SearchBar from './components/SearchBar'
import type { QuickOption } from './components/SearchBar'
import PlaceCard from './components/PlaceCard'
import RoutingHeader from './components/RoutingHeader'
import ProfileSelector from './components/ProfileSelector'
import DirectionsPanel from './components/DirectionsPanel'
import FeedbackWidget from './components/FeedbackWidget'
import { getRoute, getRouteSegments, DEFAULT_PROFILES } from './services/routing'
import { reverseGeocode } from './services/geocoding'
import {
  getDefaultPreferredItems,
  getCostingFromPreferences,
} from './utils/classify'
import { CITY_PRESETS } from './services/audit'
import { fetchRules } from './services/rules'
import type { ClassificationRule } from './services/rules'
import type { Place, Route, ProfileMap, RiderProfile } from './utils/types'
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

export default function App() {
  const [profiles, setProfiles] = useState<ProfileMap>(loadProfiles)

  const initialState = getInitialState()
  const [selectedProfile, setSelectedProfile] = useState(initialState.profileKey)
  const [preferredItemNames, setPreferredItemNames] = useState<Set<string>>(
    () => initialState.preferredItems
  )
  const [showOtherPaths, setShowOtherPaths] = useState(initialState.showOtherPaths)

  const [editingProfile, setEditingProfile] = useState<string | null>(null)

  // --- UI state machine ---
  const [uiState, setUiState] = useState<UiState>('search')
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null)

  const [startPoint, setStartPoint] = useState<Place | null>(null)
  const [endPoint, setEndPoint]     = useState<Place | null>(null)
  const [waypoints]                 = useState<Array<{ lat: number; lng: number }>>([])

  const { location: currentLocation } = useGeolocation()

  const [route, setRoute]         = useState<Route | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  const overlayEnabled = true
  const [overlayStatus, setOverlayStatus]   = useState('idle')
  const [auditOpen, setAuditOpen]           = useState(false)

  // Region classification rules (fetched from KV based on map viewport)
  const [regionRules, setRegionRules] = useState<ClassificationRule[]>([])
  const [activeRegion, setActiveRegion] = useState<string | null>(null)

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
    setRoute(null)

    try {
      const costingOptions = getCostingFromPreferences(preferredItemNames, profileKey, profile)
      const result = await getRoute(start, end, { ...profile, costingOptions }, wps)
      setRoute(result)

      // Enrich with profile-aware colored segments in the background
      getRouteSegments(result.coordinates, profileKey).then((segments) => {
        if (segments) {
          setRoute((r) => (r ? { ...r, segments } : r))
        }
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

  function handleRemoveWaypoint(index: number) {
    const newWps = waypoints.filter((_, i) => i !== index)
    if (startPoint && endPoint) computeRoute(startPoint, endPoint, selectedProfile, newWps)
  }

  // --- Back to search ---
  function backToSearch() {
    setRoute(null)
    setStartPoint(null)
    setEndPoint(null)
    setSelectedPlace(null)
    setError(null)
    setUiState('search')
  }

  function handleProfileSave(updatedProfile: RiderProfile) {
    if (!editingProfile) return
    setProfiles((prev) => ({ ...prev, [editingProfile]: updatedProfile }))
    setEditingProfile(null)
    if (startPoint && endPoint && editingProfile === selectedProfile) {
      setTimeout(() => computeRoute(startPoint, endPoint, editingProfile, waypoints), 0)
    }
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
            waypoints={waypoints}
            onRemoveWaypoint={handleRemoveWaypoint}
            overlayEnabled={overlayEnabled}
            profileKey={selectedProfile}
            onOverlayStatusChange={setOverlayStatus}
            currentLocation={currentLocation}
            preferredItemNames={preferredItemNames}
            showOtherPaths={showOtherPaths}
            flyToPlace={flyToPlace}
            regionRules={regionRules}
          />
        </Suspense>

        {/* Travel mode selector */}
        <div className="map-travel-mode">
          <ProfileSelector
            profiles={profiles}
            selected={selectedProfile}
            onSelect={handleProfileChange}
            onEdit={(key) => setEditingProfile(key)}
            isCustomTravelMode={isCustomTravelMode}
          />
        </div>

        {/* Top-right controls */}
        <div className="map-top-right">
          <FeedbackWidget />
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

        {/* Bike layer status + audit gear */}
        <div className="map-bike-layer-toggle">
          <button
            className="audit-gear-btn"
            onClick={() => setAuditOpen(true)}
            title="Classification audit"
          >
            ⚙️
          </button>
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
                onStartClear={() => { setStartPoint(null); setRoute(null) }}
                onEndClear={() => { setEndPoint(null); setRoute(null) }}
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
                <DirectionsPanel
                  route={route}
                  onClose={backToSearch}
                  preferredItemNames={preferredItemNames}
                />
              </div>
            )}
          </>
        )}
      </div>

      {editingProfile && (
        <Suspense fallback={null}>
          <ProfileEditor
            profileKey={editingProfile}
            profile={profiles[editingProfile]}
            onChange={(updated) => {
              setProfiles((prev) => ({ ...prev, [editingProfile]: updated }))
            }}
            onClose={() => handleProfileSave(profiles[editingProfile])}
          />
        </Suspense>
      )}

      {auditOpen && (
        <Suspense fallback={null}>
          <AuditPanel onClose={() => setAuditOpen(false)} />
        </Suspense>
      )}
    </div>
  )
}
