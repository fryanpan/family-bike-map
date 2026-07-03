import type { OsmWay } from '../utils/types'
import { latLngToTile } from './overpass'

// ── Steep-moat reachability filter (overlay display only) ─────────────────
//
// The overlay's per-way steepness gate is local: it hides a way whose OWN
// gradient exceeds the mode ceiling. But family-friendliness is partly a
// reachability property — a flat hilltop park loop passes the local gate
// while being unreachable without a too-steep climb (a "steep moat").
// This module answers the global question: which painted ways belong to a
// component that is NOT connected to the mainland street grid via
// gradient-passable ways?
//
// Two fail-soft caveats shape the algorithm (both bias toward SHOWING):
//
//  1. Connectors are limited to FETCHED ways. The Overpass query
//     (overpass.ts buildQuery) never fetches untagged tertiary/secondary/
//     primary/unclassified streets, so a component whose only real link to
//     the grid is such a street looks disconnected here even though it's
//     perfectly reachable (learnings.md documents these gaps fragmenting
//     the SF graph). Disconnection alone is therefore NOT proof of a moat —
//     we additionally require positive evidence: the component must border
//     at least one known-too-steep way. No steep border ⇒ the isolation is
//     (or may be) a data gap ⇒ shown.
//
//  2. Mainland selection must not depend on the mode's gradient ceiling,
//     or the kid-skill monotonicity invariant breaks (a higher ceiling
//     could crown a different component "mainland" and hide ways a less
//     capable mode shows). The mainland is therefore seeded from the
//     component graph at a FIXED baseline ceiling; per-mode ceilings only
//     ever add connections on top of that fixed seed.
//
// Display-only. The router never consults this — moat-isolated ways stay
// routable (ascent-priced) in clientRouter. Keep this module free of
// routing imports.

export interface MoatOptions {
  /** Mode's overlay gradient ceiling (%) — a way steeper than this is not passable. */
  maxGradientPct: number
  /** Dismount-and-push budget: a steep way no longer than this (metres) still
   * counts as passable (admin setting, 0 = strict). */
  pushBudgetM: number
  /** The caller's cached overlayGradientPct for a way; null = unknown (fail-soft passable). */
  gradientPct: (way: OsmWay) => number | null
  /** Whether the OSM tile at (row, col) is loaded — from BikeMapOverlay's loadedTilesRef. */
  isTileLoaded: (row: number, col: number) => boolean
}

/** Canonical node ID from a coordinate pair.
 * Copied from clientRouter.ts's coordId (do not import — routing must stay
 * out of this module's import graph). Uses 5 decimal places (~1.1m
 * precision) to snap nearby endpoints together, matching the router's
 * graph-connectivity convention so both sides agree on what "connected"
 * means. Keep in sync. */
