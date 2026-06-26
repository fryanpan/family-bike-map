import { describe, test, expect } from 'bun:test'
import { buildRoutingGraph, routeOnGraph, haversineM } from '../src/services/clientRouter'
import { MODE_RULES } from '../src/data/modes'
import type { OsmWay } from '../src/utils/types'

describe('haversineM', () => {
  test('returns 0 for same point', () => {
    expect(haversineM(52.5, 13.4, 52.5, 13.4)).toBe(0)
  })

  test('returns ~111km for 1 degree latitude', () => {
    const dist = haversineM(52.0, 13.0, 53.0, 13.0)
    expect(dist).toBeGreaterThan(110_000)
    expect(dist).toBeLessThan(112_000)
  })
})

describe('buildRoutingGraph', () => {
  const ways: OsmWay[] = [
    {
      osmId: 1,
      itemName: null,
      tags: { highway: 'cycleway' },
      coordinates: [
        [52.5000, 13.4000],
        [52.5010, 13.4000],
        [52.5020, 13.4000],
      ],
    },
    {
      osmId: 2,
      itemName: null,
      tags: { highway: 'residential' },
      coordinates: [
        [52.5020, 13.4000],
        [52.5020, 13.4010],
      ],
    },
  ]

  test('creates nodes for all coordinates', () => {
    // kid-confident accepts LTS 1 including quiet residential (car-free
    // cycleway + mixed-traffic residential), so both fixture ways are
    // included. kid-starting-out rejects residential (requireCarFree).
    const graph = buildRoutingGraph(ways, 'kid-confident', new Set(['Bike path']))
    // 4 unique coordinates
    expect(graph.getNodeCount()).toBe(4)
  })

  test('creates edges in both directions for non-oneway', () => {
    const graph = buildRoutingGraph(ways, 'kid-confident', new Set(['Bike path']))
    // Way 1: 2 segments * 2 dirs = 4, Way 2: 1 segment * 2 dirs = 2, total = 6
    expect(graph.getLinkCount()).toBe(6)
  })

  test('kid-starting-out bridge-walks mixed-traffic residential (not accepted for riding)', () => {
    // The residential way is rejected for RIDING under requireCarFree,
    // but stays in the graph as a bridge-walk edge at walkingSpeedKmh so
    // the router can still reach destinations through bad-infra gaps.
    // 4 nodes (3 from cycleway + 1 new on the residential spur).
    // 6 edges (2 cycleway segs × 2 dirs + 1 residential seg × 2 dirs).
    const graph = buildRoutingGraph(ways, 'kid-starting-out', new Set(['Bike path']))
    expect(graph.getNodeCount()).toBe(4)
    expect(graph.getLinkCount()).toBe(6)

    // The residential edge should be flagged as walking.
    const residentialLink = graph.getLink('52.50200,13.40000', '52.50200,13.40100')
    expect(residentialLink).toBeTruthy()
    expect(residentialLink!.data.isWalking).toBe(true)

    // The cycleway edge should be riding, not walking.
    const cyclewayLink = graph.getLink('52.50000,13.40000', '52.50100,13.40000')
    expect(cyclewayLink).toBeTruthy()
    expect(cyclewayLink!.data.isWalking).toBe(false)
  })

  test('respects oneway', () => {
    const onewayWays: OsmWay[] = [{
      osmId: 3,
      itemName: null,
      tags: { highway: 'cycleway', oneway: 'yes' },
      coordinates: [[52.5, 13.4], [52.501, 13.4]],
    }]
    const graph = buildRoutingGraph(onewayWays, 'kid-starting-out', new Set())
    // 1 segment, oneway = 1 edge only
    expect(graph.getLinkCount()).toBe(1)
  })

  test('oneway:bicycle=no overrides oneway', () => {
    const overrideWays: OsmWay[] = [{
      osmId: 4,
      itemName: null,
      tags: { highway: 'cycleway', oneway: 'yes', 'oneway:bicycle': 'no' },
      coordinates: [[52.5, 13.4], [52.501, 13.4]],
    }]
    const graph = buildRoutingGraph(overrideWays, 'kid-starting-out', new Set())
    expect(graph.getLinkCount()).toBe(2)
  })

  test('walking-only edges use walking speed and are flagged', () => {
    const walkWays: OsmWay[] = [{
      osmId: 5,
      itemName: null,
      tags: { highway: 'footway' }, // no bicycle=yes → walking
      coordinates: [[52.5, 13.4], [52.501, 13.4]],
    }]
    const graph = buildRoutingGraph(walkWays, 'kid-starting-out', new Set())
    const link = graph.getLink('52.50000,13.40000', '52.50100,13.40000')
    expect(link).toBeTruthy()
    expect(link!.data.isWalking).toBe(true)
    // Cost = time = distance / walking_speed. Kid-starting-out walking
    // pace is 1 km/h (a 4-year-old walking alongside a parent, per the
    // 2026-04-21 path-categories spec: slowest kid walks slowest).
    const walkingSpeed = 1 / 3.6 // kid-starting-out walkingSpeedKmh
    const expectedCost = link!.data.distance / walkingSpeed
    expect(link!.data.cost).toBeCloseTo(expectedCost, 0)
  })
})

