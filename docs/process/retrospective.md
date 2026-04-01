# Retrospective Log

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
