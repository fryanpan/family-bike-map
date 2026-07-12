import { describe, it, expect } from 'bun:test'
import { tileKey, latLngToTile, tileBounds, getVisibleTiles, isTileCached, getCachedTile, Semaphore, AdaptiveConcurrencyGate, reportFetchOutcome, MIN_CONCURRENCY, MAX_CONCURRENCY, buildQuery, classifyOsmTagsToItem, isEnrichedTilePayload, parseEnrichedTileResponse, fetchBikeInfraForTile, isControlNode } from '../src/services/overpass'
import { isEnrichedWay } from '../src/utils/types'

// Minimal LatLngBounds stub
function makeBounds(south: number, west: number, north: number, east: number) {
  return {
    getSouth: () => south,
    getNorth: () => north,
    getWest:  () => west,
    getEast:  () => east,
  } as any
}

describe('tileKey', () => {
  it('produces a stable profile-independent string key', () => {
    expect(tileKey(52, 13)).toBe('52:13')
    expect(tileKey(-1, -2)).toBe('-1:-2')
  })

  it('is the same for any profile (profile-independent cache)', () => {
    // All profiles share the same tile data — itemName is computed at render time
    expect(tileKey(52, 13)).toBe(tileKey(52, 13))
  })
})

describe('latLngToTile', () => {
  it('maps Berlin center to correct tile', () => {
    // lat 52.52, lng 13.405 → row=floor(52.52/0.1)=525, col=floor(13.405/0.1)=134
    const { row, col } = latLngToTile(52.52, 13.405)
    expect(row).toBe(525)
    expect(col).toBe(134)
  })

  it('handles exact boundary (lat exactly on tile edge)', () => {
    const { row } = latLngToTile(52.5, 13.0)
    expect(row).toBe(525)
  })

  it('handles negative longitude', () => {
    const { col } = latLngToTile(37.77, -122.42)
    expect(col).toBe(-1225)
  })
})

describe('tileBounds', () => {
  it('is the inverse of latLngToTile (round-trips a coordinate into its tile)', () => {
    const { row, col } = latLngToTile(37.77, -122.42)
    const b = tileBounds(row, col)
    expect(b.south).toBeCloseTo(37.7, 6)
    expect(b.north).toBeCloseTo(37.8, 6)
    expect(b.west).toBeCloseTo(-122.5, 6)
    expect(b.east).toBeCloseTo(-122.4, 6)
    expect(37.77).toBeGreaterThanOrEqual(b.south)
    expect(37.77).toBeLessThan(b.north)
  })
})

describe('getVisibleTiles', () => {
  it('returns a single tile for a bbox within one tile', () => {
    // Bounds entirely inside tile row=525, col=134 (52.5–52.6, 13.4–13.5)
    const bounds = makeBounds(52.51, 13.41, 52.59, 13.49)
    const tiles = getVisibleTiles(bounds)
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toEqual({ row: 525, col: 134 })
  })

  it('returns 4 tiles for a bbox spanning 2×2 tiles', () => {
    // Bounds: 52.55–52.65 spans rows 525 and 526; 13.45–13.55 spans cols 134 and 135
    const bounds = makeBounds(52.55, 13.45, 52.65, 13.55)
    const tiles = getVisibleTiles(bounds)
    expect(tiles).toHaveLength(4)
    const rows = [...new Set(tiles.map((t) => t.row))].sort((a, b) => a - b)
    const cols = [...new Set(tiles.map((t) => t.col))].sort((a, b) => a - b)
    expect(rows).toEqual([525, 526])
    expect(cols).toEqual([134, 135])
  })

  it('returns a 3×2 grid for a wider bbox', () => {
    const bounds = makeBounds(52.51, 13.31, 52.69, 13.59)
    const tiles = getVisibleTiles(bounds)
    // rows: 525, 526  cols: 133, 134, 135
    expect(tiles).toHaveLength(6)
  })
})

describe('isTileCached / getCachedTile', () => {
  it('returns false/undefined before any fetch', () => {
    expect(isTileCached(9999, 9999)).toBe(false)
    expect(getCachedTile(9999, 9999)).toBeUndefined()
  })
})

