import { describe, it, expect } from 'bun:test'
import { buildRoutingGraph, routeOnGraph } from '../src/services/clientRouter'
import { turnDelta } from '../src/services/edgeAStar'
import { getDefaultPreferredItems } from '../src/utils/classify'
import type { OsmWay } from '../src/utils/types'

const MODE = 'kid-confident'
const pref = getDefaultPreferredItems(MODE)

let nextId = 1
function way(coords: Array<[number, number]>, tags: Record<string, string> = { highway: 'cycleway' }): OsmWay {
  return { itemName: null, coordinates: coords, osmId: nextId++, tags }
}
function signalAt(lat: number, lng: number): OsmWay {
  return { itemName: null, coordinates: [[lat, lng]], osmId: nextId++, tags: { highway: 'traffic_signals' } }
}

function route(ways: OsmWay[], from: [number, number], to: [number, number]) {
  const graph = buildRoutingGraph(ways, MODE, pref, undefined, null, null, null, undefined, null)
  return routeOnGraph(graph, from[0], from[1], to[0], to[1], MODE, pref)
}

describe('turnDelta', () => {
  it('normalises and signs turns (negative = left)', () => {
    expect(turnDelta(90, 0)).toBe(-90)   // heading E, turn N = left
    expect(turnDelta(90, 180)).toBe(90)  // heading E, turn S = right
    expect(turnDelta(350, 10)).toBe(20)  // wraps across north
    expect(turnDelta(0, 180)).toBe(180)  // U-turn maps to +180, not -180
  })
})

describe('edge A* turn shaping', () => {
  // 3×3 cycleway grid, 0.001° spacing. Every Manhattan path SW→NE has equal
  // length; 1-turn paths (EENN / NNEE) and the 3-turn staircase differ only
  // in turn costs. All interior corners are real junctions (degree ≥3).
  const STEP = 0.001
  const grid: OsmWay[] = []
  for (let r = 0; r <= 2; r++) {
    grid.push(way([[r * STEP, 0], [r * STEP, STEP], [r * STEP, 2 * STEP]]))
  }
  for (let c = 0; c <= 2; c++) {
    grid.push(way([[0, c * STEP], [STEP, c * STEP], [2 * STEP, c * STEP]]))
  }

  it('prefers the fewest-turn path on an otherwise-equal grid', () => {
    const r = route(grid, [0, 0], [2 * STEP, 2 * STEP])
    expect(r).not.toBeNull()
    expect(r!.turnCount).toBe(1)
  })

  it('a 90° bend inside a single way (degree-2 vertex) costs nothing', () => {
    const bent = [way([[0, 0], [0, STEP], [STEP, STEP]])]
    const r = route(bent, [0, 0], [STEP, STEP])
    expect(r).not.toBeNull()
    expect(r!.turnCount).toBe(0)
    // Duration is pure riding time: ~222 m at 10 km/h ≈ 80 s, no turn adders.
    expect(r!.durationS).toBeGreaterThan(70)
    expect(r!.durationS).toBeLessThan(90)
  })
})

describe('edge A* signal waits', () => {
  const STEP = 0.001
  // Straight line A—B—C with B mid-way (degree 2).
  const line = () => [way([[0, 0], [0, STEP], [0, 2 * STEP]])]

  it('adds the through-wait to the ETA when passing a signal', () => {
    const base = route(line(), [0, 0], [0, 2 * STEP])!
    const withSignal = route([...line(), signalAt(0, STEP)], [0, 0], [0, 2 * STEP])!
    // kid-confident signalWaitSec.through = 15
    expect(withSignal.durationS - base.durationS).toBeCloseTo(15, 0)
    expect(withSignal.turnCount).toBe(0)
  })

  it('charges the two-stage left wait at a signalised T-junction', () => {
    // West arm A—X, continuing east X—E (same way), north arm X—N.
    const tee = () => [
      way([[0, 0], [0, STEP], [0, 2 * STEP]]),  // A—X—E (west→east)
      way([[0, STEP], [STEP, STEP]]),            // X—N (north)
    ]
    const straightBase = route(tee(), [0, 0], [0, 2 * STEP])!
    const leftBase = route(tee(), [0, 0], [STEP, STEP])!
    const straightSig = route([...tee(), signalAt(0, STEP)], [0, 0], [0, 2 * STEP])!
    const leftSig = route([...tee(), signalAt(0, STEP)], [0, 0], [STEP, STEP])!

    // kid-confident: through 15 s; left 45 s (two-stage crossing).
    expect(straightSig.durationS - straightBase.durationS).toBeCloseTo(15, 0)
    expect(leftSig.durationS - leftBase.durationS).toBeCloseTo(45, 0)
    // The left is a junction turn; the straight is not a turn.
    expect(leftSig.turnCount).toBe(1)
    expect(straightSig.turnCount).toBe(0)
  })
})

