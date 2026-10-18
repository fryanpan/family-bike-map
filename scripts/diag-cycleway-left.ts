// Diagnostic: how many real ways does classifyEdge mis-tier because it never
// reads `cycleway:left`?
//
// `buildQuery()` fetches ways tagged on ANY side — the key regex is
// ^cycleway(:right|:left|:both)?$ — but classifyEdge reads only
// `cycleway` / `cycleway:right` / `cycleway:both`. A way whose only bike
// facility is tagged on the left is fetched, then classified as if it had no
// bike infrastructure at all. The display classifier derives pathLevel from
// classifyEdge, so the overlay mislabels it too.
//
//   bun scripts/diag-cycleway-left.ts
import { classifyEdge } from '../src/utils/lts'

// Primary Overpass instance per docs/process/learnings.md — overpass-api.de
// load-sheds by query cost and refuses production-sized queries.
const ENDPOINT = 'https://overpass.openstreetmap.fr/api/interpreter'

const CITIES: Record<string, string> = {
  SF: '37.7400,-122.4500,37.8000,-122.3900',
  Berlin: '52.4900,13.3600,52.5400,13.4400',
}

// The values buildQuery() actually fetches.
const FETCHED = new Set(['track', 'lane', 'opposite_track', 'opposite_lane', 'share_busway'])

for (const [city, bbox] of Object.entries(CITIES)) {
  const query = `
[out:json][timeout:180];
way[~"^cycleway(:right|:left|:both)?$"~"^(track|lane|opposite_track|opposite_lane|share_busway)$"](${bbox});
out tags;
`
  const t0 = Date.now()
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'family-bike-map-diagnostic/1.0',
    },
    body: new URLSearchParams({ data: query }).toString(),
  })
  if (!res.ok) {
    console.error(city, 'Overpass failed', res.status, `${Date.now() - t0}ms`)
    continue
  }
  const data = (await res.json()) as { elements: Array<{ tags: Record<string, string> }> }
  const ways = data.elements.filter((e) => e.tags?.highway)

  let leftOnly = 0
  const shifts = new Map<string, number>()
  const examples: Array<Record<string, string>> = []

  for (const { tags } of ways) {
    const left = tags['cycleway:left'] ?? ''
    // Does any side classifyEdge DOES read carry a fetched value?
    const seen =
      FETCHED.has(tags.cycleway ?? '') ||
      FETCHED.has(tags['cycleway:right'] ?? '') ||
      FETCHED.has(tags['cycleway:both'] ?? '')
    if (!FETCHED.has(left) || seen) continue
    leftOnly++

    const before = classifyEdge(tags).pathLevel
    // Simulate the fix: make the left value visible on a key classifyEdge reads.
    const after = classifyEdge({ ...tags, cycleway: left }).pathLevel
    if (before !== after) {
      const k = `${before} -> ${after}`
      shifts.set(k, (shifts.get(k) ?? 0) + 1)
      if (examples.length < 4) examples.push(tags)
    }
  }

  const moved = [...shifts.values()].reduce((a, b) => a + b, 0)
  console.log(`\n=== ${city} (${Date.now() - t0}ms) ===`)
  console.log(`fetched ways with a cycleway facility: ${ways.length}`)
  console.log(`  of those, left-side tag is the ONLY one classifyEdge can see: ${leftOnly}`)
  console.log(`  pathLevel changes once the left side is read:               ${moved}`)
  for (const [k, n] of [...shifts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${k}: ${n}`)
  }
  for (const tags of examples) {
    const rel = Object.entries(tags)
      .filter(([k]) => k === 'highway' || k === 'maxspeed' || k.startsWith('cycleway'))
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    console.log(`     e.g. ${rel}`)
  }
}
