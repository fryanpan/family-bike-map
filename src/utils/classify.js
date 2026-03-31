/**
 * Safety classification for Valhalla edge attributes.
 *
 * Valhalla edge.use values (key ones):
 *   0  = road, 18 = living_street, 20 = cycleway, 21 = mountain_bike, 25 = path
 *
 * edge.cycle_lane:
 *   0 = none, 1 = shared (sharrow), 2 = dedicated (painted), 3 = separated, 4 = share_busway
 *
 * edge.road_class:
 *   0 = motorway … 4 = tertiary, 5 = unclassified, 6 = residential, 7 = service
 *
 * edge.bicycle_network:
 *   0 = none, 1+ = some network level (local → international)
 */

export const SAFETY = {
  great:      { label: 'Fahrradstrasse / Car-free path', color: '#16a34a', icon: '🚴', textColor: '#fff' },
  good:       { label: 'Separated bike path',             color: '#2563eb', icon: '🛤️', textColor: '#fff' },
  ok:         { label: 'Dedicated bike lane',             color: '#7c3aed', icon: '〰️', textColor: '#fff' },
  acceptable: { label: 'Quiet street / Bus lane',         color: '#d97706', icon: '🏘️', textColor: '#fff' },
  caution:    { label: 'Road with bike marking',          color: '#ea580c', icon: '⚡', textColor: '#fff' },
  avoid:      { label: 'Busy road — no infra',            color: '#dc2626', icon: '⚠️', textColor: '#fff' },
}

const BAD_SURFACES = new Set([
  'cobblestone', 'paving_stones', 'sett', 'unhewn_cobblestone',
  'cobblestone:flattened', 'gravel', 'unpaved',
])

export function classifyEdge(edge) {
  if (!edge) return 'acceptable'

  const use        = edge.use         ?? 0
  const cycleLane  = edge.cycle_lane  ?? 0
  const roadClass  = edge.road_class  ?? 5
  const bikeNet    = edge.bicycle_network ?? 0
  const surface    = edge.surface     ?? ''

  const badSurface = BAD_SURFACES.has(surface)

  // Dedicated cycleway or known bike network (Fahrradstrasse tagged into network)
  if (use === 20 || use === 25 || bikeNet >= 1) {
    return badSurface ? 'ok' : 'great'
  }

  // Fully separated bike path alongside road
  if (cycleLane === 3) return badSurface ? 'ok' : 'good'

  // Dedicated (painted) bike lane
  if (cycleLane === 2) return badSurface ? 'acceptable' : 'ok'

  // Living street (Spielstraße / Wohnstraße)
  if (use === 18) return 'acceptable'

  // Shared bus lane with bikes
  if (cycleLane === 4) return 'acceptable'

  // Shared marking (sharrow)
  if (cycleLane === 1) {
    return roadClass >= 4 ? 'caution' : 'avoid'
  }

  // Quiet residential or service road
  if (roadClass >= 6) return badSurface ? 'caution' : 'acceptable'

  // Tertiary / unclassified
  if (roadClass >= 4) return 'caution'

  // Primary / secondary / trunk / motorway
  return 'avoid'
}

/**
 * Group an array of { class, coord } items into contiguous segments of the same class.
 * Returns [{ safetyClass, coordinates: [[lat,lng], ...] }, ...]
 */
export function buildSegments(classified) {
  if (!classified.length) return []

  const out = []
  let current = { safetyClass: classified[0].safetyClass, coordinates: [classified[0].coord] }

  for (let i = 1; i < classified.length; i++) {
    const item = classified[i]
    if (item.safetyClass === current.safetyClass) {
      current.coordinates.push(item.coord)
    } else {
      // Carry over last coord so segments are visually connected
      const bridgeCoord = current.coordinates[current.coordinates.length - 1]
      out.push(current)
      current = { safetyClass: item.safetyClass, coordinates: [bridgeCoord, item.coord] }
    }
  }
  out.push(current)
  return out
}
