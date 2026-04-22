// Runtime-tweakable admin settings persisted in localStorage.
//
// Everything here is a USER preference with a hardcoded default. The
// Admin Tools → Settings tab edits these live; consumers subscribe via
// useAdminSettings() and re-render on change.
//
// Keeping this in a single module + single localStorage key means all
// settings migrate together and there's no risk of partial state.

import { useSyncExternalStore } from 'react'
import type { RideMode } from '../data/modes'
import type { PathLevel } from '../utils/lts'

const STORAGE_KEY = 'family-bike-map:admin-settings:v1'

export interface TierStyle {
  color: string
  /** Line weight multiplier relative to base overlay weight. */
  weight: number
}

export interface ModeRoutingParams {
  ridingSpeedKmh: number
  slowSpeedKmh: number
  walkingSpeedKmh: number
  /** Per-path-level cost multiplier (1.0 = no penalty). */
  levelMultipliers: Partial<Record<PathLevel, number>>
  /** Multiplier applied on top when the way is on a rough surface. */
  roughSurfaceMultiplier: number
}

export interface AdminSettings {
  /** Per-tier display styling. Colors are hex strings. */
  tiers: Record<PathLevel, TierStyle>
  /** Halo weight added to line weight when the overlay has a halo. */
  overlayHaloExtra: number
  /** Overlay opacity when a route is actively drawn. */
  overlayOpacityWithRoute: number
  /** Overlay opacity when browsing (no route). */
  overlayOpacityBrowsing: number
  /** Route line width (uniform across tiers). */
  routeLineWeight: number
  routeLineWeightSelected: number
  /** Route halo extra width (px added to routeLineWeight). */
  routeHaloExtra: number
  /** Global rough-surface cost multiplier — applied on top of per-mode. */
  roughSurfaceMultiplierGlobal: number
  /** Toggle: include LTS 2b / 3 in the preferred-legend for modes that
   *  currently route them but don't display them as preferred. Default
   *  false — "quiet residential" and "higher traffic" stay off the map
   *  legend unless the user explicitly opts in. */
  showNonPreferredInLegend: boolean
  /** Toggle: show the "Training" mode in the mode picker. Default off. */
  showTrainingMode: boolean
  /** Per-mode routing parameters. Merge with compiled defaults from
   *  MODE_RULES — user-edited values win. */
  modeRouting: Partial<Record<RideMode, Partial<ModeRoutingParams>>>
}

export const DEFAULT_SETTINGS: AdminSettings = {
  tiers: {
    '1a': { color: '#004529', weight: 0.75 },
    '1b': { color: '#238443', weight: 0.75 },
    '2a': { color: '#2b8cbe', weight: 0.75 },
    '2b': { color: '#e78ac3', weight: 0.75 },
    '3':  { color: '#ffd92f', weight: 0.75 },
    '4':  { color: '#999999', weight: 0.4 },
  },
  overlayHaloExtra: 4,
  overlayOpacityWithRoute: 0.35,
  overlayOpacityBrowsing: 1.0,
  routeLineWeight: 7,
  routeLineWeightSelected: 8,
  routeHaloExtra: 3,
  roughSurfaceMultiplierGlobal: 5.0,
  showNonPreferredInLegend: false,
  showTrainingMode: false,
  modeRouting: {},
}

// ── Load/save ──────────────────────────────────────────────────────────────

function deepMerge<T>(base: T, override: unknown): T {
  if (!override || typeof override !== 'object') return base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const b = out[k]
    if (b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(b, v)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out as T
}

export function loadSettings(): AdminSettings {
  if (typeof localStorage === 'undefined') return DEFAULT_SETTINGS
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    return deepMerge(DEFAULT_SETTINGS, JSON.parse(raw))
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function saveSettings(settings: AdminSettings): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
    // Notify subscribers.
    listeners.forEach((l) => l())
  } catch (err) {
    console.warn('[adminSettings] save failed:', err)
  }
}

export function resetSettings(): void {
  saveSettings(DEFAULT_SETTINGS)
}

// ── React subscription ─────────────────────────────────────────────────────

const listeners = new Set<() => void>()
let cache: AdminSettings | null = null

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function getSnapshot(): AdminSettings {
  if (!cache) cache = loadSettings()
  return cache
}

/** Invalidate the cached snapshot so next read reloads from storage. */
function invalidate(): void { cache = null }

// Wrap save to invalidate cache + notify.
const originalSave = saveSettings
export function setSettings(next: AdminSettings): void {
  cache = next
  originalSave(next)
}

// Listen for cross-tab updates.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) {
      invalidate()
      listeners.forEach((l) => l())
    }
  })
}

/**
 * React hook — returns the current admin settings and re-renders on change.
 * Usage: const settings = useAdminSettings()
 */
export function useAdminSettings(): AdminSettings {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Patch a top-level field and persist. */
export function updateSetting<K extends keyof AdminSettings>(key: K, value: AdminSettings[K]): void {
  const current = getSnapshot()
  setSettings({ ...current, [key]: value })
}