describe('Semaphore', () => {
  it('allows up to N concurrent acquires immediately', async () => {
    const sem = new Semaphore(2)
    // Both acquires should resolve immediately without queuing
    await sem.acquire()
    await sem.acquire()
    // Third acquire should queue — verify by releasing and reacquiring
    let resolved = false
    const pending = sem.acquire().then(() => { resolved = true })
    expect(resolved).toBe(false)  // still waiting
    sem.release()
    await pending
    expect(resolved).toBe(true)
  })

  it('serializes excess acquires through releases', async () => {
    const sem = new Semaphore(1)
    const order: number[] = []

    await sem.acquire()
    const p1 = sem.acquire().then(() => { order.push(1); sem.release() })
    const p2 = sem.acquire().then(() => { order.push(2); sem.release() })

    sem.release()  // unblocks p1
    await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])  // FIFO ordering
  })

  it('restores count on release when queue is empty', async () => {
    const sem = new Semaphore(2)
    await sem.acquire()
    sem.release()
    // Should be back to full capacity — both acquires below should not block
    await sem.acquire()
    await sem.acquire()
    // No assertion needed — if these hang the test times out
  })
})

function makeResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers })
}

describe('AdaptiveConcurrencyGate', () => {
  it('starts at MIN_CONCURRENCY', () => {
    const gate = new AdaptiveConcurrencyGate()
    expect(gate.limit).toBe(MIN_CONCURRENCY)
  })

  it('widens the limit by one step on an enriched response', () => {
    const gate = new AdaptiveConcurrencyGate()
    reportFetchOutcome(gate, makeResponse(200, { 'X-Tile-Source': 'enriched' }))
    expect(gate.limit).toBe(MIN_CONCURRENCY + 1)
  })

  it('snaps back to MIN_CONCURRENCY on X-Tile-Source: overpass', () => {
    const gate = new AdaptiveConcurrencyGate()
    // Widen a couple of steps first.
    reportFetchOutcome(gate, makeResponse(200, { 'X-Tile-Source': 'enriched' }))
    reportFetchOutcome(gate, makeResponse(200, { 'X-Tile-Source': 'enriched' }))
    expect(gate.limit).toBe(MIN_CONCURRENCY + 2)

    reportFetchOutcome(gate, makeResponse(200, { 'X-Tile-Source': 'overpass' }))
    expect(gate.limit).toBe(MIN_CONCURRENCY)
  })

  it('snaps back to MIN_CONCURRENCY when the header is missing', () => {
    const gate = new AdaptiveConcurrencyGate()
    reportFetchOutcome(gate, makeResponse(200, { 'X-Tile-Source': 'enriched' }))
    expect(gate.limit).toBe(MIN_CONCURRENCY + 1)

    reportFetchOutcome(gate, makeResponse(200)) // no X-Tile-Source header at all
    expect(gate.limit).toBe(MIN_CONCURRENCY)
  })

  it('snaps back to MIN_CONCURRENCY on HTTP 429', () => {
    const gate = new AdaptiveConcurrencyGate()
    reportFetchOutcome(gate, makeResponse(200, { 'X-Tile-Source': 'enriched' }))
    expect(gate.limit).toBe(MIN_CONCURRENCY + 1)

    reportFetchOutcome(gate, makeResponse(429))
    expect(gate.limit).toBe(MIN_CONCURRENCY)
  })

  it('snaps back to MIN_CONCURRENCY on any 5xx', () => {
    const gate = new AdaptiveConcurrencyGate()
    reportFetchOutcome(gate, makeResponse(200, { 'X-Tile-Source': 'enriched' }))
    expect(gate.limit).toBe(MIN_CONCURRENCY + 1)

    reportFetchOutcome(gate, makeResponse(503))
    expect(gate.limit).toBe(MIN_CONCURRENCY)

    reportFetchOutcome(gate, makeResponse(200, { 'X-Tile-Source': 'enriched' }))
    reportFetchOutcome(gate, makeResponse(500))
    expect(gate.limit).toBe(MIN_CONCURRENCY)
  })

  it('snaps back to MIN_CONCURRENCY on a network error (null response)', () => {
    const gate = new AdaptiveConcurrencyGate()
    reportFetchOutcome(gate, makeResponse(200, { 'X-Tile-Source': 'enriched' }))
    expect(gate.limit).toBe(MIN_CONCURRENCY + 1)

    reportFetchOutcome(gate, null)
    expect(gate.limit).toBe(MIN_CONCURRENCY)
  })

  it('never exceeds MAX_CONCURRENCY no matter how many enriched responses arrive', () => {
    const gate = new AdaptiveConcurrencyGate()
    for (let i = 0; i < MAX_CONCURRENCY + 10; i++) {
      reportFetchOutcome(gate, makeResponse(200, { 'X-Tile-Source': 'enriched' }))
    }
    expect(gate.limit).toBe(MAX_CONCURRENCY)
  })

  it('never drops below MIN_CONCURRENCY no matter how many snaps arrive', () => {
    const gate = new AdaptiveConcurrencyGate()
    for (let i = 0; i < 10; i++) {
      reportFetchOutcome(gate, makeResponse(429))
    }
    expect(gate.limit).toBe(MIN_CONCURRENCY)
    expect(gate.limit).toBeGreaterThanOrEqual(MIN_CONCURRENCY)
  })

  it('allows up to `limit` concurrent acquires immediately, queues beyond that', async () => {
    const gate = new AdaptiveConcurrencyGate(2)
    await gate.acquire()
    await gate.acquire()
    let resolved = false
    const pending = gate.acquire().then(() => { resolved = true })
    expect(resolved).toBe(false)
    gate.release()
    await pending
    expect(resolved).toBe(true)
  })

  it('growing the limit wakes queued waiters immediately, without waiting for a release', async () => {
    const gate = new AdaptiveConcurrencyGate(1)
    await gate.acquire() // fills the only slot; inFlight=1, limit=1

    let resolved = false
    const pending = gate.acquire().then(() => { resolved = true })
    // Give any stray microtask a chance to run — it should still be queued.
    await Promise.resolve()
    expect(resolved).toBe(false)

    // Widen the limit to 2 without releasing the first slot — the queued
    // waiter should be granted immediately because inFlight(1) < limit(2).
    gate.widen()
    await pending
    expect(resolved).toBe(true)
    expect(gate.inFlight).toBe(2)
  })

  it('shrinking the limit does not abort in-flight work — it just withholds new grants', async () => {
    const gate = new AdaptiveConcurrencyGate(4)
    await gate.acquire()
    await gate.acquire()
    await gate.acquire()
    expect(gate.inFlight).toBe(3)

    // Snap the limit down below the current in-flight count.
    gate.snapToMin()
    expect(gate.limit).toBe(MIN_CONCURRENCY)

    // The 3 already-acquired slots are untouched — no exception, no forced release.
    expect(gate.inFlight).toBe(3)

    // A new acquire queues rather than being granted, since inFlight(3) >= new limit.
    let resolved = false
    const pending = gate.acquire().then(() => { resolved = true })
    await Promise.resolve()
    expect(resolved).toBe(false)

    // As in-flight work completes and drops below the new (lower) limit,
    // the queued waiter is eventually granted — nothing was lost.
    gate.release() // inFlight 3 -> 2, still below MIN_CONCURRENCY(2)? equal now
    if (!resolved) gate.release()
    await pending
    expect(resolved).toBe(true)
  })

  it('FIFO orders queued waiters through releases, same as Semaphore', async () => {
    const gate = new AdaptiveConcurrencyGate(1)
    const order: number[] = []

    await gate.acquire()
    const p1 = gate.acquire().then(() => { order.push(1); gate.release() })
    const p2 = gate.acquire().then(() => { order.push(2); gate.release() })

    gate.release() // unblocks p1
    await Promise.all([p1, p2])
    expect(order).toEqual([1, 2])
  })
})

