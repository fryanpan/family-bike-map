import { useState, useEffect, lazy, Suspense } from 'react'
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
import { SAFETY_LEVEL, PROFILE_LEGEND } from './utils/classify'
import type { LegendLevel } from './utils/classify'
import type { Place, Route, ProfileMap, RiderProfile, SafetyClass } from './utils/types'

const HOME_PLACE: Place = {
  lat: 52.5016,
  lng: 13.4103,
  label: 'Dresdener Str 112, Berlin',
  shortLabel: 'Dresdener Str 112',
}

const STORAGE_KEY = 'bike-route-profiles'

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

export default function App() {
  const [profiles, setProfiles] = useState<ProfileMap>(loadProfiles)
  const [selectedProfile, setSelectedProfile] = useState('toddler')
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

  // Legend toggle state — managed here so Legend can render outside MapContainer
  const [hiddenSafetyClasses, setHiddenSafetyClasses] = useState<Set<SafetyClass>>(
    () => new Set<SafetyClass>(['avoid'])
  )

  const hiddenLevels = new Set<LegendLevel>(
    [...hiddenSafetyClasses].map((cls) => SAFETY_LEVEL[cls])
  )

  function toggleSafetyClass(cls: SafetyClass) {
    setHiddenSafetyClasses((prev) => {
      const next = new Set(prev)
      if (next.has(cls)) next.delete(cls)
      else next.add(cls)
      return next
    })
  }

  function toggleGroup(level: LegendLevel) {
    const profileGroups = PROFILE_LEGEND[selectedProfile]
    if (!profileGroups) return
    const group = profileGroups.find((g) => g.level === level)
    if (!group) return
    const groupClasses = [...new Set(group.items.map((i) => i.safetyClass))]
    const allHidden = groupClasses.every((c) => hiddenSafetyClasses.has(c))
    setHiddenSafetyClasses((prev) => {
      const next = new Set(prev)
      if (allHidden) {
        groupClasses.forEach((c) => next.delete(c))
      } else {
        groupClasses.forEach((c) => next.add(c))
      }
      return next
    })
  }

  useEffect(() => {
    saveProfiles(profiles)
  }, [profiles])



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
      const result = await getRoute(start, end, profile, wps)
      setRoute(result)

      // Enrich with profile-aware colored segments in the background
      getRouteSegments(result.coordinates, profileKey).then((segments) => {
        if (segments) {
          setRoute((r) => (r ? { ...r, segments } : r))
        }
      })
    } catch (e) {
      setError((e as Error).message ?? 'Could not find a route')
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

  function handleEndSelect(place: Place) {
    setEndPoint(place)
    if (startPoint) computeRoute(startPoint, place, selectedProfile, waypoints)
  }

  function handleProfileChange(key: string) {
    setSelectedProfile(key)
    if (startPoint && endPoint) computeRoute(startPoint, endPoint, key, waypoints)
  }

  function handleRemoveWaypoint(index: number) {
    // Waypoints can be removed by clicking their marker; no-op if list is empty
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
    overlayStatus === 'error'   ? '⚠️ Could not load bike map' :
    null

  const startQuickOptions: QuickOption[] = [
    {
      label: 'Current Location',
      icon: '📍',
      onSelect: handleSelectCurrentLocation,
    },
    {
      label: 'Home',
      icon: '🏠',
      onSelect: () => handleStartSelect(HOME_PLACE),
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
            hiddenLevels={hiddenLevels}
            currentLocation={currentLocation}
          />
        </Suspense>
        <div className="map-mode-overlay">
          <ProfileSelector
            profiles={profiles}
            selected={selectedProfile}
            onSelect={handleProfileChange}
            onEdit={(key) => setEditingProfile(key)}
          />
        </div>
        {/* Top-right controls: feedback button + legend, laid out as a flex row */}
        <div className="map-top-right">
          <FeedbackWidget />
          <Legend
            segments={route?.segments ?? null}
            overlayOn={overlayEnabled}
            profileKey={selectedProfile}
            hiddenSafetyClasses={hiddenSafetyClasses}
            onToggleSafetyClass={toggleSafetyClass}
            onToggleGroup={toggleGroup}
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
            <h1 className="app-title">Family Bike Map</h1>
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
            <DirectionsPanel route={route} onClose={clearAll} />
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