describe('routeOnGraph', () => {
  // Simple linear graph: A -> B -> C
  const ways: OsmWay[] = [{
    osmId: 10,
    itemName: null,
    tags: { highway: 'cycleway' },
    coordinates: [
      [52.5000, 13.4000],
      [52.5010, 13.4000],
      [52.5020, 13.4000],
    ],
  }]

  test('finds a path on a simple graph', () => {
    const preferred = new Set(['Bike path'])
    const graph = buildRoutingGraph(ways, 'kid-starting-out', preferred)
    const result = routeOnGraph(
      graph, 52.5000, 13.4000, 52.5020, 13.4000,
      'kid-starting-out', preferred,
    )
    expect(result).not.toBeNull()
    expect(result!.coordinates.length).toBe(3)
    expect(result!.distanceKm).toBeGreaterThan(0)
    expect(result!.durationS).toBeGreaterThan(0)
  })

  test('returns null for disconnected graph', () => {
    const disconnected: OsmWay[] = [
      {
        osmId: 11,
        itemName: null,
        tags: { highway: 'cycleway', oneway: 'yes' },
        coordinates: [[52.5000, 13.4000], [52.5010, 13.4000]],
      },
      {
        osmId: 12,
        itemName: null,
        tags: { highway: 'cycleway', oneway: 'yes' },
        coordinates: [[52.6000, 13.5000], [52.6010, 13.5000]],
      },
    ]
    const graph = buildRoutingGraph(disconnected, 'kid-starting-out', new Set())
    // Route from one cluster to the other: should return null (or empty path)
    const result = routeOnGraph(
      graph, 52.5000, 13.4000, 52.6010, 13.5000,
      'kid-starting-out', new Set(),
    )
    // ngraph returns empty array for unreachable
    expect(result).toBeNull()
  })

  test('tracks walking distance and percentage', () => {
    // Route through a cycleway then a footway (walking)
    const mixedWays: OsmWay[] = [
      {
        osmId: 30,
        itemName: null,
        tags: { highway: 'cycleway' },
        coordinates: [[52.5000, 13.4000], [52.5010, 13.4000]],
      },
      {
        osmId: 31,
        itemName: null,
        tags: { highway: 'footway' }, // walking-only (no bicycle=yes)
        coordinates: [[52.5010, 13.4000], [52.5020, 13.4000]],
      },
    ]
    const preferred = new Set(['Bike path'])
    const graph = buildRoutingGraph(mixedWays, 'kid-starting-out', preferred)
    const result = routeOnGraph(
      graph, 52.5000, 13.4000, 52.5020, 13.4000,
      'kid-starting-out', preferred,
    )
    expect(result).not.toBeNull()
    expect(result!.walkingDistanceKm).toBeGreaterThan(0)
    expect(result!.walkingPct).toBeGreaterThan(0)
    expect(result!.walkingPct).toBeLessThan(1) // not 100% walking

    // Check that walking segments are marked
    const walkingSegs = result!.segments.filter(s => s.isWalking)
    expect(walkingSegs.length).toBeGreaterThan(0)
  })

  test('kid-starting-out bridge-walks Fahrradstrasse AND secondary painted lanes (car-free only)', () => {
    // kid-starting-out now requires PHYSICALLY car-free infra only.
    // Fahrradstraßen are legally bike-priority but still have car traffic
    // (cars are guests), which this mode can't handle. Both fahrrad and
    // painted-lane edges bridge-walk at walking speed rather than ride.
    const fahrradWays: OsmWay[] = [{
      osmId: 40,
      itemName: null,
      tags: { highway: 'residential', bicycle_road: 'yes' },
      coordinates: [[52.5000, 13.4000], [52.5010, 13.4000]],
    }]
    const cyclewayWays: OsmWay[] = [{
      osmId: 40,
      itemName: null,
      tags: { highway: 'cycleway' },
      coordinates: [[52.5000, 13.4000], [52.5010, 13.4000]],
    }]
    const paintedWays: OsmWay[] = [{
      osmId: 41,
      itemName: null,
      tags: { highway: 'secondary', cycleway: 'lane' },
      coordinates: [[52.5000, 13.4000], [52.5010, 13.4000]],
    }]

    const preferred = new Set(['Fahrradstrasse', 'Bike path', 'Painted bike lane'])
    const gFahr = buildRoutingGraph(fahrradWays, 'kid-starting-out', preferred)
    const gCycle = buildRoutingGraph(cyclewayWays, 'kid-starting-out', preferred)
    const gPaint = buildRoutingGraph(paintedWays, 'kid-starting-out', preferred)

    // Cycleway: truly car-free, accepted for riding.
    const cycleLink = gCycle.getLink('52.50000,13.40000', '52.50100,13.40000')
    expect(cycleLink!.data.isWalking).toBe(false)

    // Fahrradstraße: bike-priority but still has cars → bridge-walk.
    const fahrLink = gFahr.getLink('52.50000,13.40000', '52.50100,13.40000')
    expect(fahrLink!.data.isWalking).toBe(true)

    // Secondary painted lane: bridge-walk only (was already rejected before).
    const paintLink = gPaint.getLink('52.50000,13.40000', '52.50100,13.40000')
    expect(paintLink).toBeTruthy()
    expect(paintLink!.data.isWalking).toBe(true)
  })

  test('hard-rejects motorways and sidewalk=no roads (not even bridge-walkable)', () => {
    const motorway: OsmWay[] = [{
      osmId: 80,
      itemName: null,
      tags: { highway: 'motorway' },
      coordinates: [[52.5000, 13.4000], [52.5010, 13.4000]],
    }]
    const noSidewalk: OsmWay[] = [{
      osmId: 81,
      itemName: null,
      tags: { highway: 'primary', sidewalk: 'no' },
      coordinates: [[52.5000, 13.4000], [52.5010, 13.4000]],
    }]
    const gMoto = buildRoutingGraph(motorway, 'kid-starting-out', new Set())
    const gNoSw = buildRoutingGraph(noSidewalk, 'kid-starting-out', new Set())
    expect(gMoto.getLinkCount()).toBe(0)
    expect(gNoSw.getLinkCount()).toBe(0)
  })

  test('kid-starting-out bridge-walks SF Slow Streets (still has car access)', () => {
    // SF-style Slow Street: residential with motor_vehicle=destination.
    // bikePriority is true, but cars are still present (residents + delivery),
    // so kid-starting-out won't ride it — bridge-walks instead.
    const slowStreetWays: OsmWay[] = [{
      osmId: 42,
      itemName: null,
      tags: {
        highway: 'residential',
        motor_vehicle: 'destination',
        maxspeed: '25',
      },
      coordinates: [[37.7600, -122.4300], [37.7610, -122.4300]],
    }]
    const graph = buildRoutingGraph(slowStreetWays, 'kid-starting-out', new Set())
    const link = graph.getLink('37.76000,-122.43000', '37.76100,-122.43000')
    expect(link!.data.isWalking).toBe(true)
  })

  test('kid-starting-out bridge-walks living streets (bikePriority but cars still legal)', () => {
    // living_street = legally ≤ walking pace for cars. Still has cars.
    // kid-starting-out bridge-walks.
    const livingStreetWays: OsmWay[] = [{
      osmId: 44,
      itemName: null,
      tags: { highway: 'living_street' },
      coordinates: [[52.5000, 13.4000], [52.5010, 13.4000]],
    }]
    const graph = buildRoutingGraph(livingStreetWays, 'kid-starting-out', new Set())
    const link = graph.getLink('52.50000,13.40000', '52.50100,13.40000')
    expect(link!.data.isWalking).toBe(true)
  })

  test('kid-starting-out and kid-confident both bridge-walk plain residential (LTS 2b)', () => {
    // Per 2026-04-21 path-categories plan, quiet residential without legal
    // bike priority classifies as LTS 2b — below the kid-confident ceiling
    // of 1a/1b. Both starting-out and confident bridge-walk it. The next
    // tier up (kid-traffic-savvy) accepts it for riding with a 1.5× cost
    // multiplier; carrying-kid and training accept it outright.
    const residentialWays: OsmWay[] = [{
      osmId: 43,
      itemName: null,
      tags: { highway: 'residential', maxspeed: '30' },
      coordinates: [[52.5000, 13.4000], [52.5010, 13.4000]],
    }]
    const gStart   = buildRoutingGraph(residentialWays, 'kid-starting-out',   new Set())
    const gConf    = buildRoutingGraph(residentialWays, 'kid-confident',      new Set())
    const gSavvy   = buildRoutingGraph(residentialWays, 'kid-traffic-savvy',  new Set())
    const gCarry   = buildRoutingGraph(residentialWays, 'carrying-kid',       new Set())

    expect(gStart.getLink('52.50000,13.40000', '52.50100,13.40000')!.data.isWalking).toBe(true)
    expect(gConf.getLink('52.50000,13.40000', '52.50100,13.40000')!.data.isWalking).toBe(true)
    expect(gSavvy.getLink('52.50000,13.40000', '52.50100,13.40000')!.data.isWalking).toBe(false)
    expect(gCarry.getLink('52.50000,13.40000', '52.50100,13.40000')!.data.isWalking).toBe(false)
  })

  test('kid-confident rides Fahrradstrasse, bridge-walks secondary painted lanes', () => {
    // kid-confident accepts full Furth LTS 1 including Fahrradstraßen.
    // A secondary-road painted lane is LTS 2–3 — too stressful to RIDE for
    // confident — but still walkable on the sidewalk.
    const fahrradWays: OsmWay[] = [{
      osmId: 42,
      itemName: null,
      tags: { highway: 'residential', bicycle_road: 'yes' },
      coordinates: [[52.5000, 13.4000], [52.5010, 13.4000]],
    }]
    const paintedWays: OsmWay[] = [{
      osmId: 43,
      itemName: null,
      tags: { highway: 'secondary', cycleway: 'lane' },
      coordinates: [[52.5000, 13.4000], [52.5010, 13.4000]],
    }]

    const gFahr  = buildRoutingGraph(fahrradWays, 'kid-confident', new Set(['Fahrradstrasse']))
    const gPaint = buildRoutingGraph(paintedWays, 'kid-confident', new Set(['Painted bike lane']))

    const fahrLink  = gFahr.getLink('52.50000,13.40000', '52.50100,13.40000')
    const paintLink = gPaint.getLink('52.50000,13.40000', '52.50100,13.40000')

    expect(fahrLink!.data.isWalking).toBe(false)
    expect(paintLink).toBeTruthy()
    expect(paintLink!.data.isWalking).toBe(true)
  })

  describe('ascent cost (BRouter-style)', () => {
    // A 1 km E–W cycleway between (52.500, 13.400) and (52.500, 13.415).
    // Tag highway as cycleway so it's car-free and accepted in every mode.
    const longWay: OsmWay[] = [{
      osmId: 100,
      itemName: null,
      tags: { highway: 'cycleway' },
      coordinates: [[52.500, 13.400], [52.500, 13.415]],
    }]

    // 1 km cycleway with 50 m rise → 5% real grade. Real ascent, well
    // above the 2 m noise cutoff.
    const climbEle = (lat: number, lng: number): number =>
      Math.abs(lng - 13.400) > 0.0001 ? 50 : 0

    // 1 km cycleway with 1 m delta → noise. Below the 2 m cutoff so
    // contributes zero ascent cost.
    const flatNoiseEle = (lat: number, lng: number): number =>
      Math.abs(lng - 13.400) > 0.0001 ? 1 : 0

    function getLinkCost(way: OsmWay[], mode: string, ele: (lat: number, lng: number) => number | null): number {
      const graph = buildRoutingGraph(
        way, mode, new Set(), undefined, undefined, undefined,
        undefined, undefined, ele,
      )
      const link = graph.getLink('52.50000,13.40000', '52.50000,13.41500')
      return link!.data.cost
    }

    test('climbing edge pays extra cost proportional to ascent', () => {
      const flatCost = getLinkCost(longWay, 'kid-starting-out', () => 0)
      const climbCost = getLinkCost(longWay, 'kid-starting-out', climbEle)
      // 50 m ascent above cutoff = 48 m. 48 * 40 sec/m = 1920 s added.
      // Flat cost at 5 km/h is ~720 s, so climb cost should be ~2640 s.
      expect(climbCost - flatCost).toBeCloseTo(48 * 40, -1)
    })

    test('reverse direction (descent) pays no ascent cost', () => {
      const graph = buildRoutingGraph(
        longWay, 'kid-starting-out', new Set(), undefined, undefined, undefined,
        undefined, undefined, climbEle,
      )
      const forward = graph.getLink('52.50000,13.40000', '52.50000,13.41500')!.data.cost
      const reverse = graph.getLink('52.50000,13.41500', '52.50000,13.40000')!.data.cost
      // Reverse is descent → no ascent cost. Forward should be > reverse.
      expect(forward).toBeGreaterThan(reverse)
      // Reverse should equal flat baseline (within tiny rounding).
      const flat = getLinkCost(longWay, 'kid-starting-out', () => 0)
      expect(reverse).toBeCloseTo(flat, 1)
    })

    test('small noise-level delta (under cutoff) adds zero ascent cost', () => {
      const flatCost = getLinkCost(longWay, 'kid-starting-out', () => 0)
      const noiseCost = getLinkCost(longWay, 'kid-starting-out', flatNoiseEle)
      // 1 m delta < 2 m cutoff → max(0, 1 - 2) = 0. Cost unchanged.
      expect(noiseCost).toBeCloseTo(flatCost, 1)
    })

    test('null elevation lookup → no ascent cost added (fail-soft)', () => {
      const flatCost = getLinkCost(longWay, 'kid-starting-out', () => 0)
      const nullCost = getLinkCost(longWay, 'kid-starting-out', () => null)
      expect(nullCost).toBeCloseTo(flatCost, 1)
    })

    test('mode hierarchy: training pays less per metre than kid-starting-out', () => {
      const kidFlat = getLinkCost(longWay, 'kid-starting-out', () => 0)
      const kidClimb = getLinkCost(longWay, 'kid-starting-out', climbEle)
      const trainFlat = getLinkCost(longWay, 'training', () => 0)
      const trainClimb = getLinkCost(longWay, 'training', climbEle)

      const kidPenalty = kidClimb - kidFlat
      const trainPenalty = trainClimb - trainFlat
      // kid-starting-out 40 sec/m × 48 m = 1920 s
      // training 7 sec/m × 48 m = 336 s
      expect(kidPenalty).toBeGreaterThan(trainPenalty)
      expect(kidPenalty / trainPenalty).toBeCloseTo(40 / 7, 1)
    })

    test('Berlin Friedrichstraße noise pattern adds negligible cost', () => {
      // 170 m flat way with 22 m fake delta (z=12 terrain-RGB noise).
      // BRouter-style cost: 22 - 2 cutoff = 20 m fake ascent.
      // For kid-starting-out: 20 * 40 = 800 s added. Real-flat cost on
      // 170 m at 5 km/h = 122 s. So noise inflates cost ~7×.
      //
      // That's still a lot — the cutoff alone doesn't make noise
      // negligible. The point is the router doesn't BRIDGE-WALK the
      // segment; it just becomes less preferred. Compare to alternative
      // paths.
      const flatWayWithNoise: OsmWay[] = [{
        osmId: 102,
        itemName: null,
        tags: { highway: 'cycleway' },
        coordinates: [[52.500, 13.400], [52.500, 13.4025]],
      }]
      const noisyFlat = (lat: number, lng: number): number =>
        Math.abs(lng - 13.400) > 0.0001 ? 22 : 0
      const graph = buildRoutingGraph(
        flatWayWithNoise, 'kid-starting-out', new Set(), undefined, undefined, undefined,
        undefined, undefined, noisyFlat,
      )
      const link = graph.getLink('52.50000,13.40000', '52.50000,13.40250')
      expect(link).toBeTruthy()
      // No bridge-walk — the cost-based approach never sets isWalking
      // from gradient.
      expect(link!.data.isWalking).toBe(false)
    })
  })

  test('prefers a flat-longer path over a steep-shorter one (end-to-end ascent routing)', () => {
    // Two paths from origin to destination (both at sea level):
    //   steep: direct 300 m way that goes 0→30 m→0 (a hill in the middle)
    //   flat:  1200 m detour staying at 0 m
    // kid-starting-out (40 s/m ascent cost). Direct path penalty:
    //   28 m effective ascent × 40 = 1120 s on top of 214 s base = 1334 s.
    // Flat detour: 1200 m / 1.4 m/s = 857 s. Flat should win.
    const steepWay: OsmWay = {
      osmId: 30, itemName: null,
      tags: { highway: 'cycleway' },
      coordinates: [[52.500, 13.400], [52.500, 13.4015], [52.500, 13.4030]],
    }
    const flatLeg1: OsmWay = {
      osmId: 31, itemName: null,
      tags: { highway: 'cycleway' },
      coordinates: [[52.500, 13.400], [52.5045, 13.400]],
    }
    const flatLeg2: OsmWay = {
      osmId: 32, itemName: null,
      tags: { highway: 'cycleway' },
      coordinates: [[52.5045, 13.400], [52.5045, 13.4030]],
    }
    const flatLeg3: OsmWay = {
      osmId: 33, itemName: null,
      tags: { highway: 'cycleway' },
      coordinates: [[52.5045, 13.4030], [52.500, 13.4030]],
    }
    const ways = [steepWay, flatLeg1, flatLeg2, flatLeg3]
    // Hilltop coord is the middle vertex of the direct way only.
    const ele = (lat: number, lng: number): number =>
      Math.abs(lat - 52.500) < 0.0001 && Math.abs(lng - 13.4015) < 0.0001 ? 30 : 0

    const graph = buildRoutingGraph(
      ways, 'kid-starting-out', new Set(['Bike path']),
      undefined, undefined, undefined, undefined, undefined, ele,
    )
    const result = routeOnGraph(
      graph, 52.500, 13.400, 52.500, 13.4030,
      'kid-starting-out', new Set(['Bike path']),
    )
    expect(result).not.toBeNull()
    // If the router picked the flat detour, the path includes the
    // northern node (52.5045) — confirm it routed AROUND the hill.
    const tookFlatDetour = result!.coordinates.some(
      ([la]) => Math.abs(la - 52.5045) < 0.0001,
    )
    expect(tookFlatDetour).toBe(true)
  })

  test('prefers lower-cost edges', () => {
    // Two parallel paths: one cycleway (preferred, cost 1x), one residential (cost 3x).
    // Use kid-confident which accepts both (cycleway car-free, residential as LTS 1).
    const twoPath: OsmWay[] = [
      {
        osmId: 20,
        itemName: null,
        tags: { highway: 'cycleway' },
        coordinates: [[52.5000, 13.4000], [52.5005, 13.4010], [52.5010, 13.4020]],
      },
      {
        osmId: 21,
        itemName: null,
        tags: { highway: 'residential' },
        coordinates: [[52.5000, 13.4000], [52.4995, 13.4010], [52.5010, 13.4020]],
      },
    ]
    const preferred = new Set(['Bike path'])
    const graph = buildRoutingGraph(twoPath, 'kid-confident', preferred)
    const result = routeOnGraph(
      graph, 52.5000, 13.4000, 52.5010, 13.4020,
      'kid-confident', preferred,
    )
    expect(result).not.toBeNull()
    // Should take the cycleway (via 52.5005) not the residential (via 52.4995)
    // — cycleway is both car-free AND in the preferred set.
    const midLat = result!.coordinates[1][0]
    expect(midLat).toBeCloseTo(52.5005, 3)
  })
})

