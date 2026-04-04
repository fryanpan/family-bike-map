import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { useGeolocation } from './hooks/useGeolocation'
const Map = lazy(() => import('./components/Map'))
const ProfileEditor = lazy(() => import('./components/ProfileEditor'))
import Legend from './components/Legend'
import SearchBar from './components/SearchBar'
import type { QuickOption } from './components/SearchBar'
import ProfileSelector from './components/ProfileSelector'
import DirectionsPanel from './components/DirectionsPanel'
import FeedbackWidget from './components/FeedbackWidget'
import { getRoute, getRouteSegments, DEFAULT_PROFILES } from './services/routing'
import { reverseGeocode } from './services/geocoding'
import {
  getDefaultPreferredItems,
  getCostingFromPreferences,
} from './utils/classify'
import type { Place, Route, ProfileMap, RiderProfile } from './utils/types'
import { Sentry } from './sentry'

const HOME_PLACE: Place = {
  lat: 52.5016,
  lng: 13.4103,
  label: 'Dresdener Str 112, Berlin',
  shortLabel: 'Dresdener Str 112',
}

const STORAGE_KEY = 'bike-route-profiles'
const CUSTOM_PREFERRED_KEY = 'bike-route-custom-preferred'
const CUSTOM_MODE_KEY = 'bike-route-mode'

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
  const modeParam = params.get('mode')
  const preferredParam = params.get('preferred')
  const showOtherParam = params.get('showOther')

  const showOtherPaths = showOtherParam === '1'

  // URL preferred param takes top priority
  if (preferredParam !== null) {
    const items = new Set(preferredParam.split(',').filter(Boolean))
    const profile = (modeParam && DEFAULT_PROFILES[modeParam]) ? modeParam : 'toddler'
    return { profileKey: profile, preferredItems: items, showOtherPaths }
  }

  // URL mode param (no custom preferred)
  if (modeParam && DEFAULT_PROFILES[modeParam]) {
    return { profileKey: modeParam, preferredItems: getDefaultPreferredItems(modeParam), showOtherPaths }
  }

  // Fall back to localStorage
  try {
    const savedMode = localStorage.getItem(CUSTOM_MODE_KEY)
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

export default function App() {
  const [profiles, setProfiles] = useState<ProfileMap>(loadProfiles)

  const initialState = getInitialState()
  const [selectedProfile, setSelectedProfile] = useState(initialState.profileKey)
  const [preferredItemNames, setPreferredItemNames] = useState<Set<string>>(
    () => initialState.preferredItems
  )
  const [showOtherPaths, setShowOtherPaths] = useState(initialState.showOtherPaths)

  const [editingProfile, setEditingProfile] = useState<string | null>(null)

  const [startPoint, setStartPoint] = useState<Place | null>(null)
  const [endPoint, setEndPoint]     = useState<Place | null>(null)
  const [waypoints]                 = useState<Array<{ lat: number; lng: number }>>([])

  const { location: currentLocation } = useGeolocation()

  const [route, setRoute]         = useState<Route | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  const [panelOpen, setPanelOpen] = useState(true)

  const [overlayEnabled, setOverlayEnabled] = useState(true)
  const [overlayStatus, setOverlayStatus]   = useState('idle')

  // Derived: is the user in custom mode (preferred differs from profile defaults)?
  const isCustomMode = !setsEqual(preferredItemNames, getDefaultPreferredItems(selectedProfile))

  // Sync URL params and localStorage on every state change
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    params.set('mode', selectedProfile)
    if (isCustomMode) {
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
      localStorage.setItem(CUSTOM_MODE_KEY, selectedProfile)
      if (isCustomMode) {
        localStorage.setItem(CUSTOM_PREFERRED_KEY, JSON.stringify([...preferredItemNames]))
      } else {
        localStorage.removeItem(CUSTOM_PREFERRED_KEY)
      }
    } catch { /* ignore */ }
  }, [selectedProfile, preferredItemNames, isCustomMode, showOtherPaths])

  useEffect(() => {
    saveProfiles(profiles)
  }, [profiles])

  // Re-route when preferred items change so costing reflects the new preferences.
  // We skip this on initial mount (the route is computed explicitly when start/end are set).
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

  function handleStartSelect(place: Place) {
    setStartPoint(place)
    if (endPoint) computeRoute(place, endPoint, selectedProfile, waypoints)
  }

  function handleSelectCurrentLocation() {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords
        const geocoded = await reverseGeocode(lat, lng)
        const place: Place = {
          lat,
          lng,
          label: geocoded?.label ?? 'Current Location',
          shortLabel: geocoded?.shortLabel ?? 'Current Location',
        }
        handleStartSelect(place)
      },
      () => { /* permission denied — ignore */ },
    )
  }

  function handleSelectCurrentLocationAsEnd() {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords
        const geocoded = await reverseGeocode(lat, lng)
        const place: Place = {
          lat,
          lng,
          label: geocoded?.label ?? 'Current Location',
          shortLabel: geocoded?.shortLabel ?? 'Current Location',
        }
        handleEndSelect(place)
      },
      () => { /* permission denied — ignore */ },
    )
  }

  function handleEndSelect(place: Place) {
    setEndPoint(place)
    if (startPoint) computeRoute(startPoint, place, selectedProfile, waypoints)
  }

  function handleProfileChange(key: string) {
    setSelectedProfile(key)
    // Reset preferred items to this profile's defaults (clears custom mode)
    setPreferredItemNames(getDefaultPreferredItems(key))
    if (startPoint && endPoint) computeRoute(startPoint, endPoint, key, waypoints)
  }

  function handleRemoveWaypoint(index: number) {
    const newWps = waypoints.filter((_, i) => i !== index)
    if (startPoint && endPoint) computeRoute(startPoint, endPoint, selectedProfile, newWps)
  }

  function clearAll() {
    setRoute(null)
    setStartPoint(null)
    setEndPoint(null)
    setError(null)
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

  const startQuickOptions: QuickOption[] = [
    {
      label: 'Current Location',
      icon: '📍',
      onSelect: handleSelectCurrentLocation,
      isLocation: true,
    },
    {
      label: 'Home',
      icon: '🏠',
      onSelect: () => handleStartSelect(HOME_PLACE),
    },
  ]

  const endQuickOptions: QuickOption[] = [
    {
      label: 'Current Location',
      icon: '📍',
      onSelect: handleSelectCurrentLocationAsEnd,
      isLocation: true,
    },
    {
      label: 'Home',
      icon: '🏠',
      onSelect: () => handleEndSelect(HOME_PLACE),
    },
  ]

  return (
    <div className="app">
      <div className="map-wrap">
        <Suspense fallback={<div className="map-loading" />}>
          <Map
            startPoint={startPoint}
            endPoint={endPoint}
            route={route}
            waypoints={waypoints}
            onRemoveWaypoint={handleRemoveWaypoint}
            overlayEnabled={overlayEnabled}
            profileKey={selectedProfile}
            onOverlayStatusChange={setOverlayStatus}
            currentLocation={currentLocation}
            preferredItemNames={preferredItemNames}
            showOtherPaths={showOtherPaths}
          />
        </Suspense>
        <div className="map-mode-overlay">
          <ProfileSelector
            profiles={profiles}
            selected={selectedProfile}
            onSelect={handleProfileChange}
            onEdit={(key) => setEditingProfile(key)}
            isCustomMode={isCustomMode}
          />
        </div>
        {/* Top-right controls: feedback button + legend, laid out as a flex row */}
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
        {/* On-map bike layer toggle */}
        <div className="map-bike-layer-toggle">
          <button
            className={`bike-layer-btn${overlayEnabled ? ' active' : ''}`}
            onClick={() => setOverlayEnabled((v) => !v)}
            title="Toggle bike infrastructure layer"
          >
            🗺️ Bike Layer
          </button>
          {overlayStatusMsg && <p className="bike-layer-status">{overlayStatusMsg}</p>}
        </div>
      </div>

      <div className={`panel${panelOpen ? ' panel-open' : ' panel-closed'}`}>
        <div
          className="panel-handle"
          role="button"
          aria-label="Toggle panel"
          onClick={() => setPanelOpen((o) => !o)}
        >
          <div className="handle-bar" />
        </div>

        <div className="panel-content">
          <div className="panel-header">
            <h1 className="app-title">Bike Route Planner</h1>
          </div>

          <div className="search-section">
            <SearchBar
              label="Start"
              value={startPoint}
              onSelect={handleStartSelect}
              placeholder="Search start location…"
              quickOptions={startQuickOptions}
            />
            <SearchBar
              label="End"
              value={endPoint}
              onSelect={handleEndSelect}
              placeholder="Search destination…"
              quickOptions={endQuickOptions}
            />
          </div>

          {isLoading && (
            <div className="loading">
              <div className="spinner" />
              <span>Calculating route…</span>
            </div>
          )}

          {error && <div className="error-msg">⚠️ {error}</div>}

          {route && !isLoading && (
            <DirectionsPanel
              route={route}
              onClose={clearAll}
              preferredItemNames={preferredItemNames}
            />
          )}
        </div>
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
    </div>
  )
}
