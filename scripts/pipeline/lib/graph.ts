// coordId-graph passes for the enrichment pipeline (chunk B1):
//
//   - `computeAccessGradientPct` — minimax (bottleneck-shortest-path)
//     Dijkstra from the mainland seed. Bakes the runtime steep-moat
//     question ("what's the gentlest possible approach to this way?")
//     into ONE mode-agnostic number per way: the smallest max-gradient
//     over any path from the mainland. The client's per-mode gate is then
//     pure arithmetic (`accessGradientPct <= ceiling`), monotone in the
//     mode ceiling by construction.
//   - `computeComponentPaintedLenM` — total painted-candidate length of
//     each way's painted component (the baked replacement for the
//     runtime `smallFragmentIds` floating-fragment floor).
//
// Conventions mirror src/services/overlayReachability.ts (the runtime
// implementation this bake supersedes for enriched regions):
//   - node identity = coordId at 5 decimal places (~1.1 m), the router's
//     graph-connectivity convention;
//   - EVERY fetched way participates as an access connector regardless of
//     highway class or paint status — physical access, not pleasantness;
//   - null gradient is fail-soft passable (contributes 0 to a bottleneck);
//   - the mainland seed is picked at a FIXED baseline ceiling so the
//     result is mode-independent (kid-skill monotonicity invariant).
//
// Classification decisions are production imports (`classifyEdge`,
// `isOverlayCrossing`, `isOverlayHiddenSurface`) — no parallel classifier.

import { classifyEdge } from '../../../src/utils/lts'
import { isOverlayCrossing, isOverlayHiddenSurface } from '../../../src/services/overpass'
import type { PipelineWay } from './tiles'

/**
 * Canonical node ID from a coordinate pair. Copied from clientRouter.ts /
 * overlayReachability.ts's private coordId (do not import — clientRouter
 * would drag routing into the pipeline graph, and neither module exports
 * it). 5 decimal places (~1.1 m) snaps nearby endpoints together, matching
 * the router's graph-connectivity convention so the bake and the router
 * agree on what "connected" means. Keep in sync.
 */
export function coordId(lat: number, lng: number): string {
  return `${lat.toFixed(5)},${lng.toFixed(5)}`
}

// Local equirectangular metres-between — same private-copy pattern as
// elevation.ts / overlayReachability.ts's segMeters. Keep in sync.
function segMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const meanLat = ((lat1 + lat2) / 2) * (Math.PI / 180)
  const x = dLng * Math.cos(meanLat)
  return Math.sqrt(dLat * dLat + x * x) * R
}

/** Polyline length in metres (same formula as overlayReachability's wayLengthM). */
export function wayLengthM(coords: ReadonlyArray<[number, number]>): number {
  let lengthM = 0
  for (let i = 1; i < coords.length; i++) {
    lengthM += segMeters(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1])
  }
  return lengthM
}

/**
 * Baseline ceiling (%) for SELECTING the mainland seed — the minimum
 * overlay gradient ceiling across modes (kid-starting-out, 6). Keep in
 * sync with overlayReachability.ts's private MAINLAND_SEED_CEILING_PCT
 * and classify.ts's OVERLAY_MAX_GRADIENT_PCT table.
 *
 * Why fixed: "largest component" re-evaluated per mode ceiling is not
 * monotone — a higher ceiling could crown a different component mainland
 * and hide ways a less capable mode shows. A fixed seed keeps the baked
 * number mode-agnostic (there is no mode input to this module at all).
 */
export const MAINLAND_SEED_CEILING_PCT = 6

// Union-find over dense integer node indexes (path compression + union by
// size). Same semantics as overlayReachability.ts's private string-keyed
// UnionFind; integer-indexed here because a region-scale bake has millions
// of nodes and flat arrays are several times cheaper than string Maps.
class IntUnionFind {
  private parent: number[] = []
  private size: number[] = []

  grow(n: number): void {
    while (this.parent.length < n) {
      this.parent.push(this.parent.length)
      this.size.push(1)
    }
  }

  find(i: number): number {
    let root = i
    while (this.parent[root] !== root) root = this.parent[root]
    let cur = i
    while (cur !== root) {
      const next = this.parent[cur]
      this.parent[cur] = root
      cur = next
    }
    return root
  }

  union(a: number, b: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return
    if (this.size[ra] < this.size[rb]) {
      this.parent[ra] = rb
      this.size[rb] += this.size[ra]
    } else {
      this.parent[rb] = ra
      this.size[ra] += this.size[rb]
    }
  }
}

