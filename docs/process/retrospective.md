# Retrospective Log

## 2026-04-04 — iOS rendering performance fix (training/trailer mode stall)

**What worked:**
- Root cause was quickly identifiable by reading `BikeMapOverlay.tsx`: individual React `<Polyline>` + `<Tooltip>` per OSM way, no memoization, SVG renderer.
- Replacing the React component loop with an imperative `L.LayerGroup` + `L.canvas()` renderer is the canonical fix for this class of problem. Canvas is 5-10x faster than SVG for many lines on mobile, and Leaflet's built-in canvas hit-testing means tooltips still work.
- `useMemo` for `allWays` is a minimal, low-risk addition that prevents unnecessary redraws.
- Adding `escapeHtml()` to the imperative tooltip builder matches the XSS protection React JSX previously provided automatically — easy to miss when moving from JSX to string templates.

**What didn't:**
- N/A — the fix was straightforward once the root cause was clear.

**Action:** When many map elements need rendering (>50 polylines), default to imperative Leaflet layer groups with canvas renderer rather than React component loops. React's reconciliation is not designed for hundreds of map primitives — it adds overhead with no benefit for non-reactive SVG/canvas elements.

---

## 2026-04-03 — BC-258: SafetyClass removal (and why it took 4 prompts)

**What worked:** Once the decision was made to eliminate SafetyClass entirely, the migration was systematic and complete. `classifyEdgeToItem()`, `getCostingFromPreferences()`, binary `RouteQuality`, and preference-driven re-routing are cleaner than the 3-level system.

**What didn't:** It took 4–5 explicit user prompts across this session to reach the conclusion that SafetyClass should be removed:

1. "Review classification architecture and /simplify" → I improved structure but kept safety classes
2. "Remove legacy safety levels (great/good/ok/avoid)" → I collapsed 4→3 levels but kept the abstraction
3. "Why do we even have safety class values? That seems no longer necessary?" → I initially reasoned *for* keeping them
4. "Please remove safety classes from the architecture" → finally acted
5. Context ran out mid-migration, requiring a second session to finish

And from prior sessions (BC-242), I had already *celebrated* consolidating 6→4 levels as the win — I didn't ask whether the abstraction belonged at all.

**Root causes:**

1. **I interpret "simplify" as "reduce visible complexity", not "question whether this abstraction exists for the right reason."** When the 4-level system was simplified to 3 levels, that felt like simplification. I didn't ask: "is there a single downstream use of SafetyClass that couldn't be served by item names directly?"

2. **I don't challenge abstractions unless explicitly asked to.** The user had to say "why do we even have safety class values?" before I considered removing them. That question should have been mine to ask — after we reduced to 3 levels that mapped one-to-one with preferred/other, the class was pure indirection.

3. **When context overflows mid-migration, I don't flag the incompleteness explicitly.** The previous session ended with 6+ files still using old APIs. The summary noted this as "pending tasks" but there was no forcing function to ensure it got done in the next session.

4. **Even within this session: I missed `Legend.tsx` had stale `s.safetyClass` references** until I read the file. I should scan for all usages of the type being eliminated before declaring the migration "in progress."

**Actions:**

- When asked to simplify, explicitly ask: "Is there a downstream consumer of this abstraction that couldn't be served by a simpler primitive?" before doing the minimum.
- When an abstraction maps one-to-one with something simpler (SafetyClass → item name preferred/not), flag the redundancy immediately rather than treating the mapping as necessary complexity.
- Before starting a migration that touches many files, list all files that reference the thing being removed (grep), and treat that list as the definition of done.
- When context runs out mid-migration, note the specific files still needing update in the retrospective so the next session starts there.

---

## 2026-04-02 — BC-249 Tile-based map caching

**What worked:** Splitting viewport fetch into tile-based parallel requests with per-tile caching was straightforward. The key insight: use refs (`loadedTilesRef`, `loadingTilesRef`, `generationRef`) so the `loadVisibleTiles` callback has no stale-closure dependency on component state — only on stable values (`enabled`, `profileKey`, `map`, `onStatusChange`).

