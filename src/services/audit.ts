import { classifyOsmTagsToItem } from './overpass'
import type { ClassificationRule } from './rules'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditWay {
  osmId: number
  tags: Record<string, string>
  center?: { lat: number; lon: number }
  lengthKm: number
}

export interface AuditGroup {
  signature: string
  classification: string | null
  wayCount: number
  totalDistanceKm: number
  samples: AuditWay[]
}

export interface CityScan {
  city: string
  totalWays: number
  groups: AuditGroup[]
  tilesScanned: number
}

export interface CityPreset {
  name: string
  bbox: { south: number; west: number; north: number; east: number }
}

export const CITY_PRESETS: CityPreset[] = [
  {
    name: 'Berlin',
    bbox: { south: 52.34, west: 13.08, north: 52.68, east: 13.76 },
  },
  {
    name: 'Copenhagen',
    bbox: { south: 55.61, west: 12.45, north: 55.73, east: 12.65 },
  },
  {
    name: 'Hamburg',
    bbox: { south: 53.4, west: 9.8, north: 53.65, east: 10.2 },
  },
  {
    name: 'San Francisco',
    bbox: { south: 37.70, west: -122.52, north: 37.81, east: -122.35 },
  },
  {
    name: 'Oakland',
    bbox: { south: 37.73, west: -122.33, north: 37.85, east: -122.16 },
  },
  {
    name: 'Berkeley',
    bbox: { south: 37.85, west: -122.32, north: 37.92, east: -122.23 },
  },
  {
    name: 'Marin',
    bbox: { south: 37.83, west: -122.60, north: 38.08, east: -122.40 },
  },
]

// ---------------------------------------------------------------------------
// Tile sampling
// ---------------------------------------------------------------------------

const TILE_SIZE = 0.1

export function sampleTiles(
  bbox: { south: number; west: number; north: number; east: number },
  count: number,
): Array<{ south: number; west: number; north: number; east: number }> {
  const tiles: Array<{ south: number; west: number; north: number; east: number }> = []

  const minRow = Math.floor(bbox.south / TILE_SIZE)
  const maxRow = Math.floor(bbox.north / TILE_SIZE)
  const minCol = Math.floor(bbox.west / TILE_SIZE)
  const maxCol = Math.floor(bbox.east / TILE_SIZE)

  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      tiles.push({
        south: r * TILE_SIZE,
        west: c * TILE_SIZE,
        north: (r + 1) * TILE_SIZE,
        east: (c + 1) * TILE_SIZE,
      })
    }
  }

  // Fisher-Yates shuffle
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[tiles[i], tiles[j]] = [tiles[j], tiles[i]]
  }

  return tiles.slice(0, count)
}

// ---------------------------------------------------------------------------
// Overpass query for audit (full geometry for distance calculation)
// ---------------------------------------------------------------------------

export function buildAuditQuery(bbox: { south: number; west: number; north: number; east: number }): string {
  const { south, west, north, east } = bbox
  const b = `${south},${west},${north},${east}`
  return `
[out:json][timeout:25];
(
  way["highway"="cycleway"](${b});
  way["bicycle_road"="yes"](${b});
  way["cyclestreet"="yes"](${b});
  way["highway"="living_street"](${b});
  way["highway"~"^(residential|tertiary|unclassified)$"](${b});
  way["highway"="service"]["service"!="parking_aisle"](${b});
  way["highway"~"^(path|track)$"]["bicycle"!="no"](${b});
  way["highway"="footway"]["bicycle"~"^(yes|designated)$"](${b});
  way[~"^cycleway(:right|:left|:both)?$"~"^(track|lane|opposite_track|opposite_lane|share_busway)$"](${b});
);
out geom;
`
}

// ---------------------------------------------------------------------------
// Tag signature
// ---------------------------------------------------------------------------

const SIGNATURE_KEYS = [
  'highway',
  'bicycle_road',
  'cyclestreet',
  'cycleway',
  'cycleway:right',
  'cycleway:left',
  'cycleway:both',
  'surface',
  'smoothness',
  'maxspeed',
  'bicycle',
  'segregated',
  'tracktype',
] as const

export function tagSignature(tags: Record<string, string>): string {
  return SIGNATURE_KEYS
    .filter((k) => tags[k] != null)
    .map((k) => `${k}=${tags[k]}`)
    .join('|')
}

