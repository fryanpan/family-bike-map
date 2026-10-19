/**
 * Edge-keyed A* with turn & intersection transition costs.
 *
 * ngraph.path's A* is node-keyed: its cost callback sees only the link being
 * relaxed, never the link the search arrived on — so angle-dependent turn
 * costs are unrepresentable (the best path INTO a node depends on the
 * approach direction). The standard fix, used by OSRM (edge-expanded graph)
 * and Valhalla (per-directed-edge labels), is to key the search on directed
 * edges. We do that here WITHOUT materialising a line graph: labels are
 * ngraph Link objects, neighbours are enumerated from the existing node
 * adjacency, so memory stays ∝ visited links.
 *
 * Transition model (docs/product/plans/2026-06-11-turn-cost-design.md):
 *   - turn maneuver time  → cost + duration  (real time)
 *   - turn penalty        → cost only        (path shaping, Valhalla-style)
 *   - signal / stop waits → cost + duration  (expected average waits)
 *
 * Turn costs apply only at junctions (≥3 unique neighbours) so curves within
 * a winding way cost nothing; signal/stop waits apply wherever the control
 * node sits. Walking (dismounted) transitions skip turn costs — turning a
 * walked bike is trivial — but still wait at signals like any pedestrian.
 */
import type { Graph, Link, NodeId } from 'ngraph.graph'
import type { ModeRule } from '../data/modes'
import type { NodeData, EdgeData } from './clientRouter'
import { parseMaxspeedKmh, speedDefaultForClass } from '../utils/lts'

export interface EdgeSearchResult {
  /** Links in path order, start → end. */
  links: Array<Link<EdgeData>>
  /** Total expected travel time, including turn maneuvers + control waits. */
  durationSec: number
  /** Junction turns ≥ 60° along the path (the "instructions" count). */
  turnCount: number
}

// ── Geometry helpers ────────────────────────────────────────────────────────

/** Bearing in degrees clockwise from north, [0, 360). Equirectangular is
 *  plenty for single graph segments (tens of metres). */
function bearingDeg(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const dLng = (toLng - fromLng) * Math.cos(((fromLat + toLat) / 2) * (Math.PI / 180))
  const dLat = toLat - fromLat
  const deg = (Math.atan2(dLng, dLat) * 180) / Math.PI
  return (deg + 360) % 360
}

/** Signed turn delta out−in, normalised to (-180, 180]. Negative = left
 *  (counterclockwise) in compass bearings. */
export function turnDelta(bearingIn: number, bearingOut: number): number {
  let d = bearingOut - bearingIn
  while (d > 180) d -= 360
  while (d <= -180) d += 360
  return d
}

// ── Junction detection ──────────────────────────────────────────────────────

// ── Unsignalized major-road crossings ───────────────────────────────────────

// The road classes a family rider has to cross rather than ride (Joanna
// 2026-04-29, research item #4). Secondary and tertiary are excluded on
// purpose: in Berlin a secondary is an ordinary Hauptstrasse with a signal at
// most junctions, and charging every unsignalised one would penalise the whole
// grid rather than the genuinely hostile crossings.
const MAJOR_CROSSING_CLASSES = new Set(['primary', 'trunk'])
const MAJOR_CROSSING_MIN_KMH = 50

/** Speed of a way for the crossing test: posted, else the class default. Uses
 *  the same two primitives as classifyEdge so there is no second speed table
 *  to drift from. */
function waySpeedKmh(tags: Record<string, string>): number | null {
  return parseMaxspeedKmh(tags.maxspeed) ?? speedDefaultForClass(tags.highway ?? '')
}

/** The major-road links incident to each node, for nodes that have any. A node
 *  missing from the map has none. Cached per graph: the graph is rebuilt
 *  whenever the tile set or mode changes. The links, not just their way ids,
 *  because the crossing test needs the bearing of each arm. */
const majorLinksCache = new WeakMap<
  Graph<NodeData, EdgeData>,
  Map<NodeId, Array<Link<EdgeData>>>
>()

