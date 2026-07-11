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

## 2026-04-04 — Fix non-Berlin routing (geocoding Berlin hardcoding)

**What worked:**
- Grepping for `countrycodes`, `viewbox`, `bounded`, and `city=Berlin` immediately surfaced all four hardcoded constraints in one file. Targeted grep approach was fast.
- The fix itself was minimal (3 lines removed, 1 type annotation added) — reading the code before acting made the scope clear.
- `bunx tsc --noEmit` works correctly when run *after* `bun install` (dependencies resolved). CI caught the `Record<string, string>` type issue that a local `bun test` wouldn't catch.

**What didn't:**
- Subagent added `biasParams` without a `Record<string, string>` type annotation, causing URLSearchParams constructor type errors in CI. TypeScript infers `{ viewbox: string; bounded: string } | {}` which isn't compatible. Always explicitly type objects that spread into string-keyed maps.
- Pre-existing `bunx tsc` quirk: running without `bun install` first downloads an unrelated npm package named `tsc`. Lesson from BC-249 applied correctly this time.

**Action:** When spreading conditional params into URLSearchParams, always type the variable as `Record<string, string>` explicitly.

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

---

## 2026-06-26 — Turn-cost tuning → ascent-cost fix (Buena Vista + JFK regressions)

### Time Breakdown
| Started | Phase | 👤 Hands-On | 🤖 Agent | Problems |
|---------|-------|------------|----------|----------|
| Jun 26 11:45 | Reproduce both routes + cost-component ablation (disprove turn-cost hypothesis) | ~12m (reading) | ~14m | |
| Jun 26 ~12:02 | Escalate broken assumption → user picks fix direction | ~2m (1 decision) | | |
| Jun 26 ~12:06 | Implement fix (walking-ascent + carFreeBonus), tune, benchmark gate | | ~14m | ⚠ built handoff's turn-cost fix first, reverted |
| Jun 26 ~12:20 | Ship: tests, review, PRs #203/#204, merge, deploy + autonomous loop | ~2m | ~16m | ⚠ Codex review unusable (exit 137) |

### Metrics
| Metric | Duration |
|--------|----------|
| Total wall-clock | ~3.8 h |
| Hands-on (corrected) | ~0.25 h (~7%) |
| Automated agent time | ~0.9 h (~25%) |
| Idle/away (autonomous loop + waiting) | ~2.6 h (~68%) |
| Retro analysis time | ~3 min |

### Key Observations
- The cost-component **ablation** was the highest-value move — it disproved the handoff's turn-cost hypothesis and found the real cause (ascent cost). But it came one step too late: the routes were reproduced (per the rule), then the handoff's prescribed turn-cost fix was *built and reverted* before ablating. Ablate-before-fix would have skipped that cycle.
- Escalation was well-timed: when data contradicted the handoff, stopped and asked the user for the car-free-vs-arterial direction (one batched AskUserQuestion + recommendation) rather than deciding the product stance solo.
- Near-fully autonomous otherwise — one user decision across the whole fix→ship→deploy arc. The `routing-changes.md` benchmark gate did its job (caught no regression because there was none).
- Codex review produced no output (killed, exit 137) twice; the Claude review agent carried the review.

### Feedback
**What worked:** N/A — user approved the action with "sounds good" but did not elaborate on the feedback questions.
**What didn't:** N/A — see above.

### Actions Taken
| Issue | Action Type | Change |
|-------|-------------|--------|
| Rule covers post-fix validation but not diagnosing the cause; led to a build/revert cycle | Update rule | Added "Diagnosing a reported regression" section to `.claude/rules/routing-changes.md` — ablate to isolate the cost term before fixing |
| Reusable lesson (ablation + walking-ascent loophole + carFreeBonus rationale) | Update learnings | Already shipped in PR #204 (`docs/process/learnings.md` "Diagnosing routing regressions") |
| Codex reviewer non-functional in this env | No action | Environment issue (exit 137 / OOM), not a systemic process gap; Claude review covered it |

## 2026-07-02 - Steep-moat filter shipped and reverted same day

**What worked:** Design discussion produced a sound data-layer algorithm (review caught + fixed a real monotonicity bug and a fail-hide bug pre-merge; the diag numbers were correct). Once Bryan reported symptoms, systematic debugging root-caused all three within the hour: local repro → baseline commit comparison → click-the-artifact identification → halo ablation confirmation. Revert shipped and verified on prod the same night.