// ---------------------------------------------------------------------------
// City scan
// ---------------------------------------------------------------------------

const OVERPASS_URL = '/api/overpass'
const TILES_PER_SCAN = 20
const SAMPLES_PER_GROUP = 5
const INTER_TILE_PAUSE_MS = 2000

/** Haversine distance in km between two lat/lng points. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** Compute total length of a way geometry in km. */
function wayLengthKm(geometry: Array<{ lat: number; lon: number }>): number {
  let total = 0
  for (let i = 1; i < geometry.length; i++) {
    total += haversineKm(geometry[i - 1].lat, geometry[i - 1].lon, geometry[i].lat, geometry[i].lon)
  }
  return total
}

interface OverpassAuditElement {
  type: string
  id: number
  tags?: Record<string, string>
  center?: { lat: number; lon: number }
  geometry?: Array<{ lat: number; lon: number }>
}

export async function scanCity(
  city: string,
  bbox: { south: number; west: number; north: number; east: number },
  onProgress?: (done: number, total: number) => void,
): Promise<CityScan> {
  const tiles = sampleTiles(bbox, TILES_PER_SCAN)
  const seen = new Set<number>()
  const allWays: AuditWay[] = []

  for (let i = 0; i < tiles.length; i++) {
    const tile = tiles[i]
    const query = buildAuditQuery(tile)

    try {
      // Pass audit-prefixed row/col so the Worker cache key doesn't collide
      // with the overlay tile cache (which uses a different query format).
      const resp = await fetch(`${OVERPASS_URL}?row=audit-${Math.floor(tile.south / TILE_SIZE)}&col=${Math.floor(tile.west / TILE_SIZE)}`, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })

      if (resp.ok) {
        const data = (await resp.json()) as { elements: OverpassAuditElement[] }
        for (const el of data.elements) {
          if (el.type === 'way' && !seen.has(el.id)) {
            seen.add(el.id)
            // Derive center from geometry midpoint when center isn't provided
            const geom = el.geometry ?? []
            const mid = geom.length > 0 ? geom[Math.floor(geom.length / 2)] : null
            allWays.push({
              osmId: el.id,
              tags: el.tags ?? {},
              center: el.center ?? (mid ? { lat: mid.lat, lon: mid.lon } : undefined),
              lengthKm: geom.length > 1 ? wayLengthKm(geom) : 0,
            })
          }
        }
      }
    } catch {
      // Skip failed tiles — partial results are fine for auditing
    }

    onProgress?.(i + 1, tiles.length)

    // Rate-limit pause between tiles (skip after last tile)
    if (i < tiles.length - 1) {
      await new Promise((r) => setTimeout(r, INTER_TILE_PAUSE_MS))
    }
  }

  // Group by signature + classification
  const groupMap = new Map<string, AuditGroup>()
  for (const way of allWays) {
    const sig = tagSignature(way.tags)
    const classification = classifyOsmTagsToItem(way.tags, 'toddler')
    const key = `${sig}|||${classification ?? '__null__'}`

    let group = groupMap.get(key)
    if (!group) {
      group = { signature: sig, classification, wayCount: 0, totalDistanceKm: 0, samples: [] }
      groupMap.set(key, group)
    }
    group.wayCount++
    group.totalDistanceKm += way.lengthKm
    if (group.samples.length < SAMPLES_PER_GROUP) {
      group.samples.push(way)
    }
  }

  const groups = Array.from(groupMap.values()).sort((a, b) => b.totalDistanceKm - a.totalDistanceKm)

  return {
    city,
    totalWays: allWays.length,
    groups,
    tilesScanned: tiles.length,
  }
}

/**
 * Re-evaluate group classifications against the current rules.
 * Uses the first sample's tags as representative for the group.
 */
export function reclassifyGroups(scan: CityScan, regionRules: ClassificationRule[]): CityScan {
  const groups = scan.groups.map((g) => {
    const tags = g.samples[0]?.tags
    if (!tags) return g
    const classification = classifyOsmTagsToItem(tags, 'toddler', regionRules)
    if (classification === g.classification) return g
    return { ...g, classification }
  })
  return { ...scan, groups }
}
