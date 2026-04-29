import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  matchSavedPlaces,
  dedupAgainst,
} from '../../src/services/geocoder/savedPlaces'
import type { AutocompleteResult } from '../../src/services/geocoder/types'
import type { Place } from '../../src/utils/types'

// Minimal in-memory localStorage shim. Bun runs tests in Node, where
// localStorage is undefined; the saved-place helpers guard against
// that by returning null, so we install a real-enough stub here so
// the tests exercise the matching logic.
class MemStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null { return this.store.get(k) ?? null }
  setItem(k: string, v: string): void { this.store.set(k, v) }
  removeItem(k: string): void { this.store.delete(k) }
  clear(): void { this.store.clear() }
}

const HOME: Place = {
  label: 'Dresdener Straße 112, Kreuzberg, Berlin, Germany',
  shortLabel: 'Dresdener Straße 112',
  lat: 52.5010,
  lng: 13.4097,
}

const SCHOOL: Place = {
  label: 'Reichenberger Str 60, Kreuzberg, Berlin, Germany',
  shortLabel: 'Reichenberger Straße 60',
  lat: 52.4995,
  lng: 13.4170,
}

describe('matchSavedPlaces', () => {
  beforeEach(() => {
    const ls = new MemStorage()
    ls.setItem('bike-route-home', JSON.stringify(HOME))
    ls.setItem('bike-route-school', JSON.stringify(SCHOOL))
    ;(globalThis as { localStorage?: unknown }).localStorage = ls
  })
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  it('matches saved places by substring of the address', () => {
    const hits = matchSavedPlaces('Dresdener')
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe('saved:bike-route-home')
    expect(hits[0].lat).toBe(HOME.lat)
    expect(hits[0].lng).toBe(HOME.lng)
    expect(hits[0].shortLabel).toContain('Home')
    expect(hits[0].iconPrefix).toBe('🏠')
  })

  it('matches by the saved place pretty-name', () => {
    // "home" doesn't appear in the address — only in the saved-place
    // metadata. We still want a hit so users can type "home" or
    // "school" directly.
    const hits = matchSavedPlaces('home')
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe('saved:bike-route-home')
  })

  it('is case-insensitive', () => {
    expect(matchSavedPlaces('DRESDENER')).toHaveLength(1)
    expect(matchSavedPlaces('dresdener')).toHaveLength(1)
  })

  it('returns empty when query is empty or whitespace', () => {
    expect(matchSavedPlaces('')).toEqual([])
    expect(matchSavedPlaces('   ')).toEqual([])
  })

  it('returns empty when nothing matches', () => {
    expect(matchSavedPlaces('Alexanderplatz')).toEqual([])
  })

  it('returns matches for both Home and School when query matches both', () => {
    const hits = matchSavedPlaces('Berlin')
    // Both addresses are in Berlin → both match.
    expect(hits).toHaveLength(2)
    const ids = hits.map((h) => h.id)
    expect(ids).toContain('saved:bike-route-home')
    expect(ids).toContain('saved:bike-route-school')
  })

  it('returns empty when localStorage has no saved places', () => {
    ;(globalThis as { localStorage?: unknown }).localStorage = new MemStorage()
    expect(matchSavedPlaces('Dresdener')).toEqual([])
  })

  it('skips saved places with malformed JSON', () => {
    const ls = new MemStorage()
    ls.setItem('bike-route-home', 'not-json')
    ;(globalThis as { localStorage?: unknown }).localStorage = ls
    expect(matchSavedPlaces('home')).toEqual([])
  })

  it('skips saved places without lat/lng', () => {
    const ls = new MemStorage()
    ls.setItem('bike-route-home', JSON.stringify({ label: 'x', shortLabel: 'x' }))
    ;(globalThis as { localStorage?: unknown }).localStorage = ls
    expect(matchSavedPlaces('x')).toEqual([])
  })
})

describe('dedupAgainst', () => {
  const home: AutocompleteResult = {
    id: 'saved:bike-route-home',
    label: 'Dresdener Straße 112',
    shortLabel: '🏠 Home — Dresdener Straße 112',
    lat: 52.5010,
    lng: 13.4097,
  }

  it('drops engine hits within ~55 m of a saved hit', () => {
    const engineHits: AutocompleteResult[] = [
      { id: 'osm:1', label: 'Dresdener 112', shortLabel: 'Dresdener 112', lat: 52.5011, lng: 13.4098 },
    ]
    expect(dedupAgainst([home], engineHits)).toEqual([])
  })

  it('keeps engine hits that are far enough away', () => {
    const engineHits: AutocompleteResult[] = [
      { id: 'osm:far', label: 'Alexanderplatz', shortLabel: 'Alexanderplatz', lat: 52.5219, lng: 13.4133 },
    ]
    expect(dedupAgainst([home], engineHits)).toEqual(engineHits)
  })

  it('keeps engine hits without lat/lng (Google predictions)', () => {
    const engineHits: AutocompleteResult[] = [
      { id: 'goog:abc', label: 'Some place', shortLabel: 'Some place' },
    ]
    expect(dedupAgainst([home], engineHits)).toEqual(engineHits)
  })

  it('returns input unchanged when there are no primary entries', () => {
    const engineHits: AutocompleteResult[] = [
      { id: 'osm:1', label: 'a', shortLabel: 'a', lat: 1, lng: 1 },
    ]
    expect(dedupAgainst([], engineHits)).toEqual(engineHits)
  })
})