function majorLinksByNode(graph: Graph<NodeData, EdgeData>): Map<NodeId, Array<Link<EdgeData>>> {
  const cached = majorLinksCache.get(graph)
  if (cached) return cached
  const out = new Map<NodeId, Array<Link<EdgeData>>>()
  graph.forEachNode((node) => {
    const links = graph.getLinks(node.id)
    if (!links) return
    for (const link of links) {
      const tags = link.data.wayTags
      if (!MAJOR_CROSSING_CLASSES.has(tags.highway ?? '')) continue
      const speed = waySpeedKmh(tags)
      if (speed == null || speed < MAJOR_CROSSING_MIN_KMH) continue
      const arms = out.get(node.id)
      if (arms) arms.push(link)
      else out.set(node.id, [link])
    }
  })
  majorLinksCache.set(graph, out)
  return out
}

/** Bearing from `nodeId` out along `link`, whichever end of it the node is. */
function armBearing(
  graph: Graph<NodeData, EdgeData>,
  nodeId: NodeId,
  link: Link<EdgeData>,
): number | null {
  const here = graph.getNode(nodeId)
  const otherId = link.fromId === nodeId ? link.toId : link.fromId
  const other = graph.getNode(otherId)
  if (!here || !other) return null
  return bearingDeg(here.data.lat, here.data.lng, other.data.lat, other.data.lng)
}

/** The major road has to PASS THROUGH the node for a crossing to be possible:
 *  two of its arms pointing roughly opposite ways. Returns the bearing of one
 *  of them, which is the axis to measure sides against, or null when the road
 *  merely ends here. A T-junction where a primary terminates cannot be
 *  crossed, and charging it was the first version's most common false
 *  positive. */
const MAJOR_THROUGH_MIN_DEG = 135

function majorAxisDeg(bearings: number[]): number | null {
  for (let i = 0; i < bearings.length; i++) {
    for (let j = i + 1; j < bearings.length; j++) {
      if (Math.abs(turnDelta(bearings[i], bearings[j])) >= MAJOR_THROUGH_MIN_DEG) return bearings[i]
    }
  }
  return null
}

/** How far off the axis a leg must lie before it counts as being on one side
 *  of the road rather than running along it. sin 25° — generous on purpose:
 *  ambiguous geometry goes uncharged, because a false crossing charge
 *  distorts the route while a missed one only leaves the previous behaviour. */
const SIDE_MIN_SIN = Math.sin((25 * Math.PI) / 180)

/** Which side of `axisDeg` the point at `bearingDeg` lies on: +1, -1, or 0 for
 *  "too close to the axis to call". */
function sideOfAxis(bearing: number, axisDeg: number): number {
  const s = Math.sin((turnDelta(axisDeg, bearing) * Math.PI) / 180)
  return Math.abs(s) < SIDE_MIN_SIN ? 0 : Math.sign(s)
}

// Unique-neighbour count per node, cached per graph instance. A node is a
// junction (a place where a navigating human makes a decision) iff it has
// ≥3 unique neighbours — true at T- and 4-way intersections, false at the
// degree-2 vertices that merely shape a curve within a way.
const junctionCache = new WeakMap<object, Map<NodeId, number>>()

function uniqueNeighbourCounts(graph: Graph<NodeData, EdgeData>): Map<NodeId, number> {
  const cached = junctionCache.get(graph)
  if (cached) return cached
  const counts = new Map<NodeId, number>()
  graph.forEachNode((node) => {
    const links = graph.getLinks(node.id)
    if (!links) return
    const neighbours = new Set<NodeId>()
    for (const link of links) {
      neighbours.add(link.fromId === node.id ? link.toId : link.fromId)
    }
    counts.set(node.id, neighbours.size)
  })
  junctionCache.set(graph, counts)
  return counts
}

// ── Binary min-heap on f ────────────────────────────────────────────────────

interface Label {
  link: Link<EdgeData>
  g: number          // accumulated routing cost
  dur: number        // accumulated real duration
  turns: number
  parent: Label | null
  f: number
  closed: boolean
}

class MinHeap {
  private a: Label[] = []
  get size(): number { return this.a.length }
  push(l: Label): void {
    const a = this.a
    a.push(l)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].f <= a[i].f) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop(): Label | undefined {
    const a = this.a
    const top = a[0]
    const last = a.pop()
    if (a.length && last) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < a.length && a[l].f < a[m].f) m = l
        if (r < a.length && a[r].f < a[m].f) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}

