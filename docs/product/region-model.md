# Region model — what is a "city" for a family bike profile?

**Status: deferred for v1.** Documenting the thinking so we can come back to it when cross-boundary routing or sub-municipal variation becomes a real user complaint.

## The insight

Bike infrastructure is a function of **who builds it** — the municipality that passes the budget, sets the speed limit, and paints (or doesn't paint) the lanes. So a routing profile should attach to the governance unit, not to a geographic abstraction like "metro area."

That's clean in theory and messy in practice because governance hierarchies vary by country.

## How governance maps to OSM admin levels

| Country | Relevant unit for bike infra | OSM admin_level | Notes |
|---|---|---|---|
| Germany | Kreisfreie Stadt / Gemeinde | 4 (Berlin as Land), 6 or 8 | Berlin is a city-state; Potsdam is a separate Gemeinde in Brandenburg — genuinely different policies. |
| USA | City | 8 (city), sometimes 6 (county) | SF City = SF County. Counties don't usually build bike infra. Metros span counties. |
| UK | London borough | 8 | Waltham Forest is Copenhagen-tier; Westminster isn't. Borough-level variation is real. |
| Japan | Tokyo 23-ku (special wards) | 7 | Each ku has its own policies and bike plans. |
| Spain | Municipality; Barcelona districts run superilla programs | 8 (city), 9 or 10 (district) | District-level variation matters in Barcelona. |
| Netherlands | Gemeente | 8 | Clean. |
| Canada | City / Arrondissement (Montreal) | 8, 9 | Montreal has borough-level variation (Plateau vs. rest). |

The uncomfortable truth: **there is no single admin level that captures "the right unit" globally.** Any implementation has to handle a per-country mapping, or key off something finer-grained than admin_level.

## Recommended approach (when we build it)

**Key profiles on OSM Wikidata IDs, not names or admin levels.** Berlin = `Q64`, Potsdam = `Q1711`, Waltham Forest = `Q217163`, Tokyo = `Q1490`, San Francisco = `Q62`. Wikidata IDs are language-agnostic, geocoder-agnostic, and survive "Berlin, Germany" vs. "Land Berlin" vs. "Berlin, DEU" mismatches. Every OSM boundary relation has a `wikidata=*` tag; reverse-geocoders can return it.

**Fallback chain on a route request:**

```
reverse_geocode(origin) → ordered list of admin units, finest → coarsest
  e.g. [neighborhood, borough, city, state, country]
for each level, finest to coarsest:
  if a compiled profile exists for its Wikidata ID → use it
fall back to _default (pure global LTS baseline)
```

**When to create a sub-municipal profile** (borough, district, ward): only when research or user feedback flags genuine divergence from the parent. Waltham Forest earns its own (mini-Holland is real). Most Berlin Bezirke don't, because Berlin's policies are city-wide. Default is one profile per municipality; sub-splits are the exception.

**Metros don't get profiles.** A "Berlin metro area" key would average Berlin with 50 small Brandenburg municipalities that have no bike infra — the signal is destroyed. Metros are only a UX affordance ("Did you mean Berlin?" when routing starts in an unknown suburb).

**Onboarding fires at the municipality level** when the fallback chain misses there. Don't onboard at state/country (too coarse) or at neighborhood (too fine for the automated research pipeline to do well).

## V1 simplification (what we're actually building)

**Assumption**: most trips with kids are short — under ~15 km — and stay roughly within one administrative region. Specifically:

- A route to the playground stays in Kreuzberg.
- A route to school stays in Setagaya.
- A route to grandma's house stays in Copenhagen.

This is probably true for >90% of family routes and makes the v1 model much simpler:

- **One profile per route, chosen by the origin**: reverse-geocode origin, pick the finest-matching profile, apply it to all edges of the route. Done.
- **No cross-boundary splitting.** A Berlin → Potsdam route gets scored with Berlin's profile end-to-end. Slightly wrong on the Potsdam half, but the error is bounded and the route is still navigable.
- **Sub-municipal variation ignored.** Waltham Forest gets London's profile in v1. If someone complains, we promote it to its own profile at that point.
- **Filename format**: human-readable keys for v1 (`berlin.md`, `potsdam.md`), migrate to Wikidata IDs when we outgrow this.

## What this simplification costs us

Fix later when it bites:

1. **Berlin ↔ Potsdam commuter routes** score the Potsdam half with Berlin assumptions — misses the Altstadt cobble penalty unless Berlin's profile also has cobble demotion (it does, so this actually works).
2. **Waltham Forest** is scored as if it were generic London — undersells how good mini-Holland is. A family in Walthamstow gets a conservative route.
3. **Tokyo 23-ku variation** — Setagaya and Suginami are probably better for families than Shinjuku or Shibuya, but v1 treats them the same.
4. **Montreal Plateau** vs. outer arrondissements — same issue.
5. **Routes longer than 15 km that cross admin boundaries** — get scored with origin profile. Usually fine; occasionally wrong.

## Triggers to revisit

Come back to this doc and implement sub-municipal profiles + cross-boundary splitting when any of the following happens:

- User reports a Berlin ↔ Potsdam route is mis-scored in a way that matters
- We add a London or Tokyo profile and routes inside those cities feel wrong because they average across boroughs/wards
- We hit the first non-English city where geocoding round-trips break (name stability issue)
- Someone asks us to support a rural-to-city commute that crosses 3+ admin units
- A user requests a neighborhood-level profile ("my neighborhood in Brooklyn is nothing like the rest of NYC")

At that point: migrate filenames to Wikidata IDs, implement the fallback chain, add per-edge admin lookup for cross-boundary routes.

## Open questions we didn't answer

- How to detect destination admin unit cheaply without point-in-polygon per edge (probably: reverse-geocode the destination too, two API calls per route)
- Per-country admin_level mapping — does it live in code, in a per-country config file, or derived from the geocoder response?
- Whether "metro area" should be a UX concept (for "did you mean Berlin?") even if it's not a profile
- How a user-contributed override ("I live in Waltham Forest and routes are bad — make a borough profile") triggers promotion from parent to child profile

These are all solvable. They just aren't v1 problems.

## V1 region-detection pseudocode

```ts
async function pickProfile(origin: LatLng): Promise<CompiledProfile> {
  const place = await reverseGeocode(origin)       // e.g. "Berlin, Germany"
  const key = normalizeKey(place.city, place.country) // "berlin-de"

  const profile = await loadProfile(key)
  if (profile) return profile

  enqueueOnboarding(key, place)                    // background research
  return loadDefaultProfile()                      // pure global LTS baseline
}
```

That's it for v1. Fancier fallback chain and Wikidata-keyed profiles are future work.
