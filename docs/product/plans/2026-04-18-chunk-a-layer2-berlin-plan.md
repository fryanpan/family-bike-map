# Chunk A · Layer 2 region overlay — wire Berlin into routing

## Goal

Make the three-layer architecture real for Berlin, not aspirational. The
14 markdown city profiles in `docs/research/family-safety/city-profiles/`
currently describe infrastructure quirks but don't influence routing.
After this chunk, at least Berlin's profile produces measurable routing
adjustments — and the pattern is in place for Joanna/Bryan/me to add
more cities by writing markdown + YAML frontmatter.

## Non-goals (explicit)

- Not wiring all 14 cities — just Berlin. Pattern must generalize.
- Not changing Layer 1 (LTS classifier) or Layer 1.5 (mode rules).
- Not changing the three-layer composition order.

## Current state

- `src/data/cityProfiles/types.ts` — types exist (`CityProfile`,
  `ClassificationAdjustment`, etc.)
- `src/data/cityProfiles/berlin.md` — markdown with YAML frontmatter
- `src/data/cityProfiles/potsdam.md` + 12 others
- **No code runs the adjustments.** `classifyEdge` produces the same
  output in Berlin, SF, or Potsdam.

## Design

### Adjustment types (Berlin has these today in the profile)

Three minimum-viable adjustments the overlay must support:

1. **Demote a named corridor** — "Noe Slow Street has persistent bad-
   driver problems, treat its `bikePriority=true` as if it weren't set."
   Keyed by OSM `name=...` or a bounding polygon.
2. **Promote a named corridor** — "Landwehrkanal towpath is the family
   spine; boost it from LTS 2 → LTS 1 regardless of road class." Keyed
   by OSM `name=...` or by `ref=...`.
3. **Zone-based surface flag** — "Everything inside this polygon is
   assumed to be cobblestone/sett regardless of `surface` tag."
   Mitte's historic cobblestones, Kreuzberg Altstadt, etc.

### Data flow

```
OSM tags
  → classifyEdge (Layer 1 → LtsClassification)
  → applyRegionOverlay (Layer 2, NEW) ← reads CityProfile for active region
  → applyModeRule (Layer 1.5)
  → graph builder (Chunk A's changes end here)
```

`applyRegionOverlay(classification, tags, activeRegion)` returns a
modified `LtsClassification`. Pure function, testable in isolation.

### Region resolution

Already computed: `App.tsx` has `activeRegion` state set via CITY_PRESETS.
`clientRouter.ts` takes a `regionRules` prop today (already plumbed).
Piggyback on the same prop; extend it to pass the full `CityProfile`
instead of just `ClassificationRule[]`.

### Berlin-specific rules (minimum 3 to ship)

From `berlin.md` frontmatter + prose:

1. **Promote Landwehrkanal + Mauerweg towpaths** (family-cycling spine).
   OSM `name=Landwehrkanal` + `name=Berliner Mauerweg` + `route=bicycle
   ref=D11`. Boost to LTS 1 + `carFree=true` even where OSM tags are
   ambiguous.
2. **Demote Oranienstraße on kid modes** — painted bike lane adjacent
   to heavy bus traffic, bad driver behavior. Keep as LTS 2 for
   routing but exclude from kid-confident's acceptance until
   specifically added.
3. **Assume cobblestone in Altstadt polygon** — bounded by Spree +
   Schloßplatz + Hackescher Markt. `surface` tags are unreliable there;
   blanket-mark as `cobblestone`.

### Admin visualization

One small addition to `?admin=rules`: a new "Region adjustments" tab
showing which rules are active for the current city, which corridors
they target, and (later) how many edges they actually touched in the
last graph build.

## Work items

1. **Parse city profile markdown → typed object.** Add
   `src/data/cityProfiles/load.ts` that reads a `.md` file, extracts
   YAML frontmatter, returns a typed `CityProfile`. Import Berlin at
   module load.
2. **Write `applyRegionOverlay` in `src/data/cityProfiles/overlay.ts`.**
   Pure function that takes `LtsClassification + tags + profile` and
   returns an adjusted `LtsClassification`. Implements the three rule
   types above.
3. **Wire into `clientRouter.ts`.** In `buildRoutingGraph`, between
   `classifyEdge` and `applyModeRule`, insert
   `applyRegionOverlay(classification, tags, activeProfile)`.
4. **Berlin rules.** Encode the 3 adjustments above. Each one must be
   traceable back to a specific line in `berlin.md` via a comment
   citing the source.
5. **Unit tests.** One per rule type: Landwehrkanal promotion,
   Oranienstraße demotion, Altstadt cobblestone. Plus: no-overlay
   behavior identical when region is unknown.
6. **Benchmark.** Run `bun scripts/benchmark-routing.ts` and compare.
   Expect: modest routing changes on routes through the affected
   corridors; no change elsewhere. Save new benchmark doc.
7. **Admin tab (optional, ≤30 min).** Show active region adjustments
   in `?admin=rules`.

## Risks

- **Bounding polygons for zone adjustments** need real lat/lng
  boundaries. Can use an approximation (centerpoint + radius) for
  the Altstadt zone initially; upgrade to a real polygon later.
- **Benchmark regression.** Promoting Landwehrkanal changes how
  Home→Alexanderplatz routes; this is INTENDED, but need to verify
  the route makes sense (family spine, not a detour).

## Exit criteria

- [ ] Berlin is a `CityProfile` object at runtime, loaded from markdown
- [ ] `applyRegionOverlay` is called per edge during graph build
- [ ] At least 3 Berlin rules active with unit tests
- [ ] Benchmark re-run shows expected shape changes on affected routes
- [ ] Docs: `docs/research/2026-04-18-layer-2-berlin-benchmark.md`
