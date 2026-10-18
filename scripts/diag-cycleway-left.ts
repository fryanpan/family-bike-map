// Diagnostic: how many real ways change tier once every cycleway side is read?
//
// `buildQuery()` fetches ways tagged on ANY side — the key regex is
// ^cycleway(:right|:left|:both)?$ — but `classifyEdge` used to read the sides
// through a `??` chain over `cycleway` / `cycleway:right` / `cycleway:both`,
// which never looked at `cycleway:left` at all and, worse, stopped at any key
// that was merely PRESENT. `cycleway:right=no` is present and very commonly
// tagged, so it masked a real facility on another side. A way whose facility
// the chain could not see was fetched and then scored as having no bike
// infrastructure at all. The display classifier derives pathLevel from
// classifyEdge, so the overlay mislabelled it too.
//
// `oldSideValue` below reconstructs that chain locally rather than calling a
// past version of classifyEdge, so this script measures the same delta whether
// it is run before or after the fix — it stays usable as a regression probe,
// and reports the same numbers on either commit.
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

/** The single value the pre-fix `??` chain selected, or '' if it selected none. */
function oldSideValue(tags: Record<string, string>): string {
  return tags.cycleway ?? tags['cycleway:right'] ?? tags['cycleway:both'] ?? ''
}

/**
 * The tags the pre-fix classifyEdge effectively saw: its only use of cycleway
 * tags was the one value `oldSideValue` picks, so collapsing all four keys to
 * that value reproduces the old classification exactly.
 */
function asOldTags(tags: Record<string, string>): Record<string, string> {
  const out = { ...tags }
  delete out['cycleway:left']
  delete out['cycleway:right']
  delete out['cycleway:both']
  const sel = oldSideValue(tags)
  if (sel) out.cycleway = sel
  else delete out.cycleway
  return out
}

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

  let hidden = 0
  const shifts = new Map<string, number>()
  const examples: Array<Record<string, string>> = []

  for (const { tags } of ways) {
    // Did the old chain see a facility at all, when one is tagged somewhere?
    const anyFetched = (['cycleway', 'cycleway:right', 'cycleway:left', 'cycleway:both'] as const)
      .some((k) => FETCHED.has(tags[k] ?? ''))
    if (anyFetched && !FETCHED.has(oldSideValue(tags))) hidden++

    const before = classifyEdge(asOldTags(tags)).pathLevel
    const after = classifyEdge(tags).pathLevel
    if (before !== after) {
      const k = `${before} -> ${after}`
      shifts.set(k, (shifts.get(k) ?? 0) + 1)
      if (examples.length < 4) examples.push(tags)
    }
  }

  const moved = [...shifts.values()].reduce((a, b) => a + b, 0)
  console.log(`\n=== ${city} (${Date.now() - t0}ms) ===`)
  console.log(`fetched ways with a cycleway facility: ${ways.length}`)
  console.log(`  facility hidden from the old ?? chain:        ${hidden}`)
  console.log(`  pathLevel changes once every side is read:    ${moved}`)
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
