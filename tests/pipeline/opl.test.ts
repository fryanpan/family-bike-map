import { describe, expect, test } from 'bun:test'
import { decodeOplField, parseOplLine, parseOplTags } from '../../scripts/pipeline/lib/opl'

describe('decodeOplField', () => {
  test('decodes hex escape sequences', () => {
    expect(decodeOplField('Alpha%20%Street')).toBe('Alpha Street')
    expect(decodeOplField('a%2c%b')).toBe('a,b')
    expect(decodeOplField('k%3d%v')).toBe('k=v')
    expect(decodeOplField('caf%e9%')).toBe('café')
  })

  test('passes plain strings through', () => {
    expect(decodeOplField('residential')).toBe('residential')
    expect(decodeOplField('')).toBe('')
  })
})

describe('parseOplTags', () => {
  test('parses multiple tags', () => {
    expect(parseOplTags('highway=residential,name=Alpha%20%Street')).toEqual({
      highway: 'residential',
      name: 'Alpha Street',
    })
  })

  test('empty field yields no tags', () => {
    expect(parseOplTags('')).toEqual({})
  })

  test('escaped separators stay inside key/value', () => {
    expect(parseOplTags('note=a%2c%b%3d%c')).toEqual({ note: 'a,b=c' })
  })
})

describe('parseOplLine', () => {
  test('parses a node line (osmium cat default metadata fields)', () => {
    const obj = parseOplLine('n101 v1 dV c0 t i0 u T x-122.452 y37.762')
    expect(obj).toEqual({ type: 'node', id: 101, lat: 37.762, lon: -122.452, tags: {} })
  })

  test('parses a tagged node line', () => {
    const obj = parseOplLine('n301 v1 dV c0 t i0 u Thighway=traffic_signals x-122.4511 y37.7621')
    expect(obj).toEqual({
      type: 'node',
      id: 301,
      lat: 37.7621,
      lon: -122.4511,
      tags: { highway: 'traffic_signals' },
    })
  })

  test('parses a way line with tags and node refs', () => {
    const obj = parseOplLine('w201 v1 dV c0 t i0 u Thighway=residential,name=Alpha%20%Street Nn101,n102,n103')
    expect(obj).toEqual({
      type: 'way',
      id: 201,
      nodeRefs: [101, 102, 103],
      tags: { highway: 'residential', name: 'Alpha Street' },
    })
  })

  test('skips relations, blank lines, and coordinate-less nodes', () => {
    expect(parseOplLine('r9 v1 dV c0 t i0 u Ttype=multipolygon Mw201@outer')).toBeNull()
    expect(parseOplLine('')).toBeNull()
    expect(parseOplLine('n5 v1 dV c0 t i0 u T x y')).toBeNull()
  })
})