// Binary min-heap of (priority, node) pairs for the multi-source Dijkstra.
class MinHeap {
  private prio: number[] = []
  private node: number[] = []

  get size(): number {
    return this.prio.length
  }

  push(p: number, v: number): void {
    const prio = this.prio
    const node = this.node
    let i = prio.length
    prio.push(p)
    node.push(v)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (prio[parent] <= prio[i]) break
      ;[prio[parent], prio[i]] = [prio[i], prio[parent]]
      ;[node[parent], node[i]] = [node[i], node[parent]]
      i = parent
    }
  }

  pop(): [number, number] {
    const prio = this.prio
    const node = this.node
    const topP = prio[0]
    const topV = node[0]
    const lastP = prio.pop()!
    const lastV = node.pop()!
    if (prio.length > 0) {
      prio[0] = lastP
      node[0] = lastV
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let smallest = i
        if (l < prio.length && prio[l] < prio[smallest]) smallest = l
        if (r < prio.length && prio[r] < prio[smallest]) smallest = r
        if (smallest === i) break
        ;[prio[smallest], prio[i]] = [prio[i], prio[smallest]]
        ;[node[smallest], node[i]] = [node[i], node[smallest]]
        i = smallest
      }
    }
    return [topP, topV]
  }
}

/**
 * Mirror of BikeMapOverlay pass 0a's MODE-INDEPENDENT candidate gates,
 * expressed through the same production classifiers the overlay calls:
 *
 *   - `classifyEdge(tags).pathLevel !== '4'` (major roads never paint)
 *   - `!isOverlayCrossing(tags)`  (crossing/traffic-island stubs)
 *   - `!isOverlayHiddenSurface(tags)` (rough surfaces)
 *
 * The remaining pass-0a gate — the per-mode preferred-item filter over
 * `classifyOsmTagsToItem` — is deliberately NOT baked: enriched tiles are
 * mode-agnostic (plan decision), so `componentPaintedLenM` is computed
 * over the union-of-modes candidate set and the client applies its mode
 * filter on top.
 */
export function isPaintedCandidate(tags: Record<string, string>): boolean {
  if (classifyEdge(tags).pathLevel === '4') return false
  if (isOverlayCrossing(tags)) return false
  if (isOverlayHiddenSurface(tags)) return false
  return true
}

interface IndexedWay {
  way: PipelineWay
  nodes: number[]
  lengthM: number
}

// Shared node indexer: coordId string → dense integer index.
function indexWays(
  ways: readonly PipelineWay[],
  admit: (way: PipelineWay) => boolean,
): { indexed: IndexedWay[]; nodeCount: number } {
  const nodeIndex = new Map<string, number>()
  const indexed: IndexedWay[] = []
  for (const way of ways) {
    if (way.isControlNode || way.coordinates.length < 2) continue
    if (!admit(way)) continue
    const nodes = way.coordinates.map(([lat, lng]) => {
      const id = coordId(lat, lng)
      let i = nodeIndex.get(id)
      if (i === undefined) {
        i = nodeIndex.size
        nodeIndex.set(id, i)
      }
      return i
    })
    indexed.push({ way, nodes, lengthM: wayLengthM(way.coordinates) })
  }
  return { indexed, nodeCount: nodeIndex.size }
}

/**
 * Minimax access gradient per way: for every real way (≥2 coords), the
 * smallest max-gradient over any path from the mainland seed to any node
 * of the way. Null = no topological path from the seed at all — which may
 * be a data gap (the Overpass-mirror filter never fetches untagged
 * arterials, per overlayReachability caveat 1), so the client treats null
 * as unknown/fail-soft SHOWN, exactly like a null gradientPct.
 *
 *   - Edge weight = the traversed way's own gradientPct; null gradient
 *     weighs 0 (fail-soft — never a barrier).
 *   - Mainland seed = the component with the largest total
 *     baseline-passable length in the graph restricted to ways with
 *     g == null || g <= MAINLAND_SEED_CEILING_PCT. (Strict — the runtime
 *     moat filter's pushBudgetM is an admin knob, applied client-side.)
 *   - Ways inside the seed component get 0. A steep way TOUCHING the
 *     seed also gets 0 — its own gradientPct gate is what hides it,
 *     mirroring computeMoatIsolation's convention.
 *
 * Memory: dense integer node indexes, one flat adjacency array per node,
 * one Float64 distance per node, one scalar per way. No per-vertex
 * elevations, no way geometry beyond the input.
 */
