import { useAdminSettings, DEFAULT_SETTINGS, setSettings, resetSettings } from '../services/adminSettings'
import type { AdminSettings } from '../services/adminSettings'
import { PROFILE_LEGEND } from '../utils/classify'
import { MODE_RULES } from '../data/modes'
import type { RideMode } from '../data/modes'
import { PATH_LEVELS } from '../utils/lts'
import type { PathLevel } from '../utils/lts'
import { readEnvKeys as readGeocoderEnvKeys, resolveGeocoder } from '../services/geocoder/resolve'
import type { GeocoderEngineKind } from '../services/geocoder/types'
import { readEnvKeys as readMapEngineEnvKeys, resolveEngine } from '../services/mapEngine'
import type { MapEngineKind } from '../services/mapEngine'

// ── Path-type → category mapping (hardcoded from classifyOsmTagsToItem) ─────

interface PathTypeRow {
  osmTags: string
  level: PathLevel
  displayName: string
}

const PATH_TYPE_MAPPING: PathTypeRow[] = [
  { osmTags: 'highway=cycleway', level: '1a', displayName: 'Bike path' },
  { osmTags: 'highway=path + bicycle=yes', level: '1a', displayName: 'Shared use path' },
  { osmTags: 'highway=footway + bicycle=yes', level: '1a', displayName: 'Shared use path' },
  { osmTags: 'cycleway=track (curb-separated)', level: '1a', displayName: 'Elevated sidewalk path' },
  { osmTags: 'cycleway=lane + separation=*', level: '1a', displayName: 'Elevated sidewalk path' },
  { osmTags: 'bicycle_road=yes / cyclestreet=yes', level: '1b', displayName: 'Fahrradstrasse' },
  { osmTags: 'highway=living_street', level: '1b', displayName: 'Living street' },
  { osmTags: 'highway=residential + motor_vehicle=destination', level: '1b', displayName: 'Bike boulevard' },
  { osmTags: 'highway=track (forest/farm)', level: '1a', displayName: 'Bike path' },
  { osmTags: 'cycleway=lane, speed ≤ 30', level: '2a', displayName: 'Painted bike lane on quiet street' },
  { osmTags: 'cycleway=share_busway, speed ≤ 30', level: '2a', displayName: 'Shared bus lane on quiet street' },
  { osmTags: 'cycleway=lane, speed > 30', level: '3', displayName: 'Painted bike lane on major road' },
  { osmTags: 'highway=residential (no bike infra)', level: '2b', displayName: 'Quiet street' },
  { osmTags: 'highway=unclassified / tertiary', level: '3', displayName: 'Major road' },
  { osmTags: 'highway=primary / trunk / motorway', level: '4', displayName: '(hidden)' },
]

// ── Component ───────────────────────────────────────────────────────────────

