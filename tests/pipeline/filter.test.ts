import { describe, expect, test } from 'bun:test'
import {
  matchesOverpassControlNodeFilter,
  matchesOverpassWayFilter,
} from '../../scripts/pipeline/lib/filter'
import { buildQuery } from '../../src/services/overpass'

describe('matchesOverpassWayFilter', () => {
  const included: Array<[string, Record<string, string>]> = [
    ['cycleway', { highway: 'cycleway' }],
    ['bicycle_road=yes (even without highway)', { bicycle_road: 'yes' }],
    ['living_street', { highway: 'living_street' }],
    ['residential', { highway: 'residential' }],
    ['residential with bicycle=dismount (!= no)', { highway: 'residential', bicycle: 'dismount' }],
    ['path', { highway: 'path' }],
    ['track', { highway: 'track' }],
    ['footway bicycle=yes', { highway: 'footway', bicycle: 'yes' }],
    ['footway bicycle=designated', { highway: 'footway', bicycle: 'designated' }],
    ['pedestrian bicycle=yes (JFK Promenade class)', { highway: 'pedestrian', bicycle: 'yes' }],
    ['pedestrian bicycle=designated', { highway: 'pedestrian', bicycle: 'designated' }],
    ['secondary with cycleway=lane', { highway: 'secondary', cycleway: 'lane' }],
    ['secondary with cycleway:right=lane', { highway: 'secondary', 'cycleway:right': 'lane' }],
    ['primary with cycleway:left=track', { highway: 'primary', 'cycleway:left': 'track' }],
    ['tertiary with cycleway:both=opposite_lane', { highway: 'tertiary', 'cycleway:both': 'opposite_lane' }],
    ['unclassified with cycleway=opposite_track', { highway: 'unclassified', cycleway: 'opposite_track' }],
    ['primary with cycleway=share_busway', { highway: 'primary', cycleway: 'share_busway' }],
  ]
  for (const [label, tags] of included) {
    test(`includes ${label}`, () => {
      expect(matchesOverpassWayFilter(tags)).toBe(true)
    })
  }

  const excluded: Array<[string, Record<string, string>]> = [
    ['no tags', {}],
    ['primary without bike infra', { highway: 'primary' }],
    ['secondary without bike infra', { highway: 'secondary' }],
    ['residential with bicycle=no', { highway: 'residential', bicycle: 'no' }],
    ['path with bicycle=no', { highway: 'path', bicycle: 'no' }],
    ['plain footway (sidewalks)', { highway: 'footway' }],
    ['footway with bicycle=no', { highway: 'footway', bicycle: 'no' }],
    ['footway with bicycle=permissive (not yes|designated)', { highway: 'footway', bicycle: 'permissive' }],
    ['plain pedestrian (shopping street)', { highway: 'pedestrian' }],
    ['cycleway tag with non-infra value', { highway: 'primary', cycleway: 'no' }],
    ['cycleway=shared_lane (sharrow) not fetched', { highway: 'residential', bicycle: 'no', cycleway: 'shared_lane' }],
    ['cycleway:left=separate not fetched', { highway: 'primary', 'cycleway:left': 'separate' }],
    ['bicycle_road=no', { bicycle_road: 'no', highway: 'primary' }],
    ['non-highway object (building)', { building: 'yes' }],
  ]
  for (const [label, tags] of excluded) {
    test(`excludes ${label}`, () => {
      expect(matchesOverpassWayFilter(tags)).toBe(false)
    })
  }
})

describe('matchesOverpassControlNodeFilter', () => {
  test('matches traffic_signals and stop', () => {
    expect(matchesOverpassControlNodeFilter({ highway: 'traffic_signals' })).toBe(true)
    expect(matchesOverpassControlNodeFilter({ highway: 'stop' })).toBe(true)
  })
  test('rejects other node tags', () => {
    expect(matchesOverpassControlNodeFilter({ highway: 'crossing' })).toBe(false)
    expect(matchesOverpassControlNodeFilter({ highway: 'give_way' })).toBe(false)
    expect(matchesOverpassControlNodeFilter({})).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Drift tripwire: the pipeline filter (scripts/pipeline/lib/filter.ts) is a
// hand-mirrored translation of buildQuery(). This pins buildQuery's exact
// output — if it changes, this test fails, telling you to update the mirror
// (and this snapshot) in the same PR. See the header comment in
// scripts/pipeline/lib/filter.ts.
// ─────────────────────────────────────────────────────────────────────────────
test('buildQuery has not drifted from the pipeline filter mirror', () => {
  const query = buildQuery({ south: 1, west: 2, north: 3, east: 4 })
  expect(query).toBe(`
[out:json][timeout:25];
(
  way["highway"="cycleway"](1,2,3,4);
  way["bicycle_road"="yes"](1,2,3,4);
  way["highway"="living_street"](1,2,3,4);
  way["highway"~"^(residential|path|track)$"]["bicycle"!="no"](1,2,3,4);
  way["highway"="footway"]["bicycle"~"^(yes|designated)$"](1,2,3,4);
  way["highway"="pedestrian"]["bicycle"~"^(yes|designated)$"](1,2,3,4);
  way[~"^cycleway(:right|:left|:both)?$"~"^(track|lane|opposite_track|opposite_lane|share_busway)$"](1,2,3,4);
);
out geom;
node["highway"~"^(traffic_signals|stop)$"](1,2,3,4);
out;
`)
})
