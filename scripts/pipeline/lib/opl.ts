// OPL (Object Per Line) parser for the enrichment pipeline.
//
// The pipeline shells out to the osmium CLI to filter a .osm.pbf and dump it
// as OPL (`osmium cat -o file.opl`), then parses each line here. OPL is a
// stable line-based format: one object per line, space-separated fields, each
// field identified by its first character. See
// https://osmcode.org/opl-file-format/
//
// We only consume nodes (id, lat/lon, tags) and ways (id, node refs, tags).
// Relations are never emitted by our osmium filter and are skipped.

export interface OplNode {
  type: 'node'
  id: number
  /** Latitude in degrees. */
  lat: number
  /** Longitude in degrees. */
  lon: number
  tags: Record<string, string>
}

export interface OplWay {
  type: 'way'
  id: number
  /** Ordered node ids making up the way geometry. */
  nodeRefs: number[]
  tags: Record<string, string>
}

export type OplObject = OplNode | OplWay

/**
 * Decode OPL escape sequences: `%<hex codepoint>%`.
 * E.g. `%20%` → space, `%2c%` → comma, `%3d%` → equals sign.
 */
export function decodeOplField(s: string): string {
  return s.replace(/%([0-9a-fA-F]+)%/g, (_m, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  )
}

/** Parse an OPL `T` field (`k1=v1,k2=v2,...`) into a tag record. */
export function parseOplTags(field: string): Record<string, string> {
  const tags: Record<string, string> = {}
  if (field === '') return tags
  for (const pair of field.split(',')) {
    // '=' inside keys/values is escaped (%3d%), so the first raw '=' splits.
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    tags[decodeOplField(pair.slice(0, eq))] = decodeOplField(pair.slice(eq + 1))
  }
  return tags
}

/**
 * Parse one OPL line into a node or way, or null for anything else
 * (relations, changesets, blank lines).
 */
export function parseOplLine(line: string): OplObject | null {
  if (line.length === 0) return null
  const kind = line[0]
  if (kind !== 'n' && kind !== 'w') return null

  const fields = line.split(' ')
  const id = Number(fields[0].slice(1))
  if (!Number.isFinite(id)) return null

  let tags: Record<string, string> = {}
  let lat: number | null = null
  let lon: number | null = null
  let nodeRefs: number[] = []

  for (let i = 1; i < fields.length; i++) {
    const f = fields[i]
    const body = f.slice(1)
    switch (f[0]) {
      case 'T':
        tags = parseOplTags(body)
        break
      case 'x':
        lon = body === '' ? null : Number(body)
        break
      case 'y':
        lat = body === '' ? null : Number(body)
        break
      case 'N':
        // Node ref list: "Nn123,n456,..." — each ref prefixed with 'n'.
        nodeRefs = body === ''
          ? []
          : body.split(',').map((r) => Number(r.slice(1)))
        break
      default:
        // v (version), d (deleted), c (changeset), t (timestamp),
        // i (uid), u (user) — metadata we don't need.
        break
    }
  }

  if (kind === 'n') {
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
    return { type: 'node', id, lat, lon, tags }
  }
  return { type: 'way', id, nodeRefs, tags }
}
