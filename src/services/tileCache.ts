/**
 * IndexedDB-backed tile cache for offline/fast-load cycling data.
 *
 * Stores pre-fetched region data so subsequent visits load from IndexedDB
 * instead of hitting Overpass. Uses the same IndexedDB pattern as auditCache.ts.
 */

import type { OsmWay } from '../utils/types'
import { CITY_PRESETS } from './audit'
import type { CityPreset } from './audit'

// ── IndexedDB setup ──────────────────────────────────────────────────────

const DB_NAME = 'bike-tile-cache'
const STORE_NAME = 'regions'
const DB_VERSION = 1

export interface CachedRegion {
  name: string
  bbox: { south: number; west: number; north: number; east: number }
  ways: OsmWay[]
  savedAt: number // Date.now()
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Check IndexedDB for a saved region by name.
 * Returns the cached region or null if not found.
 */
export async function getCachedRegion(name: string): Promise<CachedRegion | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).get(name)
    request.onsuccess = () => resolve(request.result ?? null)
    request.onerror = () => reject(request.error)
  })
}

/**
 * Save a region's tile data to IndexedDB.
 */
export async function saveRegion(
  name: string,
  bbox: { south: number; west: number; north: number; east: number },
  ways: OsmWay[],
): Promise<void> {
  const db = await openDB()
  const region: CachedRegion = { name, bbox, ways, savedAt: Date.now() }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(region, name)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * Load a region from IndexedDB by name.
 * Returns the cached region or null if not found.
 */
export async function loadRegion(name: string): Promise<CachedRegion | null> {
  return getCachedRegion(name)
}

/**
 * Get all cached region names from IndexedDB.
 */
async function getAllRegionNames(): Promise<string[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).getAllKeys()
    request.onsuccess = () => resolve(request.result as string[])
    request.onerror = () => reject(request.error)
  })
}

/**
 * Check if a location (with buffer in km) is inside any cached region.
 * The buffer expands the query point into a small bbox and checks overlap
 * with cached region bboxes.
 */
export async function isLocationCached(
  lat: number,
  lng: number,
  bufferKm = 2,
): Promise<{ cached: boolean; regionName: string | null }> {
  const names = await getAllRegionNames()
  if (names.length === 0) return { cached: false, regionName: null }

  // Convert buffer to degrees (approximate)
  const bufferLat = bufferKm / 111.0
  const bufferLng = bufferKm / (111.0 * Math.cos(lat * Math.PI / 180))
  const queryBbox = {
    south: lat - bufferLat,
    north: lat + bufferLat,
    west: lng - bufferLng,
    east: lng + bufferLng,
  }

  for (const name of names) {
    const region = await getCachedRegion(name)
    if (!region) continue
    // Check if query bbox is fully contained within the cached region bbox
    if (
      queryBbox.south >= region.bbox.south &&
      queryBbox.north <= region.bbox.north &&
      queryBbox.west >= region.bbox.west &&
      queryBbox.east <= region.bbox.east
    ) {
      return { cached: true, regionName: name }
    }
  }

  return { cached: false, regionName: null }
}

/**
 * Detect a suggested region name + bbox based on known city presets
 * or a 15km radius circle around the given point.
 */
export function detectRegion(
  lat: number,
  lng: number,
): { name: string; bbox: { south: number; west: number; north: number; east: number } } {
  // Check known city presets
  const match = CITY_PRESETS.find((c: CityPreset) =>
    lat >= c.bbox.south && lat <= c.bbox.north &&
    lng >= c.bbox.west && lng <= c.bbox.east,
  )

  if (match) {
    return { name: match.name.toLowerCase(), bbox: match.bbox }
  }

  // Unknown city: use a 15km radius circle converted to a bbox
  const radiusKm = 15
  const latDelta = radiusKm / 111.0
  const lngDelta = radiusKm / (111.0 * Math.cos(lat * Math.PI / 180))

  return {
    name: `area-${lat.toFixed(2)}-${lng.toFixed(2)}`,
    bbox: {
      south: lat - latDelta,
      north: lat + latDelta,
      west: lng - lngDelta,
      east: lng + lngDelta,
    },
  }
}
