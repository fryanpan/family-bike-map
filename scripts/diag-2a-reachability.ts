// Diagnostic: how much painted-lane infra reaches pathLevel '2a'
// ("Painted bike lane on quiet street" — the blue "Bike route beside cars"
// tier) in SF vs Berlin, and what blocks the rest?
//   bun scripts/diag-2a-reachability.ts
import { classifyEdge } from '../src/utils/lts'

const CITIES: Record<string, string> = {
  // central SF
  SF: '37.7400,-122.4500,37.8000,-122.3900',
  // central Berlin (Kreuzberg / Mitte)
  Berlin: '52.4900,13.3600,52.5400,13.4400',
}

for (const [city, bbox] of Object.entries(CITIES)) {
  const query = `
[out:json][timeout:120];
(
  way["highway"]["cycleway"="lane"](${bbox});
  way["highway"]["cycleway:right"="lane"](${bbox});
  way["highway"]["cycleway:both"="lane"](${bbox});
  way["highway"]["cycleway:left"="lane"](${bbox});
);
out tags;
`
  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'family-bike-map-diagnostic/1.0',
    },
    body: new URLSearchParams({ data: query }).toString(),
  })
  if (!res.ok) {
    console.error(city, 'Overpass failed', res.status)
    continue
  }
  const data = (await res.json()) as { elements: Array<{ tags: Record<string, string> }> }

  let n2a = 0
  let n3 = 0
  let other = 0
  let taggedSpeed = 0
  // Of the ways stranded at '3', how many would reach '2a' if the speed
  // gate were relaxed to 40 km/h (25 mph — the US urban default)?
  let rescuedAt40 = 0
  const byHighway: Record<string, { n: number; level3: number; tagged: number }> = {}

  for (const el of data.elements) {
    const t = el.tags ?? {}
    const cls = classifyEdge(t)
    if (t.maxspeed) taggedSpeed++
    const hw = t.highway ?? '?'
    const b = (byHighway[hw] ??= { n: 0, level3: 0, tagged: 0 })
    b.n++
    if (t.maxspeed) b.tagged++
    if (cls.pathLevel === '2a') n2a++
    else if (cls.pathLevel === '3') {
      n3++
      b.level3++
      if (cls.lts <= 2 && cls.speedKmh != null && cls.speedKmh <= 40) rescuedAt40++
    } else other++
  }

  const total = data.elements.length
  console.log(`\n=== ${city} — ${total} ways tagged with a painted bike lane ===`)
  console.log(`  pathLevel 2a (paints blue):        ${n2a} (${((n2a / total) * 100).toFixed(1)}%)`)
  console.log(`  pathLevel 3  (paints nothing):     ${n3} (${((n3 / total) * 100).toFixed(1)}%)`)
  console.log(`  other:                             ${other}`)
  console.log(`  carry an explicit maxspeed tag:    ${taggedSpeed} (${((taggedSpeed / total) * 100).toFixed(1)}%)`)
  console.log(`  of the '3's, LTS<=2 and <=40 km/h: ${rescuedAt40}  <- would reach 2a at a 40 km/h gate`)
  console.log('  by highway class:')
  console.table(byHighway)
}