// ── Search ──────────────────────────────────────────────────────────────────

export function edgeAStar(
  graph: Graph<NodeData, EdgeData>,
  startId: NodeId,
  endId: NodeId,
  rule: ModeRule,
  heuristicMaxSpeedMs: number,
): EdgeSearchResult | null {
  if (startId === endId) return { links: [], durationSec: 0, turnCount: 0 }
  const endNode = graph.getNode(endId)
  if (!endNode) return null
  const junctions = uniqueNeighbourCounts(graph)

  const h = (nodeId: NodeId): number => {
    const n = graph.getNode(nodeId)
    if (!n) return 0
    // Same admissible lower bound the node A* used: crow-fly distance at the
    // mode's top speed. Transition costs are non-negative, so it stays
    // admissible for the edge-keyed search too.
    const dLat = (n.data.lat - endNode.data.lat) * 111_320
    const dLng = (n.data.lng - endNode.data.lng) * 111_320 *
      Math.cos(((n.data.lat + endNode.data.lat) / 2) * (Math.PI / 180))
    return Math.sqrt(dLat * dLat + dLng * dLng) / heuristicMaxSpeedMs
  }

  /**
   * Cost of transitioning from l1 into l2 at the shared node. Returns the
   * routing-cost delta, the real-duration delta, and whether it counts as a
   * navigational turn.
   */
  const transition = (l1: Link<EdgeData>, l2: Link<EdgeData>): { cost: number; dur: number; isTurn: boolean } => {
    const nodeId = l1.toId
    const node = graph.getNode(nodeId)
    const from = graph.getNode(l1.fromId)
    const to = graph.getNode(l2.toId)
    if (!node || !from || !to) return { cost: 0, dur: 0, isTurn: false }

    const bIn = bearingDeg(from.data.lat, from.data.lng, node.data.lat, node.data.lng)
    const bOut = bearingDeg(node.data.lat, node.data.lng, to.data.lat, to.data.lng)
    const delta = turnDelta(bIn, bOut)
    const abs = Math.abs(delta)

    let cost = 0
    let dur = 0
    let isTurn = false

    // Control-node waits — real time, charged dismounted or not.
    if (node.data.control === 'signal' && rule.signalWaitSec) {
      // A left through a signal is the two-stage crossing for family modes.
      const left = abs >= 30 && delta < 0
      let wait = left ? rule.signalWaitSec.left : rule.signalWaitSec.through
      // Corridor continuation: straight along the SAME named street through
      // its own signal usually rides the green wave / protected phase — the
      // full expected wait belongs to the cross street. Halve it. Without
      // this, riding along an arterial pays full wait at every block and A*
      // starts preferring bridge-walk shortcuts over corridor riding (SF
      // carrying-kid dropped 6pp preferred in the 2026-06-11 benchmark).
      const name1 = l1.data.wayTags.name
      if (!left && abs < 30 && name1 && name1 === l2.data.wayTags.name) wait *= 0.5
      cost += wait
      dur += wait
    } else if (node.data.control === 'stop' && rule.stopSignWaitSec) {
      cost += rule.stopSignWaitSec
      dur += rule.stopSignWaitSec
    } else if (
      node.data.control == null &&
      rule.unsignalizedMajorCrossingSec &&
      !l1.data.isWalking &&
      !l2.data.isWalking
    ) {
      // `control == null` is the whole point of this branch and is tested
      // explicitly rather than inferred from falling off the chain above: a
      // mode that mapped no `signalWaitSec` would otherwise reach here AT a
      // signalised junction and be charged the unsignalised wait, which is
      // backwards. Every mode prices signals today, so this guard changes no
      // current route; it stops a future mode or city profile from inverting
      // the cost by omission.
      //
      // A rider who crosses a major road here waits for a gap in 50 km/h
      // traffic — real time, and the reason to detour a block to a signal.
      //
      // Incidence is NOT enough to establish a crossing, and treating it as
      // enough over-charges two common geometries. A T-junction where the
      // major road ends: every turn between the other arms was charged though
      // nothing is crossed. Worse, a Berlin Hauptstrasse sidepath is a
      // SEPARATE way from the road it follows, so riding ALONG one was charged
      // at every side street — exactly the "riding along, not across" case the
      // cost is supposed to exclude, missed because the exclusion compared way
      // ids. Both need geometry: the road must pass through the node, and the
      // legs either side of the node must lie on opposite sides of it.
      //
      // Walking edges are exempt. A bridge-walk is the designed escape when an
      // edge is too stressful to ride, and charging it the same crossing wait
      // removes the escape instead of shaping the route — the 2026-04-29 first
      // cut did exactly that and deepened the regression it was meant to
      // avoid.
      const arms = majorLinksByNode(graph).get(nodeId)
      if (arms) {
        const bearings: number[] = []
        for (const arm of arms) {
          const b = armBearing(graph, nodeId, arm)
          if (b != null) bearings.push(b)
        }
        const axis = majorAxisDeg(bearings)
        if (axis != null) {
          // Sides of where the rider came FROM and where they go TO, as seen
          // from this node. bIn points prev → node, so reverse it.
          const sidePrev = sideOfAxis((bIn + 180) % 360, axis)
          const sideNext = sideOfAxis(bOut, axis)
          if (sidePrev !== 0 && sideNext !== 0 && sidePrev !== sideNext) {
            cost += rule.unsignalizedMajorCrossingSec
            dur += rule.unsignalizedMajorCrossingSec
          }
        }
      }
    }

    // Turn costs. A bend is an *instruction* ("turn onto X") when the way
    // changes or the node is a junction — a degree-2 corner between two ways
    // still requires a real turn even though there's no alternative. A bend
    // WITHIN one way at a degree-2 vertex is just the path curving: free.
    // Maneuver time (real) applies to instructions; the path-shaping penalty
    // applies only at junctions, where an alternative actually exists for
    // A* to prefer. Walking transitions skip both (turning a walked bike is
    // trivial) but still paid the control waits above.
    const isJunction = (junctions.get(nodeId) ?? 0) >= 3
    const wayChanged = l1.data.wayId !== l2.data.wayId
    if ((isJunction || wayChanged) && abs >= 30) {
      const walking = l1.data.isWalking || l2.data.isWalking
      if (abs >= 60) isTurn = true
      if (!walking && rule.turnTimeSec) {
        const t = abs < 60 ? rule.turnTimeSec.slight : abs <= 120 ? rule.turnTimeSec.turn : rule.turnTimeSec.sharp
        cost += t
        dur += t
      }
      if (!walking && isJunction && abs >= 60 && rule.turnPenaltySec) {
        cost += rule.turnPenaltySec // path-shaping only — NOT added to dur
      }
    }

    return { cost, dur, isTurn }
  }

  const labels = new Map<Link<EdgeData>, Label>()
  const heap = new MinHeap()

  const startLinks = graph.getLinks(startId)
  if (!startLinks) return null
  for (const link of startLinks) {
    if (link.fromId !== startId) continue
    const label: Label = {
      link,
      g: link.data.cost,
      dur: link.data.durationSec,
      turns: 0,
      parent: null,
      f: link.data.cost + h(link.toId),
      closed: false,
    }
    labels.set(link, label)
    heap.push(label)
  }

  while (heap.size > 0) {
    const cur = heap.pop()!
    if (cur.closed) continue
    cur.closed = true

    if (cur.link.toId === endId) {
      // Reconstruct start → end.
      const links: Array<Link<EdgeData>> = []
      let walk: Label | null = cur
      while (walk) { links.push(walk.link); walk = walk.parent }
      links.reverse()
      return { links, durationSec: cur.dur, turnCount: cur.turns }
    }

    const outLinks = graph.getLinks(cur.link.toId)
    if (!outLinks) continue
    for (const next of outLinks) {
      if (next.fromId !== cur.link.toId) continue
      const t = transition(cur.link, next)
      const g2 = cur.g + t.cost + next.data.cost
      const existing = labels.get(next)
      if (existing && existing.g <= g2) continue
      const label: Label = {
        link: next,
        g: g2,
        dur: cur.dur + t.dur + next.data.durationSec,
        turns: cur.turns + (t.isTurn ? 1 : 0),
        parent: cur,
        f: g2 + h(next.toId),
        closed: false,
      }
      labels.set(next, label)
      heap.push(label)
    }
  }

  return null
}
