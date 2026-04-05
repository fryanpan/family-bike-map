import { classifyOsmTagsToItem } from './overpass'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuditWay {
  osmId: number
  tags: Record<string, string>
  center?: { lat: number; lon: number }
}

export interface AuditGroup {
  signature: string
  classification: string | null
  wayCount: number
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
    name: 'SF Bay Area',
    bbox: { south: 37.25, west: -122.52, north: 37.81, east: -121.81 },
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
// Overpass query for audit (tags + center only, no geometry)
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
out tags center;
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

interface OverpassAuditElement {
  type: string
  id: number
  tags?: Record<string, string>
  center?: { lat: number; lon: number }
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
      const resp = await fetch(OVERPASS_URL, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })

      if (resp.ok) {
        const data = (await resp.json()) as { elements: OverpassAuditElement[] }
        for (const el of data.elements) {
          if (el.type === 'way' && !seen.has(el.id)) {
            seen.add(el.id)
            allWays.push({
              osmId: el.id,
              tags: el.tags ?? {},
              center: el.center,
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
      group = { signature: sig, classification, wayCount: 0, samples: [] }
      groupMap.set(key, group)
    }
    group.wayCount++
    if (group.samples.length < SAMPLES_PER_GROUP) {
      group.samples.push(way)
    }
  }

  const groups = Array.from(groupMap.values()).sort((a, b) => b.wayCount - a.wayCount)

  return {
    city,
    totalWays: allWays.length,
    groups,
    tilesScanned: tiles.length,
  }
}
