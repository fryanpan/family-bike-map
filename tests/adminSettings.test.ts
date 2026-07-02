import { describe, expect, test, beforeEach } from 'bun:test'
import { loadSettings, DEFAULT_SETTINGS } from '../src/services/adminSettings'

const STORAGE_KEY = 'family-bike-map:admin-settings:v1'

// bun:test has no DOM — stub the minimal localStorage surface loadSettings
// touches. adminSettings checks `typeof localStorage` at call time, so
// installing the stub before the tests run is sufficient.
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => { store.clear() },
}

describe('adminSettings', () => {
  beforeEach(() => { store.clear() })

  test('steepApproachPushM defaults to 0 (strict moat filter)', () => {
    expect(DEFAULT_SETTINGS.steepApproachPushM).toBe(0)
    expect(loadSettings().steepApproachPushM).toBe(0)
  })

  test('stored settings predating steepApproachPushM merge the default', () => {
    // Simulate a settings blob saved before the field existed.
    const legacy = { ...DEFAULT_SETTINGS } as Record<string, unknown>
    delete legacy.steepApproachPushM
    legacy.overlayOpacityBrowsing = 0.6
    store.set(STORAGE_KEY, JSON.stringify(legacy))

    const loaded = loadSettings()
    expect(loaded.steepApproachPushM).toBe(0)
    // Other stored values survive the merge.
    expect(loaded.overlayOpacityBrowsing).toBe(0.6)
  })

  test('stored steepApproachPushM overrides the default', () => {
    store.set(STORAGE_KEY, JSON.stringify({ steepApproachPushM: 50 }))
    expect(loadSettings().steepApproachPushM).toBe(50)
  })

  test('corrupt stored JSON falls back to defaults', () => {
    store.set(STORAGE_KEY, '{not json')
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS)
  })
})