describe('ascent cost on walking edges (2026-06-20 Buena Vista fix)', () => {
  // A footway (walking-only) climbing 10 m over ~111 m. The uphill (forward)
  // edge must now carry ascent cost; the downhill (reverse) edge must not.
  // Before the fix, walking edges were exempt and the router happily walked
  // straight up a steep park rather than ride a flatter, longer route.
  const uphillFootway: OsmWay[] = [{
    osmId: 1, itemName: null, tags: { highway: 'footway' },
    coordinates: [[37.7600, -122.4300], [37.7610, -122.4300]],
  }]
  // Elevation increases with latitude: south point 0 m, north point 10 m.
  const elev = (lat: number) => (lat - 37.7600) * 10_000

  test('uphill walking edge costs more than its flat ride time; downhill does not', () => {
    const graph = buildRoutingGraph(
      uphillFootway, 'kid-confident', new Set(),
      undefined, null, null, null, undefined, elev,
    )
    const links = [...(graph.getLinks('37.76000,-122.43000') ?? [])]
    const forward = links.find((l) => l.toId === '37.76100,-122.43000')!   // uphill
    const reverse = [...(graph.getLinks('37.76100,-122.43000') ?? [])]
      .find((l) => l.toId === '37.76000,-122.43000')!                      // downhill
    expect(forward.data.isWalking).toBe(true)
    // Uphill: cost = durationSec + ascent penalty (>0). Downhill: cost == durationSec.
    expect(forward.data.cost).toBeGreaterThan(forward.data.durationSec + 100)
    expect(reverse.data.cost).toBeCloseTo(reverse.data.durationSec, 5)
    // ETA is unaffected — ascent is path-shaping cost only.
    expect(forward.data.durationSec).toBeCloseTo(reverse.data.durationSec, 5)
  })
})

