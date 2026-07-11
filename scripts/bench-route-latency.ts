#!/usr/bin/env bun
/**
 * Route-latency benchmark — enriched-tiles plan, scope update §4 (phone
 * benchmark, desktop half). Fires N OD pairs per mode at a running route
 * server (server/route-server.ts) and prints p50/p95 wall-clock latency;
 * optionally runs the SAME pairs through the in-process production
 * clientRoute (over the same tile files) for the client-vs-server
 * comparison, with the graph/A* phase breakdown from routeTiming.ts.
 *
 * ONE implementation rule: no routing logic here — the client leg calls
 * the production clientRoute via the route server's own tile loader, and
 * the server leg exercises the production server end-to-end over HTTP.
 *
 * Usage:
 *   # start the server first (foreground, separate terminal):
 *   #   bun server/route-server.ts --tiles data/tiles --port 8787
 *   bun scripts/bench-route-latency.ts --url http://localhost:8787 \
 *       --bbox 37.75,-122.47,37.79,-122.41 [--n 20] [--seed 1] \
 *       [--modes kid-confident,training] [--warmup 2] \
 *       [--pairs pairs.json] [--client-tiles data/tiles]
 *
 * OD pairs come from --pairs (JSON: [{"start":{"lat":…,"lng":…},
 * "end":{…}}, …]) or are generated deterministically (--seed) inside
 * --bbox. Out-of-region pairs (HTTP 422) are counted but excluded from
 * the latency percentiles. Output is a markdown table ready to paste
 * into the comparison doc (docs/research/) next to the phone numbers
 * gathered per the protocol in server/README.md.
 */

import * as fs from 'node:fs'
import { parseArgs } from 'node:util'
import { MODE_RULES } from '../src/data/modes'
import { getDefaultPreferredItems } from '../src/utils/classify'
import { clientRoute } from '../src/services/clientRouter'
import { loadTilesIntoCache } from '../server/route-server'
import { getRouteTimings, clearRouteTimings } from '../src/services/routeTiming'

interface LatLng { lat: number; lng: number }
interface ODPair { start: LatLng; end: LatLng }

interface ModeStats {
  mode: string
  n: number
  found: number
  noRoute: number
  rejected: number // 4xx/422 (server) or thrown (client) — excluded from percentiles
  latenciesMs: number[]
  graphBuildMs: number[]
  astarMs: number[]
}

// Deterministic PRNG so --seed reproduces the exact pair set across runs.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomPairs(
  bbox: { south: number; west: number; north: number; east: number },
  n: number,
  seed: number,
): ODPair[] {
  const rand = mulberry32(seed)
  const point = (): LatLng => ({
    lat: bbox.south + rand() * (bbox.north - bbox.south),
    lng: bbox.west + rand() * (bbox.east - bbox.west),
  })
  return Array.from({ length: n }, () => ({ start: point(), end: point() }))
}

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1))
  return sortedAsc[idx]
}

function fmt(v: number | null): string {
  return v == null ? '—' : v.toFixed(1)
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null
}

function statsRow(s: ModeStats, extraPhases: boolean): string {
  const sorted = [...s.latenciesMs].sort((a, b) => a - b)
  const base =
    `| ${s.mode} | ${s.n} | ${s.found} | ${s.noRoute} | ${s.rejected} ` +
    `| ${fmt(percentile(sorted, 50))} | ${fmt(percentile(sorted, 95))} | ${fmt(sorted.at(-1) ?? null)} | ${fmt(mean(sorted))} |`
  if (!extraPhases) return base
  return base + ` ${fmt(mean(s.graphBuildMs))} | ${fmt(mean(s.astarMs))} |`
}

function printTable(title: string, stats: ModeStats[], extraPhases: boolean): void {
  console.log(`\n### ${title}\n`)
  const phaseHead = extraPhases ? ' graph mean | A* mean |' : ''
  const phaseSep = extraPhases ? '---|---|' : ''
  console.log(`| mode | n | found | no-route | rejected | p50 ms | p95 ms | max ms | mean ms |${phaseHead}`)
  console.log(`|---|---|---|---|---|---|---|---|---|${phaseSep}`)
  for (const s of stats) console.log(statsRow(s, extraPhases))
}

