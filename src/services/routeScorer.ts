import { latLngToTile, getCachedTile, fetchBikeInfraForTile, classifyOsmTagsToItem } from './overpass'
import { buildSegments } from '../utils/classify'
import type { RouteSegment } from '../utils/types'
import type { ClassificationRule } from './rules'
import type { OsmWay } from '../utils/types'

const MATCH_THRESHOLD = 0.0003 // ~30m — max distance to match a route coord to an OsmWay

/**
 * Score a route by matching its coordinates to nearby Overpass tile data.
 * Uses the same classifier as the map overlay for consistent results
 * across all routing engines.
 */
export async function scoreRoute(
  coordinates: [number, number][],
  profileKey: string,
  regionRules?: ClassificationRule[],
): Promise<RouteSegment[]> {
  if (coordinates.length < 2) return []

  // Determine which tiles the route passes through
  const tileKeys = new Set<string>()
  const tiles: Array<{ row: number; col: number }> = []
  for (const [lat, lng] of coordinates) {
    const t = latLngToTile(lat, lng)
    const key = `${t.row}:${t.col}`
    if (!tileKeys.has(key)) {
      tileKeys.add(key)
      tiles.push(t)
    }
  }

  // Load tile data (from cache or fetch)
  const allWays: OsmWay[] = []
  await Promise.all(tiles.map(async (t) => {
    let ways = getCachedTile(t.row, t.col)
    if (!ways) {
      try {
        ways = await fetchBikeInfraForTile(t.row, t.col)
      } catch {
        return // skip failed tiles
      }
    }
    allWays.push(...ways)
  }))

  if (allWays.length === 0) return []

  // For each route coordinate, find the nearest OsmWay and classify it
  const classified = coordinates.map((coord) => {
    const [lat, lng] = coord
    let nearest: { way: OsmWay; dist: number } | null = null

    for (const way of allWays) {
      for (const [wLat, wLng] of way.coordinates) {
        const dLat = Math.abs(lat - wLat)
        const dLng = Math.abs(lng - wLng)
        if (dLat > MATCH_THRESHOLD || dLng > MATCH_THRESHOLD) continue
        const dist = dLat * dLat + dLng * dLng
        if (!nearest || dist < nearest.dist) {
          nearest = { way, dist }
        }
      }
    }

    const itemName = nearest
      ? classifyOsmTagsToItem(nearest.way.tags, profileKey, regionRules)
      : null

    return { itemName, coord }
  })

  return buildSegments(classified)
}