describe('classifyOsmTagsToItem', () => {
  it('returns Fahrradstrasse for bicycle_road=yes', () => {
    expect(classifyOsmTagsToItem({ bicycle_road: 'yes' }, 'kid-starting-out')).toBe('Fahrradstrasse')
  })

  it('returns Car-free path for highway=cycleway', () => {
    expect(classifyOsmTagsToItem({ highway: 'cycleway' }, 'kid-starting-out')).toBe('Bike path')
  })

  it('returns Elevated sidewalk path for separated bike track on quiet road (all profiles)', () => {
    // Residential underlying road = trafficDensity 'low' → quiet variant.
    const tags = { highway: 'residential', cycleway: 'track' }
    expect(classifyOsmTagsToItem(tags, 'kid-starting-out')).toBe('Elevated sidewalk path')
    expect(classifyOsmTagsToItem(tags, 'carrying-kid')).toBe('Elevated sidewalk path')
    expect(classifyOsmTagsToItem(tags, 'training')).toBe('Elevated sidewalk path')
    expect(classifyOsmTagsToItem(tags, 'unknown')).toBe('Elevated sidewalk path')
  })

  it('returns Protected bike lane on major road for separated track on busy road', () => {
    // Folsom St / 17th St pattern: cycleway:right=track on secondary/tertiary.
    // Same OSM tagging as a curb-separated cycle track in a residential
    // neighborhood, but adjacent traffic makes it kid-stressful — the legend
    // marks it non-preferred for kid-starting-out and kid-confident.
    expect(classifyOsmTagsToItem({ highway: 'tertiary', 'cycleway:right': 'track' }, 'kid-confident')).toBe('Protected bike lane on major road')
    expect(classifyOsmTagsToItem({ highway: 'secondary', cycleway: 'track' }, 'kid-traffic-savvy')).toBe('Protected bike lane on major road')
    expect(classifyOsmTagsToItem({ highway: 'primary', 'cycleway:both': 'track' }, 'carrying-kid')).toBe('Protected bike lane on major road')
  })


  it('returns Painted bike lane on quiet street for cycleway=lane on residential', () => {
    expect(classifyOsmTagsToItem({ highway: 'residential', cycleway: 'lane' }, 'kid-starting-out')).toBe('Painted bike lane on quiet street')
  })

  it('does NOT remap rough surfaces to a Rough-surface item (rough is orthogonal)', () => {
    // Cobblestone bike path still classifies as "Bike path". Callers use
    // isRoughSurface() separately for overlay-hide + 5× routing penalty.
    expect(classifyOsmTagsToItem({ highway: 'cycleway', surface: 'cobblestone' }, 'kid-starting-out')).toBe('Bike path')
    expect(classifyOsmTagsToItem({ highway: 'cycleway', smoothness: 'bad' }, 'kid-starting-out')).toBe('Bike path')
    expect(classifyOsmTagsToItem({ highway: 'residential', smoothness: 'very_bad' }, 'kid-starting-out')).toBe('Quiet street')
  })

  it('returns Quiet street for plain residential', () => {
    expect(classifyOsmTagsToItem({ highway: 'residential' }, 'kid-starting-out')).toBe('Quiet street')
  })

  it('returns Shared use path for footway with bicycle=yes', () => {
    expect(classifyOsmTagsToItem({ highway: 'footway', bicycle: 'yes' }, 'kid-starting-out')).toBe('Shared use path')
    expect(classifyOsmTagsToItem({ highway: 'footway', bicycle: 'designated' }, 'kid-starting-out')).toBe('Shared use path')
  })

  it('returns Shared use path for bike-designated pedestrian promenade', () => {
    // SF JFK Promenade: highway=pedestrian + bicycle=designated (+ motor_vehicle=bus).
    expect(classifyOsmTagsToItem({ highway: 'pedestrian', bicycle: 'designated', motor_vehicle: 'bus' }, 'kid-starting-out')).toBe('Shared use path')
    expect(classifyOsmTagsToItem({ highway: 'pedestrian', bicycle: 'designated' }, 'kid-confident')).toBe('Shared use path')
  })

  it('returns Bike boulevard for residential with motor_vehicle=destination', () => {
    expect(classifyOsmTagsToItem({ highway: 'residential', motor_vehicle: 'destination' }, 'kid-confident')).toBe('Bike boulevard')
    expect(classifyOsmTagsToItem({ highway: 'residential', motor_vehicle: 'permissive' }, 'kid-confident')).toBe('Bike boulevard')
  })

  it('returns Major road for busy residentials', () => {
    // residential + maxspeed 50 + 4 lanes → LTS 3 per classifyEdge
    expect(classifyOsmTagsToItem({ highway: 'residential', maxspeed: '50', lanes: '4' }, 'carrying-kid')).toBe('Major road')
  })

  it('returns Painted bike lane on major road for painted lane on faster streets', () => {
    expect(classifyOsmTagsToItem({ highway: 'tertiary', cycleway: 'lane', maxspeed: '50' }, 'kid-traffic-savvy')).toBe('Painted bike lane on major road')
  })

  it('returns Painted bike lane on quiet street for painted lane at ≤30 km/h', () => {
    expect(classifyOsmTagsToItem({ highway: 'residential', cycleway: 'lane', maxspeed: '30' }, 'kid-traffic-savvy')).toBe('Painted bike lane on quiet street')
  })
})