**What didn't:** All three prod regressions (white-halo stub confetti, leaked deck.gl layers double-plotting, tile-arrival jank) shipped despite tests, benchmark, code review, AND a browser verification pass — because every check verified the feature's intended effect and none asked "what looks new and wrong?" The white pills are visible in the shipped verification screenshots; I attributed them to base-map styling without clicking one. Local dev's inability to load terrain (referer-locked token) meant the gates were never exercised end-to-end before prod.

**Action:** Learnings updated (overlay-rendering section: stub confetti, engine layer leak, hot-path constraint, falsification rule). Re-land blocked on: (1) engine race fix, (2) component-level verdict for sub-noise-floor stubs, (3) off-hot-path moat computation — each verified against its failure mode on prod-like data before merge.

## 2026-07-11 - Enriched-tiles arc: re-land → architecture pivot → build → activation

### Time Breakdown
| Started | Phase | 👤 Hands-On Time | 🤖 Agent Time | Problems |
|---------|-------|-----------------|---------------|----------|
| Jul 2 4:00pm | Re-land steep-moat (#211) + prod verify | █ 10m | ████ 40m | |
| Jul 3 9:10am | Architecture pivot → enriched-tiles plan (#212) + scope expansion | ███ 30m | ███ 30m | |
| Jul 3 2:10pm | 17-agent workflow build: pipeline, route server, DEM, 630 tests, #213/#214 | █ 15m | ██████████ 100m | ⚠ workflow agent died backgrounding a script; ⚠ DEM flip failed benchmark gate, auto-reverted |
| Jul 3 4:45pm | #213 merge + fragment-floor verify; #214 CI fix (osmium) | █ 5m | ███ 25m | ⚠ CI runner lacked osmium |
| Jul 10 11:20pm | Activation: merge #214 → deploy → R2 upload → falsification → route test → docs | ▏2m | ███ 30m | ⚠ mid-zoom sparseness scare (settled by manifest-rollback A/B); ⚠ manual deploy clobbered CI's APP_VERSION |

### Metrics
| Metric | Duration |
|--------|----------|
| Total wall-clock (active periods) | ~4.8 hours across 3 days |
| Hands-on | ~1.0 hour (21%) |
| Automated agent time | ~3.8 hours (79%) |
| Retro analysis time | ~10 min |

### Key Observations
- Activation ran on ~2 minutes of Bryan's time ("Merge it") because #214 decoupled activation from deploy (manifest = switch) and shipped the rollback lever in the same PR — aggressive verification was safe because undo was 60 seconds away.
- The manifest-rollback prod A/B settled a suspected regression (mid-zoom overlay sparseness) empirically in ~5 minutes — the falsification doctrine working as intended.
- The agent captured evidence of time-varying overlay paint (screenshots 10 s apart differing) and misread it as progressive loading — the escaping bug class is time-dependent rendering behavior, invisible to static screenshots.
- Two pre-merge catches showed the gates working: review critical (client couldn't parse the R2 payload) and the DEM benchmark-gate failure (SF carrying-kid −7pp → auto-reverted).

### Feedback
**What worked:** "Felt mostly pretty autonomous."
**What didn't:** "Performance still seems bad — we should have a test for that. And the edges that disappear a few seconds after loading are back. My challenge is the regressions that aren't being caught." → On investigation, both symptoms traced to Bryan's iOS Home-Screen bookmark pinning an earlier app version (fresh web loads show neither). The systemic gap (no rendering gate, no perf budget, no client-version visibility) is real regardless.

### Actions Taken
| Issue | Action Type | Change |
|-------|-------------|--------|
| Rendering changes have no gate (routing does — asymmetry is why routing regressions get caught) | New rule file | `.claude/rules/rendering-changes.md`: t0-vs-t+15s stability check, falsification pass, manual perf check, version-check-before-believing-a-repro, rollback lever; @-included from CLAUDE.md |
| Time-varying paint misread as loading | Doc (learnings) | "Two screenshots that differ over time ARE a finding" + designed fail-soft exception documented |
| Manual deploy clobbered CI's APP_VERSION | Doc (learnings) + fixed | Never `bun run deploy` for mainline; CI deploy rerun restored version stamping same night |
| Stale iOS Home-Screen version indistinguishable from live regression | Ticket | `docs/product/plans/2026-07-11-retro-tickets.md` Ticket 1: in-UI version + stale-detection/update prompt |
| No automated overlay perf budget | Ticket | Same file, Ticket 2: `bench-overlay-paint.ts` CI budget |
| Verification viewports not reproducible (click-replay approximation) | Feature (approved) | Shareable URLs for all map state (pan/zoom, search location, route) — implementation starting |