export function computeAccessGradientPct(
  ways: readonly PipelineWay[],
  gradientOf: (osmId: number) => number | null,
): Map<number, number | null> {
  const { indexed, nodeCount } = indexWays(ways, () => true)

  // Mainland seed selection at the fixed baseline ceiling.
  const seedUf = new IntUnionFind()
  seedUf.grow(nodeCount)
  const baselinePassable = (g: number | null): boolean =>
    g == null || g <= MAINLAND_SEED_CEILING_PCT
  for (const r of indexed) {
    if (!baselinePassable(gradientOf(r.way.osmId))) continue
    for (let i = 1; i < r.nodes.length; i++) seedUf.union(r.nodes[i - 1], r.nodes[i])
  }
  const componentLenM = new Map<number, number>()
  for (const r of indexed) {
    if (!baselinePassable(gradientOf(r.way.osmId))) continue
    const root = seedUf.find(r.nodes[0])
    componentLenM.set(root, (componentLenM.get(root) ?? 0) + r.lengthM)
  }
  let seedRoot = -1
  let seedLenM = -1
  for (const [root, lenM] of componentLenM) {
    // Deterministic tie-break on the smaller root index.
    if (lenM > seedLenM || (lenM === seedLenM && root < seedRoot)) {
      seedRoot = root
      seedLenM = lenM
    }
  }

  // Adjacency as flat [neighbor, weight, neighbor, weight, …] per node.
  const adj: number[][] = Array.from({ length: nodeCount }, () => [])
  for (const r of indexed) {
    const w = gradientOf(r.way.osmId) ?? 0
    for (let i = 1; i < r.nodes.length; i++) {
      const a = r.nodes[i - 1]
      const b = r.nodes[i]
      adj[a].push(b, w)
      adj[b].push(a, w)
    }
  }

  // Multi-source minimax Dijkstra: d(v) = min over paths of max edge
  // weight; relaxation is max(), not +.
  const dist = new Float64Array(nodeCount).fill(Infinity)
  const heap = new MinHeap()
  if (seedRoot >= 0) {
    for (let v = 0; v < nodeCount; v++) {
      if (seedUf.find(v) === seedRoot) {
        dist[v] = 0
        heap.push(0, v)
      }
    }
  }
  while (heap.size > 0) {
    const [d, v] = heap.pop()
    if (d > dist[v]) continue // stale heap entry
    const edges = adj[v]
    for (let i = 0; i < edges.length; i += 2) {
      const u = edges[i]
      const w = edges[i + 1]
      const nd = d > w ? d : w
      if (nd < dist[u]) {
        dist[u] = nd
        heap.push(nd, u)
      }
    }
  }

  const result = new Map<number, number | null>()
  for (const r of indexed) {
    let best = Infinity
    for (const node of r.nodes) {
      if (dist[node] < best) best = dist[node]
    }
    result.set(r.way.osmId, Number.isFinite(best) ? best : null)
  }
  return result
}

/**
 * Total painted-candidate length (m) of each painted-candidate way's
 * connected component — the baked input for the client's floating-
 * fragment floor (replaces the runtime `smallFragmentIds` union-find for
 * enriched regions).
 *
 * Connectivity is over painted candidates ONLY (shared 5dp coordIds),
 * mirroring the runtime pass which runs `smallFragmentIds` over pass-0a
 * survivors: a crossing stub or rough-surface way neither paints nor
 * bridges two painted components. Non-candidate ways are absent from the
 * result (their tile field stays null — never painted, floor irrelevant).
 */
export function computeComponentPaintedLenM(
  ways: readonly PipelineWay[],
): Map<number, number> {
  const { indexed, nodeCount } = indexWays(ways, (w) => isPaintedCandidate(w.tags))
  const uf = new IntUnionFind()
  uf.grow(nodeCount)
  for (const r of indexed) {
    for (let i = 1; i < r.nodes.length; i++) uf.union(r.nodes[i - 1], r.nodes[i])
  }
  const componentLenM = new Map<number, number>()
  for (const r of indexed) {
    const root = uf.find(r.nodes[0])
    componentLenM.set(root, (componentLenM.get(root) ?? 0) + r.lengthM)
  }
  const result = new Map<number, number>()
  for (const r of indexed) {
    result.set(r.way.osmId, componentLenM.get(uf.find(r.nodes[0]))!)
  }
  return result
}
