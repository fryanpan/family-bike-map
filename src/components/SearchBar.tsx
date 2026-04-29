import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useActiveGeocoder } from '../services/geocoder/resolve'
import type { AutocompleteResult } from '../services/geocoder/types'
import { getPlaceDetail } from '../utils/types'
import type { Place } from '../utils/types'

export interface QuickOption {
  label: string
  icon: string
  onSelect: () => void
  isLocation?: boolean
  /** Optional secondary line shown under the label (e.g. saved place address). */
  sublabel?: string
}

interface Props {
  label: string
  value: Place | null
  onSelect: (place: Place) => void
  onClear?: () => void
  placeholder: string
  quickOptions?: QuickOption[]
  biasPoint?: { lat: number; lng: number }
}

// ── Saved-place priority ─────────────────────────────────────────────────────
// Read Home/School straight out of localStorage so any keystroke can match
// them without waiting for a network round-trip. Independent of the active
// geocoder engine — the same matches show up whether we use Nominatim or
// Google. This is the fix for "Dresdener Str 112 shows my home as the third
// autocomplete" — saved-place hits ALWAYS rank above engine hits.

interface SavedPlace {
  storageKey: string
  emoji: string
  /** Pretty name shown in the suggestion list. */
  name: string
}

const SAVED_PLACES: readonly SavedPlace[] = [
  { storageKey: 'bike-route-home',   emoji: '🏠', name: 'Home' },
  { storageKey: 'bike-route-school', emoji: '🏫', name: 'School' },
] as const

function loadSavedPlace(key: string): Place | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
    if (!raw) return null
    const parsed = JSON.parse(raw) as Place
    if (
      typeof parsed?.lat === 'number' &&
      typeof parsed?.lng === 'number' &&
      typeof parsed?.label === 'string'
    ) {
      return parsed
    }
  } catch { /* ignore */ }
  return null
}

/**
 * Substring-match saved places against the query. A saved place
 * matches if the query (lowercased) appears inside the place's
 * label, shortLabel, OR pretty-name (so "home" matches "🏠 Home"
 * even when the user's home address has nothing called "home" in it).
 *
 * Returns AutocompleteResult-shaped entries so the suggestion list
 * can render them uniformly with engine results. The lat/lng are
 * inlined so taps short-circuit the placeDetails call.
 */
export function matchSavedPlaces(query: string): AutocompleteResult[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) return []
  const out: AutocompleteResult[] = []
  for (const saved of SAVED_PLACES) {
    const place = loadSavedPlace(saved.storageKey)
    if (!place) continue
    const haystack = `${saved.name} ${place.shortLabel} ${place.label}`.toLowerCase()
    if (!haystack.includes(q)) continue
    out.push({
      id: `saved:${saved.storageKey}`,
      label: place.label,
      shortLabel: `${saved.emoji} ${saved.name} — ${place.shortLabel}`,
      lat: place.lat,
      lng: place.lng,
      iconPrefix: saved.emoji,
    })
  }
  return out
}

/**
 * Drop engine-side hits whose coords are within ~50 m of an
 * already-prepended saved-place hit, so we don't show "Home" twice.
 * 50 m is small enough that nothing legitimately separate gets
 * collapsed but large enough to absorb minor rounding between
 * Nominatim and Google.
 */
function dedupAgainst(
  primary: AutocompleteResult[],
  rest: AutocompleteResult[],
): AutocompleteResult[] {
  const EPS = 0.0005 // ~55 m at the equator, decent everywhere
  return rest.filter((r) => {
    const rLat = r.lat
    const rLng = r.lng
    if (typeof rLat !== 'number' || typeof rLng !== 'number') return true
    return !primary.some((p) => {
      const pLat = p.lat
      const pLng = p.lng
      if (typeof pLat !== 'number' || typeof pLng !== 'number') return false
      return Math.abs(pLat - rLat) < EPS && Math.abs(pLng - rLng) < EPS
    })
  })
}