export default function AdminSettingsTab() {
  const settings = useAdminSettings()

  function update<K extends keyof AdminSettings>(key: K, value: AdminSettings[K]): void {
    setSettings({ ...settings, [key]: value })
  }

  function setTierField(level: PathLevel, field: 'color' | 'weight', value: string | number): void {
    setSettings({
      ...settings,
      tiers: {
        ...settings.tiers,
        [level]: { ...settings.tiers[level], [field]: value },
      },
    })
  }

  function setModeField(mode: RideMode, field: 'ridingSpeedKmh' | 'slowSpeedKmh' | 'walkingSpeedKmh' | 'roughSurfaceMultiplier', value: number): void {
    const current = settings.modeRouting[mode] ?? {}
    setSettings({
      ...settings,
      modeRouting: {
        ...settings.modeRouting,
        [mode]: { ...current, [field]: value },
      },
    })
  }

  function setModeLevelMultiplier(mode: RideMode, level: PathLevel, value: number): void {
    const current = settings.modeRouting[mode] ?? {}
    const multipliers = { ...(current.levelMultipliers ?? {}), [level]: value }
    setSettings({
      ...settings,
      modeRouting: {
        ...settings.modeRouting,
        [mode]: { ...current, levelMultipliers: multipliers },
      },
    })
  }

  function effectiveModeParam<K extends 'ridingSpeedKmh' | 'slowSpeedKmh' | 'walkingSpeedKmh' | 'roughSurfaceMultiplier'>(
    mode: RideMode,
    field: K,
  ): number {
    const override = settings.modeRouting[mode]?.[field]
    if (typeof override === 'number') return override
    return MODE_RULES[mode][field] ?? 0
  }

  function effectiveLevelMultiplier(mode: RideMode, level: PathLevel): number {
    const override = settings.modeRouting[mode]?.levelMultipliers?.[level]
    if (typeof override === 'number') return override
    return MODE_RULES[mode].levelMultipliers?.[level] ?? 1.0
  }

  const modes: RideMode[] = ['kid-starting-out', 'kid-confident', 'kid-traffic-savvy', 'carrying-kid', 'training']

  // Resolve the geocoder + map engine once per render so we can show
  // whether each selection actually applied (or fell back because a
  // key was missing).
  const geocoderEnvKeys = readGeocoderEnvKeys()
  const mapEngineEnvKeys = readMapEngineEnvKeys()
  const resolvedGeocoder = resolveGeocoder(settings.geocoderEngine, geocoderEnvKeys)
  const resolvedEngine = resolveEngine(settings.mapEngine, mapEngineEnvKeys)
  const geocoderOptions: Array<{ value: GeocoderEngineKind; label: string; needsKey: boolean }> = [
    { value: 'nominatim', label: 'Nominatim (OpenStreetMap, default)', needsKey: false },
    { value: 'google',    label: 'Google Places (typo-tolerant)',      needsKey: true },
  ]

  function setMapEngine(kind: MapEngineKind): void {
    setSettings({ ...settings, mapEngine: kind })
  }

  return (
    <div className="admin-settings">
      {/* ── Map rendering engine ───────────────────────────────────── */}
      <section className="admin-section">
        <h3>Map rendering engine</h3>
        <label className="admin-num-field">
          Engine
          <select
            className="admin-input"
            value={settings.mapEngine}
            onChange={(e) => setMapEngine(e.target.value as MapEngineKind)}
            style={{ width: 280 }}
          >
            <option value="leaflet-osm">Leaflet + OpenStreetMap Carto (default)</option>
            <option value="leaflet-maptiler">Leaflet + MapTiler Streets v2 light</option>
            <option value="google-maps">Google Maps (JavaScript SDK)</option>
          </select>
        </label>
        <div className="admin-hint">
          Applies to both base tiles AND route / bike-infra polyline rendering.
          Reload the page after changing the engine — hot-swap is not supported.
        </div>
        {resolvedEngine.fellBack && (
          <div className="admin-hint" style={{ color: '#b91c1c' }}>
            ⚠ {resolvedEngine.fallbackReason}. Falling back to leaflet-osm. Add the key to
            <code> .env.local</code> (and to GitHub Actions Deploy secrets for prod).
          </div>
        )}
        <div className="admin-hint">
          Build-time keys detected:
          {mapEngineEnvKeys.maptilerKey   ? ' VITE_MAPTILER_KEY ✓' : ' VITE_MAPTILER_KEY ✗'}
          {mapEngineEnvKeys.googleMapsKey ? ' · VITE_GOOGLE_MAPS_KEY ✓' : ' · VITE_GOOGLE_MAPS_KEY ✗'}
        </div>
      </section>

      {/* ── Search engine ──────────────────────────────────────────── */}
      <section className="admin-section">
        <h3>Location search</h3>
        <label className="admin-num-field">
          Search engine
          <select
            className="admin-input"
            value={settings.geocoderEngine}
            onChange={(e) => update('geocoderEngine', e.target.value as GeocoderEngineKind)}
            style={{ width: 280 }}
          >
            {geocoderOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
                {opt.needsKey && !geocoderEnvKeys.googleMapsKey ? ' — key missing' : ''}
              </option>
            ))}
          </select>
          <span className="admin-hint">
            {settings.geocoderEngine === 'google' && !geocoderEnvKeys.googleMapsKey && (
              <>
                <strong>VITE_GOOGLE_MAPS_KEY</strong> is missing — falling back to Nominatim.
                Set it in <code>.env.local</code> (and Deploy secrets for prod), then rebuild.
              </>
            )}
            {settings.geocoderEngine === 'google' && geocoderEnvKeys.googleMapsKey && (
              <>Google Places active. Make sure <strong>Places API</strong> + <strong>Geocoding API</strong> are enabled in the same Google Cloud project.</>
            )}
            {settings.geocoderEngine === 'nominatim' && (
              <>Free OpenStreetMap geocoder, proxied via <code>/api/nominatim</code>.</>
            )}
            {' '}Currently using: <strong>{resolvedGeocoder.kind}</strong>
            {resolvedGeocoder.fellBack ? ' (fallback)' : ''}.
          </span>
        </label>
      </section>

      {/* ── Visibility toggles ─────────────────────────────────────── */}
      <section className="admin-section">
        <h3>Visibility</h3>
        <label className="admin-toggle-row">
          <input
            type="checkbox"
            checked={settings.showNonPreferredInLegend}
            onChange={(e) => update('showNonPreferredInLegend', e.target.checked)}
          />
          <span>
            Show quiet residential + higher traffic streets in the <em>preferred</em> legend
            <span className="admin-hint"> (traffic-savvy, carrying-kid, training — default off)</span>
          </span>
        </label>
        <label className="admin-toggle-row">
          <input
            type="checkbox"
            checked={settings.showTrainingMode}
            onChange={(e) => update('showTrainingMode', e.target.checked)}
          />
          <span>
            Show <em>Training</em> mode in the mode picker
            <span className="admin-hint"> (default off)</span>
          </span>
        </label>
        <label className="admin-toggle-row">
          <input
            type="checkbox"
            checked={settings.showExternalRouterLinks}
            onChange={(e) => update('showExternalRouterLinks', e.target.checked)}
          />
          <span>
            Show <em>Compare on BRouter / Valhalla</em> links in the route panel
            <span className="admin-hint"> (benchmark sanity-check — default off)</span>
          </span>
        </label>

        <label className="admin-toggle-row">
          <input
            type="checkbox"
            checked={settings.showStartNavigation}
            onChange={(e) => update('showStartNavigation', e.target.checked)}
          />
          <span>
            Show <em>Start Navigation</em> button in the directions panel
            <span className="admin-hint"> (nav UX not production-ready — default off)</span>
          </span>
        </label>
      </section>

      {/* ── Formatting: per-tier color + weight ────────────────────── */}
      <section className="admin-section">
        <h3>Formatting</h3>
        <table className="admin-tier-table">
          <thead>
            <tr><th>Level</th><th>Color</th><th>Hex</th><th>Weight (×)</th></tr>
          </thead>
          <tbody>
            {(['1a', '1b', '2a', '2b', '3'] as PathLevel[]).map((lvl) => (
              <tr key={lvl}>
                <td>{lvl}</td>
                <td>
                  <input
                    type="color"
                    value={settings.tiers[lvl].color}
                    onChange={(e) => setTierField(lvl, 'color', e.target.value)}
                  />
                </td>
                <td>
                  <input
                    type="text"
                    className="admin-input"
                    value={settings.tiers[lvl].color}
                    onChange={(e) => setTierField(lvl, 'color', e.target.value)}
                    style={{ width: 80 }}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    step="0.05"
                    min="0.1"
                    max="2"
                    className="admin-input"
                    value={settings.tiers[lvl].weight}
                    onChange={(e) => setTierField(lvl, 'weight', Number(e.target.value))}
                    style={{ width: 60 }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="admin-num-grid">
          <label>
            Overlay halo extra (px)
            <input type="number" min="0" step="1" className="admin-input"
              value={settings.overlayHaloExtra}
              onChange={(e) => update('overlayHaloExtra', Number(e.target.value))} />
          </label>
          <label>
            Overlay opacity (browsing)
            <input type="number" min="0" max="1" step="0.05" className="admin-input"
              value={settings.overlayOpacityBrowsing}
              onChange={(e) => update('overlayOpacityBrowsing', Number(e.target.value))} />
          </label>
          <label>
            Overlay opacity (route active)
            <input type="number" min="0" max="1" step="0.05" className="admin-input"
              value={settings.overlayOpacityWithRoute}
              onChange={(e) => update('overlayOpacityWithRoute', Number(e.target.value))} />
          </label>
          <label>
            Route line weight (px)
            <input type="number" min="1" step="1" className="admin-input"
              value={settings.routeLineWeight}
              onChange={(e) => update('routeLineWeight', Number(e.target.value))} />
          </label>
          <label>
            Route line weight selected (px)
            <input type="number" min="1" step="1" className="admin-input"
              value={settings.routeLineWeightSelected}
              onChange={(e) => update('routeLineWeightSelected', Number(e.target.value))} />
          </label>
          <label>
            Route halo extra (px)
            <input type="number" min="0" step="1" className="admin-input"
              value={settings.routeHaloExtra}
              onChange={(e) => update('routeHaloExtra', Number(e.target.value))} />
          </label>
        </div>
      </section>

      {/* ── Routing: rough-surface multiplier + per-mode params ────── */}
      <section className="admin-section">
        <h3>Routing</h3>
        <label className="admin-num-field">
          Rough-surface multiplier (global)
          <input type="number" min="1" step="0.1" className="admin-input"
            value={settings.roughSurfaceMultiplierGlobal}
            onChange={(e) => update('roughSurfaceMultiplierGlobal', Number(e.target.value))} />
          <span className="admin-hint">Applied on top of per-mode cost when the way surface is bad.</span>
        </label>

        <details className="admin-details">
          <summary>Per-mode routing parameters</summary>
          {modes.map((mode) => (
            <div key={mode} className="admin-mode-block">
              <h4>{MODE_RULES[mode].label}</h4>
              <div className="admin-num-grid">
                <label>Riding speed (km/h)
                  <input type="number" min="1" step="0.5" className="admin-input"
                    value={effectiveModeParam(mode, 'ridingSpeedKmh')}
                    onChange={(e) => setModeField(mode, 'ridingSpeedKmh', Number(e.target.value))} />
                </label>
                <label>Slow speed (km/h)
                  <input type="number" min="1" step="0.5" className="admin-input"
                    value={effectiveModeParam(mode, 'slowSpeedKmh')}
                    onChange={(e) => setModeField(mode, 'slowSpeedKmh', Number(e.target.value))} />
                </label>
                <label>Walking speed (km/h)
                  <input type="number" min="0.5" step="0.5" className="admin-input"
                    value={effectiveModeParam(mode, 'walkingSpeedKmh')}
                    onChange={(e) => setModeField(mode, 'walkingSpeedKmh', Number(e.target.value))} />
                </label>
                <label>Rough surface ×
                  <input type="number" min="1" step="0.1" className="admin-input"
                    value={effectiveModeParam(mode, 'roughSurfaceMultiplier')}
                    onChange={(e) => setModeField(mode, 'roughSurfaceMultiplier', Number(e.target.value))} />
                </label>
              </div>
              <div className="admin-num-grid">
                {(['1a', '1b', '2a', '2b', '3'] as PathLevel[]).map((lvl) => (
                  <label key={lvl}>Cost × @ {lvl}
                    <input type="number" min="0.5" step="0.1" className="admin-input"
                      value={effectiveLevelMultiplier(mode, lvl)}
                      onChange={(e) => setModeLevelMultiplier(mode, lvl, Number(e.target.value))} />
                  </label>
                ))}
              </div>
              <div className="admin-hint">
                Accepts: {[...MODE_RULES[mode].acceptedLevels].join(', ')} · Rejects: {
                  PATH_LEVELS.filter((l) => !MODE_RULES[mode].acceptedLevels.has(l) && l !== '4').join(', ') || 'none'
                }
              </div>
            </div>
          ))}
        </details>
      </section>

      {/* ── Path-type → category mapping (read-only reference) ─────── */}
      <section className="admin-section">
        <h3>OSM tag → path level → display name</h3>
        <table className="admin-mapping-table">
          <thead>
            <tr><th>OSM tag combo</th><th>Level</th><th>Display name</th></tr>
          </thead>
          <tbody>
            {PATH_TYPE_MAPPING.map((r, i) => (
              <tr key={i}>
                <td><code>{r.osmTags}</code></td>
                <td>{r.level}</td>
                <td>{r.displayName}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="admin-hint">
          Per-mode legend membership: see <code>src/utils/classify.ts</code> <code>PROFILE_LEGEND</code>.
          Routing acceptance + cost multipliers: <code>src/data/modes.ts</code> <code>MODE_RULES</code>.
        </div>
      </section>

      {/* ── Reset ───────────────────────────────────────────────────── */}
      <section className="admin-section">
        <button
          className="btn-secondary"
          onClick={() => { if (confirm('Reset all admin settings to defaults?')) resetSettings() }}
        >
          Reset to defaults
        </button>
        <span className="admin-hint" style={{ marginLeft: 12 }}>
          Clears every override; colors / weights / toggles / per-mode routing all revert.
          {JSON.stringify(settings) === JSON.stringify(DEFAULT_SETTINGS) && ' (currently at defaults)'}
        </span>
      </section>

      {/* Per-mode profile-legend summary (read-only) */}
      <section className="admin-section">
        <h3>Legend preferred items per mode (current)</h3>
        <table className="admin-mapping-table">
          <thead><tr><th>Mode</th><th>Preferred in legend</th></tr></thead>
          <tbody>
            {modes.map((mode) => {
              const groups = PROFILE_LEGEND[mode] ?? []
              const preferredNames: string[] = []
              for (const g of groups) {
                if (g.defaultPreferred) g.items.forEach((i) => preferredNames.push(i.name))
              }
              return (
                <tr key={mode}>
                  <td>{MODE_RULES[mode].label}</td>
                  <td style={{ fontSize: 12 }}>{preferredNames.join(', ')}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>
    </div>
  )
}