describe('classifyOsmTagsToItem with rules', () => {
  it('rule match overrides hardcoded classification', () => {
    const rules = [{ match: { highway: 'tertiary' }, classification: 'Low-speed side street', travelModes: {} }]
    expect(classifyOsmTagsToItem({ highway: 'tertiary' }, 'kid-starting-out', rules)).toBe('Low-speed side street')
  })

  it('falls through to hardcoded when no rule matches', () => {
    const rules = [{ match: { highway: 'motorway' }, classification: 'Highway', travelModes: {} }]
    expect(classifyOsmTagsToItem({ highway: 'cycleway' }, 'kid-starting-out', rules)).toBe('Bike path')
  })

  it('first matching rule wins', () => {
    const rules = [
      { match: { highway: 'tertiary' }, classification: 'First', travelModes: {} },
      { match: { highway: 'tertiary' }, classification: 'Second', travelModes: {} },
    ]
    expect(classifyOsmTagsToItem({ highway: 'tertiary' }, 'kid-starting-out', rules)).toBe('First')
  })

  it('rule with multiple match keys requires all to match', () => {
    const rules = [{ match: { highway: 'residential', surface: 'asphalt' }, classification: 'Smooth residential', travelModes: {} }]
    // Only one key matches — should fall through
    expect(classifyOsmTagsToItem({ highway: 'residential' }, 'kid-starting-out', rules)).toBe('Quiet street')
    // Both keys match — rule applies
    expect(classifyOsmTagsToItem({ highway: 'residential', surface: 'asphalt' }, 'kid-starting-out', rules)).toBe('Smooth residential')
  })

  it('rules bypass bad-surface filter', () => {
    // Hardcoded logic would return null for cobblestone, but a rule match takes priority
    const rules = [{ match: { highway: 'cycleway', surface: 'cobblestone' }, classification: 'Historic cycleway', travelModes: {} }]
    expect(classifyOsmTagsToItem({ highway: 'cycleway', surface: 'cobblestone' }, 'kid-starting-out', rules)).toBe('Historic cycleway')
  })
})

