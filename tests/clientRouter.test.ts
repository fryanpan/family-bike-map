import { describe, test, expect } from 'bun:test'
import { buildRoutingGraph, routeOnGraph, haversineM } from '../src/services/clientRouter'
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
    // pace is 2 km/h (a 4-year-old walking alongside a parent).
    const walkingSpeed = 2 / 3.6 // kid-starting-out walkingSpeedKmh
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

  test('kid-starting-out bridge-walks ordinary quiet residential; kid-confident rides it', () => {
    // Quiet residential street with no bike-priority designation.
    // kid-confident accepts it for riding (full Furth LTS 1), kid-starting-out
    // only bridge-walks it (cars aren't structurally constrained so riding
    // isn't safe at this level, but the sidewalk lets the rider walk across).
    const residentialWays: OsmWay[] = [{
      osmId: 43,
      itemName: null,
      tags: { highway: 'residential', maxspeed: '30' },
      coordinates: [[52.5000, 13.4000], [52.5010, 13.4000]],
    }]
    const gStart = buildRoutingGraph(residentialWays, 'kid-starting-out', new Set())
    const gConf  = buildRoutingGraph(residentialWays, 'kid-confident',    new Set())

    const startLink = gStart.getLink('52.50000,13.40000', '52.50100,13.40000')
    const confLink  = gConf.getLink('52.50000,13.40000', '52.50100,13.40000')

    expect(startLink!.data.isWalking).toBe(true)
    expect(confLink!.data.isWalking).toBe(false)
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