export default function SearchBar({ label, value, onSelect, onClear, placeholder, quickOptions, biasPoint }: Props) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<AutocompleteResult[]>([])
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Bumped on each keystroke; async returns from older queries are
   *  ignored so a slow network can't overwrite a fresh result list. */
  const queryGenRef = useRef(0)

  const resolved = useActiveGeocoder()
  const engine = resolved.engine

  // Memoize so the placeholder string changes when the engine flips.
  const enginePlaceholder = useMemo(
    () => placeholder + (resolved.kind === 'google' ? '' : ''),
    [placeholder, resolved.kind],
  )

  // Sync display when parent updates the selected value
  useEffect(() => {
    setQuery(value?.shortLabel ?? '')
  }, [value])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value
    setQuery(q)
    queryGenRef.current += 1
    const myGen = queryGenRef.current

    if (debounceRef.current) clearTimeout(debounceRef.current)

    if (q.length < 2) {
      setSuggestions([])
      setOpen(false)
      return
    }

    // Saved-place hits are computed synchronously and shown before the
    // network call resolves — instant feedback for the most common
    // queries. The engine call is debounced to avoid spamming
    // Nominatim / Google on every keystroke.
    const savedHits = matchSavedPlaces(q)
    if (savedHits.length > 0) {
      setSuggestions(savedHits)
      setOpen(true)
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const engineHits = await engine.autocomplete(q, biasPoint)
        // Drop stale results.
        if (myGen !== queryGenRef.current) return
        // Re-read saved-place hits — the user may have typed more
        // characters between the savedHits snapshot and now. Keeps
        // them at the top with engine results below, deduped.
        const fresh = matchSavedPlaces(q)
        const combined = [...fresh, ...dedupAgainst(fresh, engineHits)]
        setSuggestions(combined)
        setOpen(combined.length > 0)
      } catch {
        if (myGen !== queryGenRef.current) return
        // Engine errored — keep saved hits visible if any.
        setSuggestions(matchSavedPlaces(q))
      }
    }, 300)
  }, [engine, biasPoint])

  const handleSelect = useCallback(
    async (suggestion: AutocompleteResult) => {
      // Resolve to a full Place. Engines that already have lat/lng
      // (Nominatim, saved places) return immediately; Google calls
      // Place Details here.
      const place = await engine.placeDetails(suggestion)
      if (!place) return
      setQuery(place.shortLabel)
      setSuggestions([])
      setOpen(false)
      onSelect(place)
    },
    [engine, onSelect],
  )

  // Close suggestions on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const showQuickOptions = quickOptions && quickOptions.length > 0 && !value && focused && query.length === 0

  return (
    <div className="search-bar" ref={containerRef}>
      <label className="search-label">{label}</label>
      <div className="search-input-wrap">
        <input
          type="text"
          className={`search-input${value && onClear ? ' search-input-clearable' : ''}`}
          value={query}
          onChange={handleChange}
          placeholder={enginePlaceholder}
          onFocus={() => {
            setFocused(true)
            if (suggestions.length > 0) setOpen(true)
          }}
          onBlur={() => setFocused(false)}
        />
        {value && onClear && (
          <button
            className="search-clear-btn"
            aria-label="Clear"
            onMouseDown={(e) => {
              e.preventDefault()
              setQuery('')
              onClear()
            }}
          >
            ✕
          </button>
        )}
      </div>
      {showQuickOptions && (
        <div className="quick-options">
          {quickOptions.map((opt, i) => (
            <button
              key={i}
              className="quick-option-btn"
              onMouseDown={(e) => {
                e.preventDefault()
                opt.onSelect()
                setFocused(false)
              }}
            >
              <span className={`quick-option-icon-wrap${opt.isLocation ? ' location' : ''}`}>
                {opt.icon}
              </span>
              <span className="quick-option-text">
                <span className="quick-option-label">{opt.label}</span>
                {opt.sublabel && (
                  <span className="quick-option-sublabel">{opt.sublabel}</span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
      {open && (
        <ul className="suggestions">
          {suggestions.map((s) => (
            <li key={s.id} className="suggestion-item" onMouseDown={() => handleSelect(s)}>
              <span className="suggestion-name">{s.shortLabel}</span>
              <span className="suggestion-detail">
                {getPlaceDetail(s.label)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
