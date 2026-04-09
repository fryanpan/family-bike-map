import { describe, test, expect } from 'bun:test'
import { parseMessages, buildBRouterSegments } from '../src/services/brouter'

describe('parseMessages', () => {
  test('parses header + data rows correctly', () => {
    const messages: Array<(string | number)[]> = [
      ['Longitude', 'Latitude', 'Elevation', 'Distance', 'CostPerKm', 'ElevCost', 'TurnCost', 'NodeCost', 'InitialCost', 'WayTags', 'NodeTags', 'Time', 'Energy'],
      [13388800, 52517147, 42, 13, 1650, 0, 0, 0, 0, 'highway=secondary surface=asphalt', '', 2, 218],
      [13390000, 52518000, 40, 150, 1200, 0, 5, 0, 0, 'highway=cycleway bicycle_road=yes', '', 15, 300],
    ]

    const rows = parseMessages(messages)

    expect(rows).toHaveLength(2)

    // First row
    expect(rows[0].lng).toBeCloseTo(13.3888, 4)
    expect(rows[0].lat).toBeCloseTo(52.517147, 4)
    expect(rows[0].distance).toBe(13)
    expect(rows[0].time).toBe(2)
    expect(rows[0].wayTags).toEqual({ highway: 'secondary', surface: 'asphalt' })

    // Second row
    expect(rows[1].lng).toBeCloseTo(13.39, 4)
    expect(rows[1].lat).toBeCloseTo(52.518, 3)
    expect(rows[1].wayTags).toEqual({ highway: 'cycleway', bicycle_road: 'yes' })
  })

  test('returns empty array for empty or header-only messages', () => {
    expect(parseMessages([])).toEqual([])
    expect(parseMessages([['Longitude', 'Latitude']])).toEqual([])
  })

  test('handles missing WayTags gracefully', () => {
    const messages: Array<(string | number)[]> = [
      ['Longitude', 'Latitude', 'Distance', 'Time'],
      [13388800, 52517147, 100, 10],
    ]
    const rows = parseMessages(messages)
    expect(rows).toHaveLength(1)
    expect(rows[0].wayTags).toEqual({})
  })
})

describe('buildBRouterSegments', () => {
  test('groups consecutive same-type rows into segments', () => {
    const messages: Array<(string | number)[]> = [
      ['Longitude', 'Latitude', 'Elevation', 'Distance', 'WayTags', 'Time'],
      [13388800, 52517000, 42, 0, 'highway=cycleway', 0],
      [13389000, 52517200, 42, 50, 'highway=cycleway', 5],
      [13389500, 52517500, 42, 80, 'highway=residential', 8],
    ]

    const rows = parseMessages(messages)
    const segments = buildBRouterSegments(rows, [[52.517, 13.3888]])

    expect(segments).toHaveLength(2)
    expect(segments[0].itemName).toBe('Separated bike path')
    expect(segments[0].coordinates).toHaveLength(2)
    expect(segments[1].itemName).toBe('Quiet side street')
    // Bridge point: last of prev = first of next
    expect(segments[1].coordinates).toHaveLength(2)
  })

  test('classifies bicycle_road=yes as Fahrradstrasse', () => {
    const messages: Array<(string | number)[]> = [
      ['Longitude', 'Latitude', 'Elevation', 'Distance', 'WayTags', 'Time'],
      [13388800, 52517000, 42, 0, 'highway=residential bicycle_road=yes', 0],
    ]

    const rows = parseMessages(messages)
    const segments = buildBRouterSegments(rows, [[52.517, 13.3888]])

    expect(segments).toHaveLength(1)
    expect(segments[0].itemName).toBe('Fahrradstrasse')
  })

  test('returns empty segments for empty input', () => {
    expect(buildBRouterSegments([], [])).toEqual([])
  })
})
