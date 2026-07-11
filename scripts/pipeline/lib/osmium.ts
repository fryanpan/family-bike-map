// Thin wrappers around the osmium CLI (https://osmcode.org/osmium-tool/).
//
// Install on macOS: `brew install osmium-tool` (documented in the
// enriched-tiles plan; the pipeline refuses to run without it).
//
// All invocations are synchronous foreground calls — the pipeline is a batch
// job and each osmium step must finish before the next reads its output.

import { spawnSync } from 'node:child_process'

/** Throws with an install hint if the osmium CLI is not on PATH. */
export function assertOsmiumAvailable(): void {
  const r = spawnSync('osmium', ['--version'], { encoding: 'utf8' })
  if (r.error || r.status !== 0) {
    throw new Error(
      'osmium CLI not found on PATH. Install it with `brew install osmium-tool` ' +
      '(macOS) or your distro package manager (Linux: `apt install osmium-tool`).',
    )
  }
}

function runOsmium(args: string[]): void {
  const r = spawnSync('osmium', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw r.error
  if (r.status !== 0) {
    throw new Error(`osmium ${args.join(' ')} failed (exit ${r.status}):\n${r.stderr}`)
  }
}

/**
 * Clip the input to a bbox. Uses --strategy=complete_ways so ways touching
 * the bbox keep their FULL geometry (Overpass `out geom` also returns full
 * way geometry for ways with at least one node in the bbox — parity matters,
 * see lib/filter.ts header).
 */
export function osmiumExtract(
  inPbf: string,
  outPbf: string,
  bbox: { south: number; west: number; north: number; east: number },
): void {
  // osmium -b order is LEFT,BOTTOM,RIGHT,TOP = west,south,east,north.
  const b = `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`
  runOsmium(['extract', '-b', b, '--strategy=complete_ways', inPbf, '-o', outPbf, '-O'])
}

/**
 * Coarse tag prefilter — a strict SUPERSET of the buildQuery() filter (any
 * highway-tagged way, any bicycle_road=yes way, traffic_signals/stop nodes).
 * Shrinks the working set cheaply in C++; the EXACT Overpass-mirroring
 * predicate (lib/filter.ts) is then applied per object in TypeScript.
 * osmium tags-filter keeps referenced objects by default, so the nodes of
 * every kept way survive for geometry resolution.
 */
export function osmiumCoarseTagsFilter(inPbf: string, outPbf: string): void {
  runOsmium([
    'tags-filter', inPbf,
    'w/highway',
    'w/bicycle_road=yes',
    'n/highway=traffic_signals,stop',
    '-o', outPbf, '-O',
  ])
}

/** Convert a PBF to OPL text for line-by-line parsing (lib/opl.ts). */
export function osmiumCatToOpl(inPbf: string, outOpl: string): void {
  runOsmium(['cat', inPbf, '-o', outOpl, '-O'])
}

/**
 * Read a single header variable from a PBF via `osmium fileinfo -g`, e.g.
 * `header.option.osmosis_replication_sequence_number`. Returns null when the
 * header doesn't carry the variable (typical for hand-built extracts).
 */
export function readPbfHeaderValue(pbf: string, variable: string): string | null {
  const r = spawnSync('osmium', ['fileinfo', '-g', variable, pbf], { encoding: 'utf8' })
  if (r.error || r.status !== 0) return null
  const value = (r.stdout ?? '').trim()
  return value === '' ? null : value
}
