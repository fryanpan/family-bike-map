import { useState, useEffect, useRef, useCallback } from 'react'
import { searchPlaces } from '../services/geocoding'
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

export default function SearchBar({ label, value, onSelect, onClear, placeholder, quickOptions, biasPoint }: Props) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<Place[]>([])
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync display when parent updates the selected value
  useEffect(() => {
    setQuery(value?.shortLabel ?? '')
  }, [value])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const q = e.target.value
    setQuery(q)

    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (q.length >= 2) {
      debounceRef.current = setTimeout(async () => {
        try {
          const results = await searchPlaces(q, biasPoint)
          setSuggestions(results)
          setOpen(results.length > 0)
        } catch {
          setSuggestions([])
        }
      }, 300)
    } else {
      setSuggestions([])
      setOpen(false)
    }
  }, [biasPoint])

  const handleSelect = useCallback(
    (place: Place) => {
      setQuery(place.shortLabel)
      setSuggestions([])
      setOpen(false)
      onSelect(place)
    },
    [onSelect],
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
          placeholder={placeholder}
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
          {suggestions.map((s, i) => (
            <li key={i} className="suggestion-item" onMouseDown={() => handleSelect(s)}>
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