describe('buildQuery', () => {
  const bbox = { south: 52.5, west: 13.4, north: 52.6, east: 13.5 }

  it('includes the bounding box', () => {
    const q = buildQuery(bbox)
    expect(q).toContain('52.5,13.4,52.6,13.5')
  })

  it('has exactly 7 sub-queries (down from 18)', () => {
    const q = buildQuery(bbox)
    // Each sub-query starts with "way["
    const subQueryCount = (q.match(/^\s*way\[/gm) ?? []).length
    expect(subQueryCount).toBe(7)
  })

  it('combines cycleway variants with a key regex', () => {
    const q = buildQuery(bbox)
    expect(q).toContain('~"^cycleway(:right|:left|:both)?$"')
    expect(q).toContain('~"^(track|lane|opposite_track|opposite_lane|share_busway)$"')
  })

  it('combines residential/path/track with a highway regex', () => {
    const q = buildQuery(bbox)
    expect(q).toContain('"highway"~"^(residential|path|track)$"')
    expect(q).toContain('"bicycle"!="no"')
  })

  it('keeps footway with bicycle filter separate', () => {
    const q = buildQuery(bbox)
    expect(q).toContain('"highway"="footway"')
    expect(q).toContain('"bicycle"~"^(yes|designated)$"')
  })

  it('fetches traffic_signals and stop nodes for intersection costs', () => {
    const q = buildQuery(bbox)
    expect(q).toContain('node["highway"~"^(traffic_signals|stop)$"]')
  })

  it('fetches highway=pedestrian only with explicit bike access', () => {
    // Car-free shared-use promenades (SF JFK Promenade) are tagged
    // highway=pedestrian + bicycle=designated. Without this the entire
    // promenade is absent from the routing graph. Gated to bike-access
    // ways (same as footway) so plain pedestrian zones don't over-paint.
    const q = buildQuery(bbox)
    expect(q).toContain('"highway"="pedestrian"')
    const pedLine = q.split('\n').find((l) => l.includes('"highway"="pedestrian"'))
    expect(pedLine).toContain('"bicycle"~"^(yes|designated)$"')
  })
})

// ── Enriched R2 tile payloads (Worker {meta, ways} shape) ───────────────────

const ENRICHED_PAYLOAD = {
  meta: { builtFromSeq: 12345, builtAt: '2026-07-03T00:00:00Z', pipelineVersion: '1', demSource: 'terrarium-v1' },
  ways: [
    {
      osmId: 101,
      itemName: null,
      tags: { highway: 'cycleway' },
      coordinates: [[37.75, -122.45], [37.751, -122.45]],
      gradientPct: 4.2,
      accessGradientPct: 7.8,
      componentPaintedLenM: 5400,
    },
    {
      // DEM-void way: baked fields null (computed as unknown, fail-soft SHOWN).
      osmId: 102,
      itemName: null,
      tags: { highway: 'residential' },
      coordinates: [[37.752, -122.451], [37.753, -122.451]],
      gradientPct: null,
      accessGradientPct: null,
      componentPaintedLenM: null,
    },
    {
      // Control-node pseudo-way (single coordinate) — appended after real ways.
      osmId: 103,
      itemName: null,
      tags: { highway: 'traffic_signals' },
      coordinates: [[37.7505, -122.45]],
      gradientPct: null,
      accessGradientPct: null,
      componentPaintedLenM: null,
    },
  ],
}

describe('isEnrichedTilePayload', () => {
  it('detects the Worker enriched {meta, ways} shape', () => {
    expect(isEnrichedTilePayload(ENRICHED_PAYLOAD)).toBe(true)
    expect(isEnrichedTilePayload({ ways: [] })).toBe(true)
  })
  it('rejects the raw Overpass {elements} shape and junk', () => {
    expect(isEnrichedTilePayload({ elements: [] })).toBe(false)
    expect(isEnrichedTilePayload(null)).toBe(false)
    expect(isEnrichedTilePayload([])).toBe(false)
    expect(isEnrichedTilePayload({ ways: 'nope' })).toBe(false)
  })
})

describe('parseEnrichedTileResponse', () => {
  it('maps enriched ways to OsmWay with baked fields PRESENT (isEnrichedWay true)', () => {
    const ways = parseEnrichedTileResponse(ENRICHED_PAYLOAD)
    expect(ways).toHaveLength(3)
    expect(ways[0]).toEqual({
      itemName: null,
      osmId: 101,
      coordinates: [[37.75, -122.45], [37.751, -122.45]],
      tags: { highway: 'cycleway' },
      gradientPct: 4.2,
      accessGradientPct: 7.8,
      componentPaintedLenM: 5400,
    })
    // Every way from an enriched tile takes the arithmetic verdict gate,
    // including null-field (DEM void) ways — null is "computed as unknown",
    // which fail-softs to shown; undefined would wrongly re-enter the
    // runtime elevation/union-find path.
    for (const w of ways) expect(isEnrichedWay(w)).toBe(true)
    expect(ways[1].gradientPct).toBeNull()
  })

  it('keeps null fields present even when the payload omits them entirely', () => {
    const ways = parseEnrichedTileResponse({
      ways: [{ osmId: 7, tags: { highway: 'cycleway' }, coordinates: [[1, 2], [1.001, 2]] }],
    })
    expect(ways[0].gradientPct).toBeNull()
    expect(isEnrichedWay(ways[0])).toBe(true)
  })

  it('passes control-node pseudo-ways through (router needs them for wait costs)', () => {
    const ways = parseEnrichedTileResponse(ENRICHED_PAYLOAD)
    expect(isControlNode(ways[2])).toBe(true)
  })

  it('accepts the pipeline writer output verbatim (serializeEnrichedTile → parse)', async () => {
    // Writer/reader lock: what upload-tiles.ts puts in R2 is exactly what
    // buildEnrichedTile/serializeEnrichedTile emit — the client parser must
    // consume that byte stream, not a hand-approximated shape.
    const { buildEnrichedTile, serializeEnrichedTile } = await import('../scripts/pipeline/lib/tiles')
    const tile = buildEnrichedTile(
      { builtFromSeq: 1, builtAt: '2026-07-03T00:00:00Z', pipelineVersion: '1', demSource: 'terrarium-v1' },
      {
        row: 377, col: -1225,
        ways: [{ osmId: 55, tags: { highway: 'cycleway' }, coordinates: [[37.75, -122.45], [37.751, -122.45]], isControlNode: false }],
        controlNodes: [{ osmId: 56, tags: { highway: 'stop' }, coordinates: [[37.75, -122.45]], isControlNode: true }],
      },
      {
        gradientPct: () => 3.1,
        accessGradientPct: () => 5.5,
        componentPaintedLenM: () => 900,
      },
    )
    const parsed: unknown = JSON.parse(serializeEnrichedTile(tile))
    expect(isEnrichedTilePayload(parsed)).toBe(true)
    const ways = parseEnrichedTileResponse(parsed as { ways: unknown[] })
    expect(ways).toHaveLength(2)
    expect(ways[0]).toMatchObject({ osmId: 55, gradientPct: 3.1, accessGradientPct: 5.5, componentPaintedLenM: 900 })
    // Control nodes never carry enrichment values but stay enriched-present (null).
    expect(ways[1]).toMatchObject({ osmId: 56, gradientPct: null })
    expect(isControlNode(ways[1])).toBe(true)
    expect(ways.every(isEnrichedWay)).toBe(true)
  })

  it('skips malformed entries without failing the tile', () => {
    const ways = parseEnrichedTileResponse({
      ways: [
        null,
        'garbage',
        { osmId: 'not-a-number', coordinates: [[1, 2]] },
        { osmId: 8, coordinates: 'nope' },
        { osmId: 9, coordinates: [[1, 'x']] },
        { osmId: 10, tags: { highway: 'cycleway' }, coordinates: [[1, 2], [1.1, 2]] },
      ],
    })
    expect(ways).toHaveLength(1)
    expect(ways[0].osmId).toBe(10)
    expect(ways[0].tags).toEqual({ highway: 'cycleway' })
  })
})

describe('fetchBikeInfraForTile — enriched Worker responses', () => {
  async function withMockedFetch<T>(payload: unknown, fn: () => Promise<T>): Promise<T> {
    const origFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'R2', 'X-Tile-Source': 'enriched' },
      })) as unknown as typeof globalThis.fetch
    try {
      return await fn()
    } finally {
      globalThis.fetch = origFetch
    }
  }

  it('parses the {meta, ways} R2 payload end-to-end (the shape the Worker serves)', async () => {
    // The pre-fix bug: the client only understood Overpass {elements} and
    // threw a TypeError on `data.elements.length` for every enriched tile,
    // killing both the overlay and in-browser routing for the region.
    const ways = await withMockedFetch(ENRICHED_PAYLOAD, () => fetchBikeInfraForTile(910, 911))
    expect(ways).toHaveLength(3)
    expect(ways.every(isEnrichedWay)).toBe(true)
    expect(ways[0].gradientPct).toBe(4.2)
    expect(ways[0].componentPaintedLenM).toBe(5400)
    // And the parsed result is what got cached for the router's corridor reads.
    expect(getCachedTile(910, 911)).toEqual(ways)
  })

  it('still parses raw Overpass {elements} responses (non-enriched fallback)', async () => {
    const overpassPayload = {
      elements: [
        {
          type: 'way',
          id: 201,
          tags: { highway: 'cycleway' },
          geometry: [{ lat: 37.7, lon: -122.4 }, { lat: 37.701, lon: -122.4 }],
        },
        { type: 'node', id: 202, lat: 37.7, lon: -122.4, tags: { highway: 'traffic_signals' } },
      ],
    }
    const ways = await withMockedFetch(overpassPayload, () => fetchBikeInfraForTile(912, 913))
    expect(ways).toHaveLength(2)
    expect(ways[0].osmId).toBe(201)
    // Raw tiles never carry the baked fields — the runtime gate stays in charge.
    expect(ways.some(isEnrichedWay)).toBe(false)
  })
})

import { isOverlayCrossing } from '../src/services/overpass'

describe('isOverlayCrossing', () => {
  it('flags footway crossings and traffic islands', () => {
    expect(isOverlayCrossing({ highway: 'footway', footway: 'crossing' })).toBe(true)
    expect(isOverlayCrossing({ highway: 'footway', footway: 'traffic_island' })).toBe(true)
  })
  it('flags cycleway crossings and bare highway=crossing', () => {
    expect(isOverlayCrossing({ highway: 'cycleway', cycleway: 'crossing' })).toBe(true)
    expect(isOverlayCrossing({ highway: 'crossing' })).toBe(true)
  })
  it('does NOT flag real bike infra (cycleway, sidewalk footway, bike path)', () => {
    expect(isOverlayCrossing({ highway: 'cycleway' })).toBe(false)
    expect(isOverlayCrossing({ highway: 'footway', footway: 'sidewalk', bicycle: 'yes' })).toBe(false)
    expect(isOverlayCrossing({ highway: 'path', bicycle: 'designated' })).toBe(false)
  })
})