describe('edge A* unsignalized major-road crossings (Joanna #4)', () => {
  const STEP = 0.001

  function routeAs(mode: string, ways: OsmWay[], from: [number, number], to: [number, number]) {
    const p = getDefaultPreferredItems(mode)
    const graph = buildRoutingGraph(ways, mode, p, undefined, null, null, null, undefined, null)
    return routeOnGraph(graph, from[0], from[1], to[0], to[1], mode, p)
  }

  /** A cycleway running N–S across one E–W road. */
  function crossing(crossTags: Record<string, string>): OsmWay[] {
    return [
      way([[-STEP, 0], [0, 0], [STEP, 0]]),
      way([[0, -STEP], [0, 0], [0, STEP]], crossTags),
    ]
  }
  const A: [number, number] = [-STEP, 0]
  const B: [number, number] = [STEP, 0]

  it('charges the crossing wait at an unsignalized primary', () => {
    const quiet = routeAs(MODE, crossing({ highway: 'residential', maxspeed: '30' }), A, B)!
    const major = routeAs(MODE, crossing({ highway: 'primary', maxspeed: '50' }), A, B)!
    // kid-confident unsignalizedMajorCrossingSec = 50
    expect(major.durationS - quiet.durationS).toBeCloseTo(50, 0)
  })

  it('charges the signal wait instead when a signal is mapped there', () => {
    const ways = [...crossing({ highway: 'primary', maxspeed: '50' }), signalAt(0, 0)]
    const quiet = routeAs(MODE, crossing({ highway: 'residential', maxspeed: '30' }), A, B)!
    const signalled = routeAs(MODE, ways, A, B)!
    // Signal through-wait is 15 for kid-confident, not the 50 s gap wait —
    // a mapped control means the rider is not waiting for a gap.
    expect(signalled.durationS - quiet.durationS).toBeCloseTo(15, 0)
  })

  it('does not charge for crossing a secondary', () => {
    // Berlin's ordinary Hauptstrasse. Charging every unsignalised one would
    // penalise the whole grid rather than the hostile crossings.
    const quiet = routeAs(MODE, crossing({ highway: 'residential', maxspeed: '30' }), A, B)!
    const secondary = routeAs(MODE, crossing({ highway: 'secondary', maxspeed: '50' }), A, B)!
    expect(secondary.durationS).toBeCloseTo(quiet.durationS, 0)
  })

  it('does not charge for crossing a calmed primary', () => {
    const quiet = routeAs(MODE, crossing({ highway: 'residential', maxspeed: '30' }), A, B)!
    const slow = routeAs(MODE, crossing({ highway: 'primary', maxspeed: '30' }), A, B)!
    expect(slow.durationS).toBeCloseTo(quiet.durationS, 0)
  })

  it('does not charge a rider travelling ALONG the major road', () => {
    // A primary with a separated track is 2a after the arterial demote, so
    // carrying-kid rides it. Passing its own junction nodes must not cost
    // 50 s a block — that is riding the arterial, not crossing it.
    const arterial = { highway: 'primary', maxspeed: '50', 'cycleway:right': 'track' }
    const along: OsmWay[] = [
      way([[0, 0], [0, STEP], [0, 2 * STEP]], arterial),
      // A side street meeting it mid-way, making the middle node a junction.
      way([[0, STEP], [STEP, STEP]], { highway: 'residential', maxspeed: '30' }),
    ]
    const bare: OsmWay[] = [
      way([[0, 0], [0, STEP], [0, 2 * STEP]], arterial),
    ]
    const withJunction = routeAs('carrying-kid', along, [0, 0], [0, 2 * STEP])!
    const withoutJunction = routeAs('carrying-kid', bare, [0, 0], [0, 2 * STEP])!
    expect(withJunction.durationS).toBeCloseTo(withoutJunction.durationS, 0)
  })

  it('exempts walking edges, so the bridge-walk escape survives', () => {
    // kid-starting-out rejects the cycleway's crossing of a primary only via
    // bridge-walk; charging the gap wait on a walked edge would remove the
    // escape rather than shape the route.
    // The N–S way is a secondary, which kid-starting-out rejects, so both
    // legs are bridge-walked. The only difference between the two routes is
    // the class of the road being crossed.
    const walkedWay = () => way([[-STEP, 0], [0, 0], [STEP, 0]], { highway: 'secondary', maxspeed: '50' })
    const acrossMajor = [walkedWay(), way([[0, -STEP], [0, 0], [0, STEP]], { highway: 'primary', maxspeed: '50' })]
    const acrossQuiet = [walkedWay(), way([[0, -STEP], [0, 0], [0, STEP]], { highway: 'residential', maxspeed: '30' })]
    const major = routeAs('kid-starting-out', acrossMajor, A, B)!
    const quiet = routeAs('kid-starting-out', acrossQuiet, A, B)!
    expect(major.durationS).toBeCloseTo(quiet.durationS, 0)
  })
})