**What didn't:** `bunx tsc --noEmit` with bunx downloads a different npm package named `tsc`. Use `bun test` + the project's local vite build instead. Pre-existing TypeScript errors (missing `@types/react` in standalone tsc) are unrelated.

**Action:** When checking types in Vite+Bun projects, trust `bun test` + `bun run build` (not standalone tsc via bunx).

---

## 2026-03-31 — BC-222 Initial Prototype

**What worked:**
- Valhalla `trace_attributes` for segment colouring is the right call — gives rich per-edge data without needing a custom routing graph; falls back gracefully to solid blue if the call fails
- Splitting the Cloudflare Worker into proxy + feedback in one worker keeps secrets co-located and avoids a second deploy target
- Mobile-first CSS with CSS transforms for the bottom sheet panel is clean and avoids any JS animation library dependency
- Precision-6 polyline decoder was a genuine gotcha worth a unit test — the encode/decode roundtrip is easy to verify but the constant (1e6 vs 1e5) is silent and wrong without a test

**What didn't:**
- No deployed test environment at PR time — secrets need to be set up out-of-band before CI deploy runs; should have flagged this earlier rather than at review
- Context window overflowed mid-session; required continuing from a conversation summary which is lossy

**Action:** Document the deploy bootstrap sequence (worker first → get URL → set VITE_WORKER_URL → merge PR) in the plan so it's clear to anyone picking this up cold.

---

## 2026-04-01 — TypeScript migration + scoring model fix (feedback)

**What worked:**
- Bun drop-in replacement for npm/vitest is clean: `bun test` discovers `.test.ts` files natively, `bun install` respects the existing deps. Required adding `@types/bun` and a `src/vite-env.d.ts` Vite reference but otherwise zero friction.
- `oven-sh/setup-bun@v2` replaces `actions/setup-node` in CI/deploy workflows with no other changes.
- TypeScript tsc + `bun test` together provide a solid gate: tsc caught the missing Vite env type and the PNG import declarations immediately.

**What didn't:**
- The original classify.js used `edge.bicycle_network >= 1` to identify Fahrradstrasse. That field tracks cycling route memberships (NCN/RCN/LCN), NOT `bicycle_road=yes`. Most Berlin Fahrradstrassen have no route membership, so the check silently classified them as 'acceptable' residential streets. The correct field is `edge.bicycle_road` (a separate boolean exposed in trace_attributes).
- The profiles were implemented without carefully matching the product spec's priority rules — specifically, the toddler profile spec says painted road bike lanes are "no better than a road without a bike path", which requires profile-aware classification (classifyEdge now takes a profileKey).

**Action:** When implementing safety-score-based features, always trace each product spec rule explicitly to code with a comment referencing the spec. Don't assume Valhalla's field names match intuitive meanings (bicycle_network vs bicycle_road is non-obvious).

---

## 2026-04-01 — BC-242: Path rating consolidation + 4-level classification

**What worked:**
- Posting a full classification table to Slack before touching code caught real inconsistencies (footway great vs good, share_busway training inconsistency between Valhalla and OSM). Worth the extra turn every time.
- Reducing SafetyClass from 6→4 levels (great/good/ok/avoid) removed a lot of cognitive overhead — `acceptable` and `caution` were never clearly distinguished from `ok` and `avoid` in practice.
- Exporting `BAD_SURFACES` from classify.ts and importing in overpass.ts is a clean consolidation pattern for shared constants; better than copy-paste with a comment.
- The PROFILE_LEGEND-derived path preferences panel in ProfileEditor is a zero-cost way to make the settings UX meaningful — shows exactly what the profile prefers without adding new state or bidirectional param mapping.

**What didn't:**
- The integration test `quality.bad < 0.5` for toddler was fragile — it was testing the old classification. When residential roads changed from `ok` to `avoid` for toddler (by design), the test broke. Route quality thresholds in integration tests need to account for classification model changes.
- Valhalla and OSM overlay had subtly different classifications for the same path types (e.g., share_busway: Valhalla=good/trailer vs OSM=ok/trailer). These divergences are intentional (routing preference vs display) but should be documented explicitly.

**Action:** When changing path classification rules, update integration test quality thresholds to match the new model. Consider adding a comment explaining why the threshold is set where it is.