function coordId(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`
}

// Local equirectangular metres-between — same private pattern as
// elevation.ts's segMeters (copied, not imported, to keep this module
// dependency-light).
function segMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const meanLat = ((lat1 + lat2) / 2) * (Math.PI / 180)
  const x = dLng * Math.cos(meanLat)
  return Math.sqrt(dLat * dLat + x * x) * R
}

function wayLengthM(coords: Array<[number, number]>): number {
  let lengthM = 0
  for (let i = 1; i < coords.length; i++) {
    lengthM += segMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
  }
  return lengthM
}

// ── Union-find over coordIds (path compression + union by size) ──────────

class UnionFind {
  private parent = new Map<string, string>()
  private size = new Map<string, number>()

  add(id: string): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id)
      this.size.set(id, 1)
    }
  }

  find(id: string): string {
    let root = id
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    // Path compression
    let cur = id
    while (cur !== root) {
      const next = this.parent.get(cur)!
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    const sa = this.size.get(ra)!
    const sb = this.size.get(rb)!
    if (sa < sb) {
      this.parent.set(ra, rb)
      this.size.set(rb, sa + sb)
    } else {
      this.parent.set(rb, ra)
      this.size.set(ra, sa + sb)
    }
  }
}

/** Ceiling (%) used to SELECT the mainland component, independent of the
 * caller's per-mode ceiling. Equals the minimum getOverlayMaxGradientPct
 * across modes (kid-starting-out, 6) — keep in sync with classify.ts's
 * OVERLAY_MAX_GRADIENT_PCT table (not imported: this module stays
 * dependency-light, same convention as coordId/segMeters above).
 *
 * Why fixed: mainland = "largest component" re-evaluated per mode ceiling
 * is not monotone — raising the ceiling can merge a rival component past
 * the old mainland's size and flip which one wins, hiding ways a less
 * capable mode showed. With a fixed seed, raising the ceiling only ever
 * adds connections to the seed, so the shown set grows monotonically with
 * kid skill. */
const MAINLAND_SEED_CEILING_PCT = 6

/**
 * Compute the set of moat-isolated way IDs: ways whose connected component
 * (over gradient-passable ways) is disconnected from the mainland street
 * grid AND borders a known-too-steep way (positive moat evidence).
 *
 * Algorithm (see docs/product/plans/steep-moat-filter-plan.md + the header
 * caveats above):
 *  1. A way is passable iff its gradient is unknown (fail-soft), within the
 *     mode ceiling, or short enough to push the bike up (pushBudgetM).
 *     Every FETCHED way participates as a connector regardless of highway
 *     class or paint status — the question is physical access, not
 *     pleasantness (router bridge-walk philosophy). Untagged arterials are
 *     not fetched at all; caveat 1 above covers that hole.
 *  2. Union consecutive coords along passable ways only. Impassable ways
 *     don't union (their nodes may still join via other ways).
 *  3. Mainland seed = largest component (by total passable length) of the
 *     graph at the FIXED baseline ceiling. In the mode-ceiling graph, any
 *     component containing a seed node is connected.
 *  4. Edge fail-soft: a component with any node in an outermost loaded tile
 *     (a loaded tile with an unloaded 4-neighbor) is treated as connected —
 *     its access road may simply not be loaded yet.
 *  5. Moat evidence: a disconnected component is hidden only if it shares a
 *     node with at least one impassable (too-steep-for-this-mode) way.
 *     Otherwise its isolation may just be an unfetched connector street —
 *     shown. (Also monotone: a component with no impassable border cannot
 *     gain members or evidence at a higher ceiling, so it stays shown.)
 *
 * Returns osmIds of isolated ways. Ways with <2 coords (traffic-control
 * pseudo-ways) are skipped and never appear in the result.
 */
export function computeMoatIsolation(ways: OsmWay[], opts: MoatOptions): Set<string | number> {
  const uf = new UnionFind()      // mode-ceiling graph — connectivity + evidence
  const seedUf = new UnionFind()  // fixed-baseline graph — mainland selection only

  const eligible: Array<{ way: OsmWay; lengthM: number; passable: boolean; seedPassable: boolean }> = []
  for (const way of ways) {
    const coords = way.coordinates
    if (coords.length < 2) continue
    const lengthM = wayLengthM(coords)
    const g = opts.gradientPct(way)
    const passable = g == null || g <= opts.maxGradientPct || lengthM <= opts.pushBudgetM
    const seedPassable = g == null || g <= MAINLAND_SEED_CEILING_PCT || lengthM <= opts.pushBudgetM
    // Register every node so component lookups work even for impassable ways.
    for (const [lat, lng] of coords) {
      const id = coordId(lat, lng)
      uf.add(id)
      seedUf.add(id)
    }
    for (let i = 1; i < coords.length; i++) {
      const a = coordId(coords[i - 1][0], coords[i - 1][1])
      const b = coordId(coords[i][0], coords[i][1])
      if (passable) uf.union(a, b)
      if (seedPassable) seedUf.union(a, b)
    }
    eligible.push({ way, lengthM, passable, seedPassable })
  }

  // Mainland seed = baseline-graph component with the largest total
  // baseline-passable way length. Mode-independent by construction.
  const componentLengthM = new Map<string, number>()
  for (const { way, lengthM, seedPassable } of eligible) {
    if (!seedPassable) continue
    const root = seedUf.find(coordId(way.coordinates[0][0], way.coordinates[0][1]))
    componentLengthM.set(root, (componentLengthM.get(root) ?? 0) + lengthM)
  }
  let seedRoot: string | null = null
  let seedLengthM = -1
  for (const [root, lengthM] of componentLengthM) {
    if (lengthM > seedLengthM) {
      seedRoot = root
      seedLengthM = lengthM
    }
  }

  // Edge fail-soft: cache per tile key whether the tile is "outermost"
  // (loaded, with at least one unloaded 4-neighbor).
  const outermostCache = new Map<string, boolean>()
  const isOutermostTile = (lat: number, lng: number): boolean => {
    const { row, col } = latLngToTile(lat, lng)
    const key = `${row}:${col}`
    const cached = outermostCache.get(key)
    if (cached !== undefined) return cached
    const outermost =
      opts.isTileLoaded(row, col) &&
      (!opts.isTileLoaded(row - 1, col) ||
        !opts.isTileLoaded(row + 1, col) ||
        !opts.isTileLoaded(row, col - 1) ||
        !opts.isTileLoaded(row, col + 1))
    outermostCache.set(key, outermost)
    return outermost
  }

  // Mode-graph components that are connected: any component containing a
  // node of the fixed mainland seed component, plus edge-fail-soft ones.
  const connectedRoots = new Set<string>()
  for (const { way } of eligible) {
    for (const [lat, lng] of way.coordinates) {
      const id = coordId(lat, lng)
      if (seedRoot != null && seedUf.find(id) === seedRoot) connectedRoots.add(uf.find(id))
      if (isOutermostTile(lat, lng)) connectedRoots.add(uf.find(id))
    }
  }

  // Moat evidence: mode-graph components that share a node with at least
  // one impassable way. Only these are candidates for hiding — a
  // disconnected component with NO steep border may simply hang off an
  // unfetched connector street (header caveat 1).
  const steepBorderedRoots = new Set<string>()
  for (const { way, passable } of eligible) {
    if (passable) continue
    for (const [lat, lng] of way.coordinates) steepBorderedRoots.add(uf.find(coordId(lat, lng)))
  }

  // A way is isolated iff none of its coords belong to a connected
  // component AND at least one belongs to a steep-bordered one. (Passable
  // ways have all coords in one component; an impassable way touching the
  // mainland counts as connected — the existing per-way local gate is what
  // hides it.)
  const isolated = new Set<string | number>()
  for (const { way } of eligible) {
    let connected = false
    let bordersSteep = false
    for (const [lat, lng] of way.coordinates) {
      const root = uf.find(coordId(lat, lng))
      if (connectedRoots.has(root)) { connected = true; break }
      if (steepBorderedRoots.has(root)) bordersSteep = true
    }
    if (!connected && bordersSteep) isolated.add(way.osmId)
  }
  return isolated
}

// ── Stub verdict inheritance ───────────────────────────────────────────────
//
// The per-way gates can't grade ways shorter than the gradient noise floor
// (MIN_GRADED_LEN_M in elevation.ts) — their gradient is null and they
// fail-soft SHOWN. Individually that's correct, but when the LONG ways
// around them get hidden (local gate or moat), the surviving stubs paint a
// white halo around a sliver of colour and the map fills with white pill
// confetti — the #208→#209 revert artifact. The principled fix: an
// ungradable stub inherits the verdict of its graded painted context
// instead of defaulting to shown.
//
// Conservative by construction:
//  - Verdicts only FLOW INTO unknowns from graded painted neighbours; a
//    graded way's own verdict never changes here.
//  - A stub group adjacent to ANY shown graded way stays shown.
//  - A stub group with NO graded painted adjacency at all keeps the old
//    fail-soft (shown) — standalone stubs predate the gates and hiding
//    them would be a behaviour change with no context to justify it.

export type StubVerdict = 'shown' | 'hidden' | 'unknown'

/**
 * Floating-fragment suppression for the overview map: given the ways that
 * SURVIVED all visibility gates, return the osmIds whose connected painted
 * component totals less than `minLenM` of length. These are the "floating
 * short segments" that read as noise at city-overview zooms — real routing
 * connectors, but not worth advertising as infrastructure. Display-only;
 * the caller zoom-gates this (fragments show again at street-detail zooms)
 * and routing never consults it. Superseded by the enriched-tile
 * `componentPaintedLenM` field once the pipeline lands (see
 * docs/product/plans/enriched-tiles-plan.md).
 */
export function smallFragmentIds(ways: OsmWay[], minLenM: number): Set<string | number> {
  const uf = new UnionFind()
  const lengths = new Map<string | number, number>()
  for (const way of ways) {
    if (way.coordinates.length < 2) continue
    lengths.set(way.osmId, wayLengthM(way.coordinates))
    const first = coordId(way.coordinates[0][0], way.coordinates[0][1])
    uf.add(first)
    for (let i = 1; i < way.coordinates.length; i++) {
      const id = coordId(way.coordinates[i][0], way.coordinates[i][1])
      uf.add(id)
      uf.union(first, id)
    }
  }
  const componentLenM = new Map<string, number>()
  for (const way of ways) {
    const len = lengths.get(way.osmId)
    if (len === undefined) continue
    const root = uf.find(coordId(way.coordinates[0][0], way.coordinates[0][1]))
    componentLenM.set(root, (componentLenM.get(root) ?? 0) + len)
  }
  const small = new Set<string | number>()
  for (const way of ways) {
    if (lengths.get(way.osmId) === undefined) continue
    const root = uf.find(coordId(way.coordinates[0][0], way.coordinates[0][1]))
    if ((componentLenM.get(root) ?? 0) < minLenM) small.add(way.osmId)
  }
  return small
}

/**
 * Given the painted candidate ways and each way's gate verdict ('unknown' =
 * gradient null, i.e. below the noise floor), return the ADDITIONAL osmIds
 * to hide: unknown ways whose entire graded painted adjacency is hidden.
 *
 * Groups of unknowns are formed over shared coordIds (a chain of stubs
 * inherits as a unit); a group is hidden iff it touches at least one graded
 * candidate and every graded candidate it touches is hidden.
 */
export function inheritStubVerdicts(
  candidates: OsmWay[],
  verdictOf: (way: OsmWay) => StubVerdict,
): Set<string | number> {
  const unknowns: OsmWay[] = []
  // coordId → graded adjacency at that node.
  const gradedAt = new Map<string, { shown: boolean; hidden: boolean }>()

  for (const way of candidates) {
    if (way.coordinates.length < 2) continue
    const v = verdictOf(way)
    if (v === 'unknown') {
      unknowns.push(way)
      continue
    }
    for (const [lat, lng] of way.coordinates) {
      const id = coordId(lat, lng)
      const g = gradedAt.get(id) ?? { shown: false, hidden: false }
      if (v === 'shown') g.shown = true
      else g.hidden = true
      gradedAt.set(id, g)
    }
  }
  if (unknowns.length === 0) return new Set()

  // Group unknowns over shared nodes so a chain of stubs inherits as one.
  const uf = new UnionFind()
  for (const way of unknowns) {
    const first = coordId(way.coordinates[0][0], way.coordinates[0][1])
    uf.add(first)
    for (let i = 1; i < way.coordinates.length; i++) {
      const id = coordId(way.coordinates[i][0], way.coordinates[i][1])
      uf.add(id)
      uf.union(first, id)
    }
  }

  // Per group: does it touch any shown graded way? any hidden one?
  const groupTouch = new Map<string, { shown: boolean; hidden: boolean }>()
  for (const way of unknowns) {
    const root = uf.find(coordId(way.coordinates[0][0], way.coordinates[0][1]))
    const t = groupTouch.get(root) ?? { shown: false, hidden: false }
    for (const [lat, lng] of way.coordinates) {
      const g = gradedAt.get(coordId(lat, lng))
      if (g) {
        t.shown ||= g.shown
        t.hidden ||= g.hidden
      }
    }
    groupTouch.set(root, t)
  }

  const hidden = new Set<string | number>()
  for (const way of unknowns) {
    const t = groupTouch.get(uf.find(coordId(way.coordinates[0][0], way.coordinates[0][1])))!
    if (t.hidden && !t.shown) hidden.add(way.osmId)
  }
  return hidden
}
