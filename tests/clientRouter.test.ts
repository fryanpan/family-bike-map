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
    const graph = buildRoutingGraph(ways, 'kid-starting-out', new Set(['Bike path']))
    // 4 unique coordinates
    expect(graph.getNodeCount()).toBe(4)
  })

  test('creates edges in both directions for non-oneway', () => {
    const graph = buildRoutingGraph(ways, 'kid-starting-out', new Set(['Bike path']))
    // Way 1: 2 segments * 2 dirs = 4, Way 2: 1 segment * 2 dirs = 2, total = 6
    expect(graph.getLinkCount()).toBe(6)
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
    // Cost = time = distance / walking_speed. Walking and painted bike lanes
    // are both 3 km/h for toddler — between toddler walking and slow biking.
    const walkingSpeed = 3 / 3.6 // toddler walk speed (3 km/h)
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

  test('toddler mode: Fahrradstrasse is fastest, painted bike lane is near-walking', () => {
    // Fahrradstrasse edge
    const fahrradWays: OsmWay[] = [{
      osmId: 40,
      itemName: null,
      tags: { highway: 'residential', bicycle_road: 'yes' },
      coordinates: [[52.5000, 13.4000], [52.5010, 13.4000]],
    }]
    const paintedWays: OsmWay[] = [{
      osmId: 41,
      itemName: null,
      tags: { highway: 'secondary', cycleway: 'lane' },
      coordinates: [[52.5000, 13.4000], [52.5010, 13.4000]],
    }]

    const preferred = new Set(['Fahrradstrasse', 'Painted bike lane'])
    const gFahr = buildRoutingGraph(fahrradWays, 'kid-starting-out', preferred)
    const gPaint = buildRoutingGraph(paintedWays, 'kid-starting-out', preferred)

    const fahrLink = gFahr.getLink('52.50000,13.40000', '52.50100,13.40000')
    const paintLink = gPaint.getLink('52.50000,13.40000', '52.50100,13.40000')
    expect(fahrLink).toBeTruthy()
    expect(paintLink).toBeTruthy()

    // Fahrradstrasse (12 km/h) should be much cheaper than painted lane (3 km/h)
    // Same distance, so cost ratio should be ~4:1
    expect(paintLink!.data.cost / fahrLink!.data.cost).toBeGreaterThan(3.5)
    expect(paintLink!.data.cost / fahrLink!.data.cost).toBeLessThan(4.5)
  })

  test('prefers lower-cost edges', () => {
    // Two parallel paths: one cycleway (preferred, cost 1x), one residential (cost 3x)
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
    const graph = buildRoutingGraph(twoPath, 'kid-starting-out', preferred)
    const result = routeOnGraph(
      graph, 52.5000, 13.4000, 52.5010, 13.4020,
      'kid-starting-out', preferred,
    )
    expect(result).not.toBeNull()
    // Should take the cycleway (via 52.5005) not the residential (via 52.4995)
    const midLat = result!.coordinates[1][0]
    expect(midLat).toBeCloseTo(52.5005, 3)
  })
})
