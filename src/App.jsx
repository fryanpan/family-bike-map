import { useState, useEffect } from 'react'
import Map from './components/Map.jsx'
import SearchBar from './components/SearchBar.jsx'
import ProfileSelector from './components/ProfileSelector.jsx'
import DirectionsPanel from './components/DirectionsPanel.jsx'
import ProfileEditor from './components/ProfileEditor.jsx'
import { getRoute, getRouteSegments, DEFAULT_PROFILES, formatDistance } from './services/routing.js'
import { reverseGeocode } from './services/geocoding.js'

const STORAGE_KEY = 'bike-route-profiles'

function loadProfiles() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const parsed = JSON.parse(saved)
      // Merge with defaults so new default keys are always present
      return { ...DEFAULT_PROFILES, ...parsed }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_PROFILES }
}

function saveProfiles(profiles) {
  try {
    // Only persist profiles that differ from defaults (saves space)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles))
  } catch { /* ignore */ }
}

const MODE_HINT = {
  start:    '👆 Tap map or search to set start',
  end:      '👆 Tap map or search to set destination',
  waypoint: '👆 Tap to add waypoints — forces route through that point',
}

export default function App() {
  const [profiles, setProfiles] = useState(loadProfiles)
  const [selectedProfile, setSelectedProfile] = useState('toddler')
  const [editingProfile, setEditingProfile] = useState(null)  // key of profile being edited

  const [startPoint, setStartPoint] = useState(null)
  const [endPoint, setEndPoint]     = useState(null)
  const [waypoints, setWaypoints]   = useState([])

  const [route, setRoute]         = useState(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError]         = useState(null)

  const [clickMode, setClickMode]   = useState('start')
  const [panelOpen, setPanelOpen]   = useState(true)

  const [overlayEnabled, setOverlayEnabled] = useState(false)
  const [overlayStatus, setOverlayStatus]   = useState('idle')

  // Persist profile customisations
  useEffect(() => {
    saveProfiles(profiles)
  }, [profiles])

  async function computeRoute(start, end, profileKey, wps) {
    if (!start || !end) return
    const profile = profiles[profileKey]
    if (!profile) return

    setIsLoading(true)
    setError(null)
    setRoute(null)

    try {
      const result = await getRoute(start, end, profile, wps)
      setRoute(result)

      // Enrich with colored segments in the background
      getRouteSegments(result.coordinates).then((segments) => {
        if (segments) {
          setRoute((r) => (r ? { ...r, segments } : r))
        }
      })
    } catch (e) {
      setError(e.message ?? 'Could not find a route')
    } finally {
      setIsLoading(false)
    }
  }

  function handleStartSelect(place) {
    setStartPoint(place)
    if (endPoint) computeRoute(place, endPoint, selectedProfile, waypoints)
  }

  function handleEndSelect(place) {
    setEndPoint(place)
    if (startPoint) computeRoute(startPoint, place, selectedProfile, waypoints)
  }

  function handleProfileChange(key) {
    setSelectedProfile(key)
    if (startPoint && endPoint) computeRoute(startPoint, endPoint, key, waypoints)
  }

  async function handleMapClick({ lat, lng }) {
    const shortLabel = `${lat.toFixed(4)}, ${lng.toFixed(4)}`
    const point = { lat, lng, label: shortLabel, shortLabel }

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

  function handleRemoveWaypoint(index) {
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

  function handleProfileEdit(key) {
    setEditingProfile(key)
  }

  function handleProfileSave(updatedProfile) {
    setProfiles((prev) => {
      const next = { ...prev, [editingProfile]: updatedProfile }
      return next
    })
    // Recompute route with new profile settings
    if (startPoint && endPoint && editingProfile === selectedProfile) {
      // Slight delay so state has updated
      setTimeout(() => {
        setProfiles((prev) => {
          computeRoute(startPoint, endPoint, editingProfile, waypoints)
          return prev
        })
      }, 0)
    }
    setEditingProfile(null)
  }

  const overlayStatusMsg =
    overlayStatus === 'loading' ? '⏳ Loading bike map…' :
    overlayStatus === 'zoom'    ? '🔍 Zoom in to see bike infrastructure' :
    overlayStatus === 'error'   ? '⚠️ Could not load bike map' :
    null

  return (
    <div className="app">
      {/* Map — fills remaining space */}
      <div className="map-wrap">
        <Map
          startPoint={startPoint}
          endPoint={endPoint}
          route={route}
          waypoints={waypoints}
          onMapClick={handleMapClick}
          onRemoveWaypoint={handleRemoveWaypoint}
          overlayEnabled={overlayEnabled}
          onOverlayStatusChange={setOverlayStatus}
        />
      </div>

      {/* Panel — bottom sheet on mobile, sidebar on desktop */}
      <div className={`panel${panelOpen ? ' panel-open' : ' panel-closed'}`}>
        {/* Pull handle (mobile only) */}
        <div
          className="panel-handle"
          role="button"
          aria-label="Toggle panel"
          onClick={() => setPanelOpen((o) => !o)}
        >
          <div className="handle-bar" />
        </div>

        <div className="panel-content">
          {/* Header */}
          <div className="panel-header">
            <div className="header-row">
              <div>
                <h1 className="app-title">🚲 Berlin Bike Routes</h1>
                <p className="app-subtitle">Family-friendly routing</p>
              </div>
              {/* Bike map overlay toggle */}
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

          {/* Search */}
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

          {/* Profile selector */}
          <ProfileSelector
            profiles={profiles}
            selected={selectedProfile}
            onSelect={handleProfileChange}
            onEdit={handleProfileEdit}
          />

          {/* Waypoints */}
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

          {/* Loading */}
          {isLoading && (
            <div className="loading">
              <div className="spinner" />
              <span>Calculating route…</span>
            </div>
          )}

          {/* Error */}
          {error && <div className="error-msg">⚠️ {error}</div>}

          {/* Directions */}
          {route && !isLoading && (
            <DirectionsPanel route={route} onClose={clearAll} />
          )}
        </div>
      </div>

      {/* Profile editor modal */}
      {editingProfile && (
        <ProfileEditor
          profile={profiles[editingProfile]}
          onChange={(updated) => {
            // Live preview: update profile state immediately
            setProfiles((prev) => ({ ...prev, [editingProfile]: updated }))
          }}
          onClose={() => {
            // Recompute route when editor closes if this profile is active
            if (editingProfile === selectedProfile && startPoint && endPoint) {
              computeRoute(startPoint, endPoint, editingProfile, waypoints)
            }
            setEditingProfile(null)
          }}
        />
      )}
    </div>
  )
}