async function benchServer(
  url: string,
  pairs: ODPair[],
  modes: string[],
  warmup: number,
): Promise<ModeStats[]> {
  const base = url.replace(/\/+$/, '')
  const post = async (pair: ODPair, mode: string): Promise<Response> =>
    fetch(`${base}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: pair.start, end: pair.end, travelMode: mode }),
    })

  // Warmup requests (JIT, socket setup) — unrecorded.
  for (let i = 0; i < warmup && pairs.length > 0; i++) {
    await post(pairs[i % pairs.length], modes[0]).then((r) => r.arrayBuffer())
  }

  const out: ModeStats[] = []
  for (const mode of modes) {
    const s: ModeStats = { mode, n: pairs.length, found: 0, noRoute: 0, rejected: 0, latenciesMs: [], graphBuildMs: [], astarMs: [] }
    for (const pair of pairs) {
      const t0 = performance.now()
      const res = await post(pair, mode)
      const body: unknown = await res.json()
      const ms = performance.now() - t0
      if (res.status === 200) {
        s.latenciesMs.push(ms)
        if (body === null) s.noRoute++
        else s.found++
      } else {
        s.rejected++
      }
    }
    out.push(s)
    console.error(`[bench] server/${mode}: ${s.found}/${s.n} found, ${s.rejected} rejected`)
  }
  return out
}

async function benchClient(
  tilesDir: string,
  pairs: ODPair[],
  modes: string[],
  warmup: number,
): Promise<ModeStats[]> {
  loadTilesIntoCache(tilesDir)
  const run = (pair: ODPair, mode: string) =>
    clientRoute(pair.start.lat, pair.start.lng, pair.end.lat, pair.end.lng, mode, getDefaultPreferredItems(mode))

  for (let i = 0; i < warmup && pairs.length > 0; i++) {
    await run(pairs[i % pairs.length], modes[0]).catch(() => null)
  }

  const out: ModeStats[] = []
  for (const mode of modes) {
    const s: ModeStats = { mode, n: pairs.length, found: 0, noRoute: 0, rejected: 0, latenciesMs: [], graphBuildMs: [], astarMs: [] }
    for (const pair of pairs) {
      clearRouteTimings()
      const t0 = performance.now()
      let route: Awaited<ReturnType<typeof clientRoute>> = null
      try {
        route = await run(pair, mode)
      } catch {
        s.rejected++
        continue
      }
      s.latenciesMs.push(performance.now() - t0)
      if (route) s.found++
      else s.noRoute++
      // Phase breakdown from the production instrumentation (newest first).
      const timing = getRouteTimings()[0]
      if (timing?.graphBuildMs != null) s.graphBuildMs.push(timing.graphBuildMs)
      if (timing?.astarMs != null) s.astarMs.push(timing.astarMs)
    }
    out.push(s)
    console.error(`[bench] client/${mode}: ${s.found}/${s.n} found`)
  }
  return out
}

function parseBbox(raw: string): { south: number; west: number; north: number; east: number } {
  const parts = raw.split(',').map(Number)
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    throw new Error(`--bbox must be "south,west,north,east", got: ${raw}`)
  }
  const [south, west, north, east] = parts
  if (south >= north || west >= east) throw new Error(`--bbox is empty or inverted: ${raw}`)
  return { south, west, north, east }
}

function loadPairs(file: string): ODPair[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`--pairs must be a JSON array: ${file}`)
  const ok = (p: unknown): p is LatLng =>
    p != null && typeof p === 'object' &&
    typeof (p as LatLng).lat === 'number' && typeof (p as LatLng).lng === 'number'
  return parsed.map((entry, i) => {
    const pair = entry as Partial<ODPair>
    if (!ok(pair.start) || !ok(pair.end)) throw new Error(`--pairs entry ${i} is not {start:{lat,lng}, end:{lat,lng}}`)
    return { start: pair.start, end: pair.end }
  })
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      pairs: { type: 'string' },
      bbox: { type: 'string' },
      n: { type: 'string' },
      seed: { type: 'string' },
      modes: { type: 'string' },
      warmup: { type: 'string' },
      'client-tiles': { type: 'string' },
    },
  })

  if (!values.url || (!values.pairs && !values.bbox)) {
    console.error(
      'Usage: bun scripts/bench-route-latency.ts --url <route-server url> ' +
      '(--pairs <file.json> | --bbox south,west,north,east) [--n 20] [--seed 1] ' +
      '[--modes a,b,c] [--warmup 2] [--client-tiles <dir>]',
    )
    process.exit(1)
  }

  const allModes = Object.keys(MODE_RULES)
  const modes = values.modes ? values.modes.split(',').map((m) => m.trim()).filter(Boolean) : allModes
  for (const m of modes) {
    if (!allModes.includes(m)) {
      console.error(`unknown mode "${m}" — expected one of: ${allModes.join(', ')}`)
      process.exit(1)
    }
  }

  const pairs = values.pairs
    ? loadPairs(values.pairs)
    : randomPairs(parseBbox(values.bbox!), Number(values.n ?? '20'), Number(values.seed ?? '1'))
  const warmup = Number(values.warmup ?? '2')

  // Reachability check up front so a dead server fails loudly, not as 100 rejects.
  const health = await fetch(`${values.url.replace(/\/+$/, '')}/health`).then((r) => r.json()).catch((err: unknown) => {
    console.error(`route server unreachable at ${values.url}: ${err}`)
    process.exit(1)
  })
  console.log(`route server: ${JSON.stringify(health)}`)
  console.log(`pairs: ${pairs.length}${values.pairs ? ` (from ${values.pairs})` : ` (seed ${values.seed ?? '1'} in ${values.bbox})`}, warmup ${warmup}, modes: ${modes.join(', ')}`)

  const serverStats = await benchServer(values.url, pairs, modes, warmup)
  printTable(`Server backend (${values.url})`, serverStats, false)

  if (values['client-tiles']) {
    const clientStats = await benchClient(values['client-tiles'], pairs, modes, warmup)
    printTable(`Client backend (in-process clientRoute over ${values['client-tiles']})`, clientStats, true)
  }

  const totalOk = serverStats.reduce((s, m) => s + m.latenciesMs.length, 0)
  if (totalOk === 0) {
    console.error('\nno successful server responses — check the region / pairs')
    process.exit(1)
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[bench-route-latency] FAILED:', err)
    process.exit(1)
  })
}
