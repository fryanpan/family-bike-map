// Diagnostic: which ways does the arterial-PBL demote move, and what does the
// threshold choice cost? (Joanna 2026-04-29 research item #3.)
//
// The demote takes a `cycleway:*=track` on a motor road faster than calmed out
// of 1a and puts it at 2a. Three things about it are worth measuring rather
// than reasoning about:
//
//  1. The speed line. The research said "beside fast traffic"; the original
//     implementation hardcoded `maxspeed > 30` and read it with `parseInt`,
//     which cannot read `25 mph`. `classifyEdge` now parses units and calls
//     anything at or below QUIET_STREET_MAX_KMH (40) calmed, so the demote
//     uses that constant. This script reports both lines so the difference is
//     a number and not a guess.
//  2. Standalone `is_sidepath` ways, which the demote deliberately does NOT
//     touch — their own tags cannot say how fast the parent road is. This
//     counts how many 1a ways that leaves alone.
//  3. Which tiers the demoted ways came from, per city.
//
//   bun scripts/diag-arterial-pbl-demote.ts
import { classifyEdge, QUIET_STREET_MAX_KMH, speedDefaultForClass } from '../src/utils/lts'

// Same list, same order, same headers as the Worker proxy — a bare POST with
// no User-Agent gets 403 from openstreetmap.fr.
const ENDPOINTS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]
const HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'FamilyBikeMap/0.1 (github.com/fryanpan/family-bike-map)',
}

async function fetchWays(query: string): Promise<Array<Record<string, string>> | null> {
  for (const endpoint of ENDPOINTS) {
    const t0 = Date.now()
    try {
      const resp = await fetch(endpoint, { method: 'POST', headers: HEADERS, body: query })
      const ms = Date.now() - t0
      if (!resp.ok) {
        console.error(`  ${new URL(endpoint).host}: HTTP ${resp.status} after ${ms}ms`)
        continue
      }
      const json = (await resp.json()) as { elements: Array<{ tags?: Record<string, string> }> }
      console.log(`  served by ${new URL(endpoint).host} in ${(ms / 1000).toFixed(1)}s`)
      return json.elements.filter((e) => e.tags).map((e) => e.tags!)
    } catch (err) {
      console.error(`  ${new URL(endpoint).host}: ${(err as Error).message}`)
    }
  }
  return null
}

const CITIES: Record<string, string> = {
  SF: '37.7400,-122.4500,37.8000,-122.3900',
  Berlin: '52.4900,13.3600,52.5400,13.4400',
}

const ARTERIAL = new Set(['primary', 'secondary', 'tertiary'])
const TRACK_VALUES = new Set(['track', 'opposite_track'])

function hasTrackAnySide(tags: Record<string, string>): boolean {
  return (
    TRACK_VALUES.has(tags.cycleway) ||
    TRACK_VALUES.has(tags['cycleway:right']) ||
    TRACK_VALUES.has(tags['cycleway:left']) ||
    TRACK_VALUES.has(tags['cycleway:both'])
  )
}

for (const [city, bbox] of Object.entries(CITIES)) {
  const query = `
[out:json][timeout:180];
(
  way["highway"="cycleway"](${bbox});
  way["bicycle_road"="yes"](${bbox});
  way["highway"="living_street"](${bbox});
  way["highway"~"^(residential|path|track)$"]["bicycle"!="no"](${bbox});
  way["highway"="footway"]["bicycle"~"^(yes|designated)$"](${bbox});
  way["highway"="pedestrian"]["bicycle"~"^(yes|designated)$"](${bbox});
  way[~"^cycleway(:right|:left|:both)?$"~"^(track|lane|opposite_track|opposite_lane|share_busway)$"](${bbox});
);
out tags;
`
  console.log(`\n=== ${city}`)
  const ways = await fetchWays(query)
  if (!ways) {
    console.error(`${city}: every endpoint failed — no measurement`)
    continue
  }
  console.log(`  ${ways.length} ways fetched`)

  const moves: Record<string, number> = {}
  const speedHist: Record<string, number> = {}
  let demotedInline = 0
  let demotedSidepath = 0
  let over30Only = 0
  let sidepathNoParent = 0

  for (const tags of ways) {
    const hw = tags.highway ?? ''
    const cls = classifyEdge(tags)
    const parentClass = tags['is_sidepath:of'] ?? null
    const isSidepath = tags.is_sidepath === 'yes' || parentClass != null

    if (isSidepath) {
      if (parentClass == null) {
        // No parent class tagged — deliberately left alone.
        if (cls.pathLevel === '1a') sidepathNoParent++
        continue
      }
      const parentSpeed = speedDefaultForClass(parentClass)
      if (parentSpeed != null && parentSpeed > QUIET_STREET_MAX_KMH && cls.pathLevel === '2a') {
        demotedSidepath++
        const k = `1a -> 2a  sidepath of ${parentClass} (${parentSpeed} km/h assumed)`
        moves[k] = (moves[k] ?? 0) + 1
      }
      continue
    }

    if (!hasTrackAnySide(tags) || !ARTERIAL.has(hw)) continue
    const speed = cls.speedKmh
    if (speed == null) continue
    const raw = tags.maxspeed ?? `(class default for ${hw})`

    // No synthetic "before" tags are needed. The demote fires only on a way
    // whose segment tier was already 1a, so a way reading 2a here came from
    // 1a by construction; and a way the demote did not touch still reads its
    // own pre-demote tier.
    if (speed > QUIET_STREET_MAX_KMH) {
      if (cls.pathLevel === '2a') {
        demotedInline++
        const k = `1a -> 2a  inline track on ${hw}`
        moves[k] = (moves[k] ?? 0) + 1
        speedHist[raw] = (speedHist[raw] ?? 0) + 1
      }
    } else if (speed > 30 && cls.pathLevel === '1a') {
      // Would have demoted under the original hardcoded `> 30` line and does
      // not under the calmed ceiling. This is the whole cost of the choice.
      over30Only++
      speedHist[`[> 30 only, NOT demoted] ${raw}`] = (speedHist[`[> 30 only, NOT demoted] ${raw}`] ?? 0) + 1
    }
  }

  console.log(`demoted 1a -> 2a: ${demotedInline + demotedSidepath}  (${demotedInline} inline, ${demotedSidepath} sidepath)`)
  console.log(`inline ways the original "> 30" line would also have demoted: ${over30Only}`)
  console.log(`sidepath ways left at 1a for want of is_sidepath:of: ${sidepathNoParent}`)
  for (const [k, v] of Object.entries(moves).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`)
  console.log('  posted speeds, inline cases:')
  for (const [k, v] of Object.entries(speedHist).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k}: ${v}`)
  }

}
