# Family Biking Safety Research

Research backing the family-bike-map scoring model. Assembled April 2026 via a team of research agents.

## Purpose

Three-layer scoring architecture:

1. **Global baseline** — research-backed LTS-style edge scoring that works on any OSM city
2. **Per-city profile** — small overlay calibrating local "protected" definitions, mode share, vocabulary, archetype
3. **Family preferences** (future) — runtime sliders on top of layers 1 + 2

These files document the evidence behind each layer and provide a repeatable recipe for adding new cities.

## Files

| File | Purpose |
|---|---|
| [`standards.md`](./standards.md) | Academic + government frameworks (LTS, NACTO AAA, CROW, ERA, LTN 1/20, Vejdirektoratet). The Layer 1 defense. |
| [`safety-in-numbers.md`](./safety-in-numbers.md) | Jacobsen / Elvik literature on the safety-in-numbers effect and the derived mode-share multiplier. |
| [`city-profiles/README.md`](./city-profiles/README.md) | Methodology and YAML template for per-city profiles. The repeatable recipe. |
| [`city-profiles/<city>.md`](./city-profiles/) | One file per researched city with sources, parent voices, derived profile. |
| [`synthesis.md`](./synthesis.md) | Cross-city synthesis: archetype table, routing-model requirements uncovered, recommendations. |

## Cities researched (as of 2026-04)

Amsterdam · Barcelona · Berlin · Bogotá · Copenhagen · London · Mexico City · Montreal · New York City · Paris · Potsdam · San Francisco · Seville · Taipei · Tokyo

## Methodology note

All city research was performed by parallel LLM research agents using WebSearch/WebFetch against public sources (academic papers, government planning documents, local journalism, advocacy-group publications, parent blogs). Every claim in a city profile links to its source. Reddit threads were not directly fetchable due to API restrictions — parent voices come from blogs and journalism that quote Reddit or primary-source parent interviews. No quotes are fabricated.
