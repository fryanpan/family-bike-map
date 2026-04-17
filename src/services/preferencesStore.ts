/**
 * localStorage-backed store for RiderPreferences.
 *
 * Two keys:
 *   `bike-route-preferences` — array of RiderPreference
 *   `bike-route-active-preference` — id (name) of the currently active one, or null
 *
 * No network, no sync. Encoded with JSON.
 */

import { parsePreferenceText } from '../data/preferenceParser'
import type { RiderPreference } from '../data/preferences'

const PREF_KEY = 'bike-route-preferences'
const ACTIVE_KEY = 'bike-route-active-preference'

export function loadPreferences(): RiderPreference[] {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as RiderPreference[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function loadActivePreferenceName(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY)
  } catch {
    return null
  }
}

export function loadActivePreference(): RiderPreference | null {
  const name = loadActivePreferenceName()
  if (!name) return null
  return loadPreferences().find((p) => p.name === name) ?? null
}

export function saveActivePreferenceName(name: string | null): void {
  try {
    if (name == null) localStorage.removeItem(ACTIVE_KEY)
    else localStorage.setItem(ACTIVE_KEY, name)
  } catch { /* quota */ }
}

/**
 * Upsert a preference. Re-parses the raw text each time so the
 * adjustments stay in sync.
 */
export function upsertPreference(name: string, rawText: string): RiderPreference {
  const { adjustments, unparsed } = parsePreferenceText(rawText)
  const now = Date.now()
  const list = loadPreferences()
  const existing = list.find((p) => p.name === name)
  const pref: RiderPreference = existing
    ? { ...existing, rawText, adjustments, unparsed, updatedAt: now }
    : { name, rawText, adjustments, unparsed, createdAt: now, updatedAt: now }

  const next = existing
    ? list.map((p) => p.name === name ? pref : p)
    : [...list, pref]

  try { localStorage.setItem(PREF_KEY, JSON.stringify(next)) } catch { /* quota */ }
  return pref
}

export function deletePreference(name: string): void {
  const next = loadPreferences().filter((p) => p.name !== name)
  try { localStorage.setItem(PREF_KEY, JSON.stringify(next)) } catch { /* quota */ }
  if (loadActivePreferenceName() === name) saveActivePreferenceName(null)
}
