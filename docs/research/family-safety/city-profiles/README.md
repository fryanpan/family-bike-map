# City Profiles — methodology and template

This folder holds per-city profiles that calibrate the Layer 2 overlay of the family-bike-map scoring model. Each city file is the long-form research (with source URLs) backing a short `city_profile.yaml` the router consumes at runtime.

## Files

One markdown file per city — see sibling files in this directory.

## What a city profile captures

Every city file answers the same eight questions:

1. **Per-segment quality** (poor/OK/good/excellent) — how good is a good bike street here?
2. **Network continuity** (spotty/patchy/mostly connected/connected) — can you get places on the low-stress network?
3. **What "protected" means locally** — calibrates the tag allowlist for Layer 2
4. **Beloved family routes** — named corridors to boost
5. **Avoided corridors** — named corridors to demote
6. **City-specific vocabulary** — local terms (Fahrradstraße, superilla, REV, Slow Street, rue aux écoles, fietsstraat, …)
7. **Archetype** (Amsterdam / Copenhagen / Berlin / SF / Bogotá-split / Tokyo-slow / Taipei-trunk / hybrid)
8. **Most surprising finding** — the one thing you'd miss from numbers alone

Plus source URLs for every claim.

## YAML schema

```yaml
city: berlin
country: DE
archetype: berlin            # one of the 7 archetypes in synthesis.md
mode_share: 0.18             # used by SiN multiplier
protected_definition:
  accept:                    # tag patterns treated as LTS-1 protection here
    - cycleway=track
    - bicycle_road=yes
    - highway=living_street
  reject:                    # tag patterns the city's parents don't trust
    - cycleway=lane          # "door zone paint"
vocabulary:
  boost:                     # OSM tag patterns local parents prefer
    - bicycle_road=yes
    - highway=living_street
  demote:                    # OSM tag patterns local parents avoid
    - surface=sett
    - surface=cobblestone
named_overrides:
  boost: ["Mauerweg", "Kastanienallee"]
  avoid: ["Kantstrasse", "Schönhauser Allee"]
network_continuity_index: 0.62   # auto-derived from OSM (see standards.md)
enforcement_reliability: 0.85    # 0–1 multiplier on protected-lane trust
extra_dimensions: []             # ["aqi"], ["winter_plowed"], ["time_of_week"], ...
sources:
  - https://...
  - https://...
```

## Repeatable research prompt

When adding a new city, run this prompt against a general-purpose LLM agent with WebSearch/WebFetch:

> Research how family biking with young kids (ages 3-8) works in **{{CITY}}**. I'm building a family bike route finder and need to fit this city into a pattern.
>
> Context: Global frameworks LTS 1-4 and NACTO "All Ages & Abilities" key off (speed × volume). LTS 1 = children. Existing archetypes: **Amsterdam** (network-complete), **Copenhagen** (curb-separated connected), **Berlin** (infra + gaps + cobbles), **SF** (hero corridors, spotty, plastic posts), **Bogotá split** (Sunday ≠ Monday), **Tokyo slow-everything** (no separation, speed suppression), **Taipei trunk-and-capillary** (car-free backbone via flood wall).
>
> Three dimensions to rate: (1) per-segment quality, (2) network continuity, (3) local protection standard.
>
> Research via WebSearch/WebFetch: official standards, parent voices (Reddit, blogs, news), signature beloved and avoided corridors, mode share, city-specific vocabulary, any time-of-week or environmental factors (AQI, winter, flood, enforcement).
>
> Report in under 900 words with: (1) per-segment quality, (2) network continuity, (3) what "protected" means locally, (4) 2-3 beloved family routes (named), (5) 2-3 avoided corridors (named), (6) city-specific vocabulary, (7) which archetype it resembles and why, (8) most surprising finding. Cite URL sources. Do not fabricate quotes.

## Auto-derived inputs from OSM (zero-human-time step)

Before running the LLM step, compute from OSM extract:

- **Mode share** — from Eurostat / ACS / city open data / Wikipedia
- **`bicycle_road=yes` edge count**
- **`cycleway=track` share** of residential edges
- **`maxspeed` distribution**
- **`surface=sett` / `surface=cobblestone` share**
- **`highway=living_street` share**
- **Network continuity index**: fraction of residential edges in the largest connected component where the component is restricted to LTS-1/2 edges. This single number separates Amsterdam from SF sharply.

These populate the auto fields of `city_profile.yaml`; the LLM step fills in the qualitative fields.

## Review checklist

Before committing a new city profile:

- [ ] Every claim has a source URL in the markdown
- [ ] No fabricated quotes — parent voices are from named blogs/journalism/advocacy orgs
- [ ] Archetype assignment is justified against the seven options in [`../synthesis.md`](../synthesis.md)
- [ ] Mode share cited with year
- [ ] `protected_definition.accept` / `.reject` reflect what *local* parents trust, not what the city calls protected
- [ ] At least 2 named beloved corridors and 2 named avoided corridors
- [ ] Any city-specific dimensions (AQI, winter, floodgates, enforcement) flagged in `extra_dimensions`

Human review takes ~10 minutes per city. The LLM research step is ~15 minutes of compute. A new city costs ~25 minutes of combined effort.