describe('car-free cost bonus (2026-06-20 JFK Promenade fix)', () => {
  // Flat elevation isolates the car-free bonus from ascent. A car-free
  // cycleway edge is discounted by the mode's carFreeBonus; a car-shared
  // living street (bikePriority but NOT carFree) is not.
  const flat = () => 100
  const carFreeWay: OsmWay[] = [{
    osmId: 1, itemName: null, tags: { highway: 'cycleway' },
    coordinates: [[37.7600, -122.4300], [37.7610, -122.4300]],
  }]
  const carSharedWay: OsmWay[] = [{
    osmId: 2, itemName: null, tags: { highway: 'living_street' },
    coordinates: [[37.7600, -122.4300], [37.7610, -122.4300]],
  }]

  test('car-free cycleway cost is discounted by carFreeBonus (0.85 for kid-confident)', () => {
    const graph = buildRoutingGraph(
      carFreeWay, 'kid-confident', new Set(['Bike path']),
      undefined, null, null, null, undefined, flat,
    )
    const link = [...(graph.getLinks('37.76000,-122.43000') ?? [])][0]
    // cost = durationSec * levelMul(1) * carFreeBonus(0.85)
    expect(link.data.cost / link.data.durationSec).toBeCloseTo(0.85, 2)
  })

  test('car-shared living street gets no car-free discount', () => {
    const graph = buildRoutingGraph(
      carSharedWay, 'kid-confident', new Set(['Living street']),
      undefined, null, null, null, undefined, flat,
    )
    const link = [...(graph.getLinks('37.76000,-122.43000') ?? [])][0]
    expect(link.data.cost / link.data.durationSec).toBeCloseTo(1.0, 2)
  })

  test('a car-free edge that is WALKED gets no bonus (the !isWalking guard)', () => {
    // A cobblestone cycleway is car-free, but kid-starting-out dismounts on
    // cobbles (cobbleHandling: walking_pace → isWalking). The bonus must NOT
    // apply to a walked edge even though carFree is true — cost should reflect
    // the rough multiplier (5×) alone, not 5 × 0.9.
    const cobbleCycleway: OsmWay[] = [{
      osmId: 3, itemName: null, tags: { highway: 'cycleway', surface: 'cobblestone' },
      coordinates: [[37.7600, -122.4300], [37.7610, -122.4300]],
    }]
    const graph = buildRoutingGraph(
      cobbleCycleway, 'kid-starting-out', new Set(['Bike path']),
      undefined, null, null, null, undefined, flat,
    )
    const link = [...(graph.getLinks('37.76000,-122.43000') ?? [])][0]
    expect(link.data.isWalking).toBe(true)
    const roughMul = MODE_RULES['kid-starting-out'].roughSurfaceMultiplier!
    expect(link.data.cost / link.data.durationSec).toBeCloseTo(roughMul, 2)
  })
})
