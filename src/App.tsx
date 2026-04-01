import { useState, useEffect } from 'react'
import Map from './components/Map'
import SearchBar from './components/SearchBar'
import ProfileSelector from './components/ProfileSelector'
import DirectionsPanel from './components/DirectionsPanel'
import ProfileEditor from './components/ProfileEditor'
import FeedbackWidget from './components/FeedbackWidget'
import { getRoute, getRouteSegments, DEFAULT_PROFILES } from './services/routing'
import { reverseGeocode } from './services/geocoding'
import type { Place, Route, ProfileMap, RiderProfile } from './utils/types'

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

const MODE_HINT: Record<string, string> = {
  start:    'Tap map or search to set start',
  end:      'Tap map or search to set destination',
  waypoint: 'Tap to add waypoints',
}

export default function App() {
  const [profiles, setProfiles] = useState<ProfileMap>(loadProfiles)
  const [selectedProfile, setSelectedProfile] = useState('toddler')
  const [editingProfile, setEditingProfile] = useState<string | null>(null)

  const [startPoint, setStartPoint] = useState<Place | null>(null)
  const [endPoint, setEndPoint]     = useState<Place | null>(null)
  const [waypoints, setWaypoints]   = useState<Array<{ lat: number; lng: number }>>([])

  const [route, setRoute]         = useState<Route | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState<string | null>(null)

  const [clickMode, setClickMode]   = useState('start')
  const [panelOpen, setPanelOpen]   = useState(true)

  const [overlayEnabled, setOverlayEnabled] = useState(false)
  const [overlayStatus, setOverlayStatus]   = useState('idle')

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

  function handleEndSelect(place: Place) {
    setEndPoint(place)
    if (startPoint) computeRoute(startPoint, place, selectedProfile, waypoints)
  }

  function handleProfileChange(key: string) {
    setSelectedProfile(key)
    if (startPoint && endPoint) computeRoute(startPoint, endPoint, key, waypoints)
  }

  async function handleMapClick({ lat, lng }: { lat: number; lng: number }) {
    const shortLabel = `${lat.toFixed(4)}, ${lng.toFixed(4)}`
    const point: Place = { lat, lng, label: shortLabel, shortLabel }

    if (clickMode === 'start') {
      setStartPoint(point)
      setClickMode('end')
      if (endPoint) computeRoute(point, endPoint, selectedProfile, waypoints)
      reverseGeocode(lat, lng).then((geo) => {
        if (geo) setStartPoint((p) => (p?.lat === lat ? { ...p, ...geo } : p))
      })
    } else if (clickMode === 'end') {
      setEndPoint(point)
      setClickMode('waypoint')
      if (startPoint) computeRoute(startPoint, point, selectedProfile, waypoints)
      reverseGeocode(lat, lng).then((geo) => {
        if (geo) setEndPoint((p) => (p?.lat === lat ? { ...p, ...geo } : p))
      })
    } else {
      const newWps = [...waypoints, { lat, lng }]
      setWaypoints(newWps)
      if (startPoint && endPoint) computeRoute(startPoint, endPoint, selectedProfile, newWps)
    }
  }

  function handleRemoveWaypoint(index: number) {
    const newWps = waypoints.filter((_, i) => i !== index)
    setWaypoints(newWps)
    if (startPoint && endPoint) computeRoute(startPoint, endPoint, selectedProfile, newWps)
  }

  function clearAll() {
    setRoute(null)
    setStartPoint(null)
    setEndPoint(null)
    setWaypoints([])
    setClickMode('start')
    setError(null)
  }

  function handleProfileSave(updatedProfile: RiderProfile) {
    if (!editingProfile) return
    setProfiles((prev) => ({ ...prev, [editingProfile]: updatedProfile }))
    setEditingProfile(null)
    if (startPoint && endPoint && editingProfile === selectedProfile) {
      // Recompute with updated settings
      setTimeout(() => computeRoute(startPoint, endPoint, editingProfile, waypoints), 0)
    }
  }

  const overlayStatusMsg =
    overlayStatus === 'loading' ? '⏳ Loading bike map…' :
    overlayStatus === 'zoom'    ? '🔍 Zoom in to see bike infrastructure' :
    overlayStatus === 'error'   ? '⚠️ Could not load bike map' :
    null

  return (
    <div className="app">
      <div className="map-wrap">
        <Map
          startPoint={startPoint}
          endPoint={endPoint}
          route={route}
          waypoints={waypoints}
          onMapClick={handleMapClick}
          onRemoveWaypoint={handleRemoveWaypoint}
          overlayEnabled={overlayEnabled}
          profileKey={selectedProfile}
          onOverlayStatusChange={setOverlayStatus}
        />
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
            <div className="header-row">
              <div>
                <h1 className="app-title">🚲 Berlin Bike Routes</h1>
                <p className="app-subtitle">Family-friendly routing</p>
              </div>
              <button
                className={`overlay-toggle${overlayEnabled ? ' overlay-on' : ''}`}
                onClick={() => setOverlayEnabled((v) => !v)}
                title="Show bike infrastructure on map"
              >
                🗺️ Bike map
              </button>
            </div>
            {overlayStatusMsg && (
              <p className="overlay-status">{overlayStatusMsg}</p>
            )}
          </div>

          <div className="search-section">
            <SearchBar
              label="Start"
              value={startPoint}
              onSelect={handleStartSelect}
              placeholder="Search start location…"
            />
            <SearchBar
              label="End"
              value={endPoint}
              onSelect={handleEndSelect}
              placeholder="Search destination…"
            />
            <p className="click-hint">{MODE_HINT[clickMode]}</p>
          </div>

          <ProfileSelector
            profiles={profiles}
            selected={selectedProfile}
            onSelect={handleProfileChange}
            onEdit={(key) => setEditingProfile(key)}
          />

          {waypoints.length > 0 && (
            <div className="waypoints-section">
              <div className="waypoints-row">
                <span className="waypoints-label">
                  📍 {waypoints.length} waypoint{waypoints.length > 1 ? 's' : ''}
                </span>
                <button
                  className="link-btn"
                  onClick={() => {
                    setWaypoints([])
                    if (startPoint && endPoint) computeRoute(startPoint, endPoint, selectedProfile, [])
                  }}
                >
                  Clear all
                </button>
              </div>
              <p className="hint">Tap a waypoint marker on the map to remove it</p>
            </div>
          )}

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
        <ProfileEditor
          profile={profiles[editingProfile]}
          onChange={(updated) => {
            setProfiles((prev) => ({ ...prev, [editingProfile]: updated }))
          }}
          onClose={() => handleProfileSave(profiles[editingProfile])}
        />
      )}

      <FeedbackWidget />
    </div>
  )
}
