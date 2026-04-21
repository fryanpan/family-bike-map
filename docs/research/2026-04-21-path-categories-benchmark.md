# Path-Categories Overhaul — Benchmark Results

**Date:** 2026-04-21
**Context:** Pre-launch classifier overhaul per `docs/product/plans/2026-04-21-path-categories-plan.md`. Replaces binary preferred/other with 6 LTS-extended levels (1a/1b/2a/2b/3/4); adds Bike boulevard display item; tightens kid-traffic-savvy so plain residentials are no longer preferred.

Full harness output:
- `docs/research/benchmark-runs/2026-04-21-sf-baseline-pre-overhaul.md`
- `docs/research/benchmark-runs/2026-04-21-sf-post-overhaul.md`
- `docs/research/benchmark-runs/2026-04-21-berlin-post-overhaul.md`

## San Francisco (17 destinations, 1 origin = 120 Hancock St)

| Mode | Baseline preferred | Post preferred | Δ preferred | Baseline walk | Post walk | Δ walk |
|---|---:|---:|---:|---:|---:|---:|
| kid-starting-out | 32% | 32% | — | 66% | 66% | — |
| kid-confident | 24% | 50% | **+26pp** | 0% | 47% | +47pp |
| kid-traffic-savvy | 100% | 54% | **−46pp** | 0% | 1% | +1pp |
| carrying-kid | 98% | 96% | −2pp | 0% | 0% | — |
| training | 98% | 98% | — | 0% | 2% | +2pp |

Routes found: 9/17 in both runs (unchanged — see "Known harness issue" below).

### Interpretation

**kid-confident +26pp preferred** — SF Slow Streets (residential + `motor_vehicle=destination`) now correctly classify as `Bike boulevard` (LTS 1b) and show as preferred. Before the overhaul they rendered as plain "Residential/local road" (orange). This is the SF-Slow-Streets-invisible bug fix working as intended.

**kid-traffic-savvy −46pp preferred** — plain residentials (LTS 2b) are no longer in the preferred set. Routes still go through them (accepted at 1.5× cost) but they render orange on the map. This is the "traffic-savvy paints everything green" complaint addressed.

**kid-confident +47pp walk** — Quiet residentials without legal bike priority (our LTS 2b) move from accepted-for-riding to accepted-only-as-bridge-walks. SF lacks the dense 1b infrastructure Berlin has (Fahrradstraßen everywhere), so kid-confident in SF correctly reflects "you'd walk your bike through the non-Slow-Street blocks." This is a deliberate spec decision, not a regression — but if 47% walking is too much for real kid-confident users in SF, we'd tune by (a) promoting some SF residentials into 1b via Layer 2 overlay or (b) accepting LTS 2b with a high cost multiplier for kid-confident too.

**Adult modes barely moved** — carrying-kid and training already accepted the full graph; their route %-preferred changes reflect the tighter display classification (e.g. LTS 3 roads now render as "Other road" instead of "Residential/local road") but routing behavior is the same.

## Berlin (22 destinations, 2 origins Home + School)

Baseline: [`docs/research/2026-04-16-routing-benchmark-results.md`](./2026-04-16-routing-benchmark-results.md) (last known-good numbers).

| Mode | Baseline preferred | Post preferred | Δ preferred | Baseline walk | Post walk | Δ walk |
|---|---:|---:|---:|---:|---:|---:|
| kid-starting-out | 52% | 56% | +4pp | 39% | 41% | +2pp |
| kid-confident | 58% | 66% | **+8pp** | 9% | 30% | +21pp |
| kid-traffic-savvy | 88% | 51% | **−37pp** | 3% | 16% | +13pp |
| carrying-kid | 89% | 80% | −9pp | 6% | 6% | — |
| training | 89% | 93% | +4pp | 6% | 6% | — |

Routes found: 20/22 in both runs. The 2 failing pairs are the SSE Schwimmhalle destinations, outside the Berlin bbox per the 2026-04-16 note.

### Interpretation

**kid-traffic-savvy −37pp preferred** — same pattern as SF: plain residentials (LTS 2b) dropped from the preferred set. Routes still find LTS 2b streets (accepted at 1.5× cost) but they render orange. 51% preferred is the honest number for Berlin kid-traffic-savvy routes.

**kid-confident +8pp preferred** — smaller bump than SF (+26pp) because Berlin doesn't have many `motor_vehicle=destination` residentials (it uses Fahrradstraßen instead, which already classified correctly). The +8pp comes from the Layer 2 Berlin profile's corridor promotions being more consistently applied now that the classifier is unified.

**kid-confident +21pp walk** — matches the SF pattern: quiet residential (LTS 2b) moves to bridge-walk for kid-confident, per Bryan's spec. At 30% walk in Berlin, this is a lot. Open question for post-launch tuning: does kid-confident feel too strict in practice, or is 30% walk an accurate reflection of "kid needs bike-prioritized infra, not just a quiet street"?

**carrying-kid −9pp preferred** — not a regression. Painted lane on 31–50 km/h roads now reclassifies from LTS 2 → LTS 3 (per the "tightening" in §2 of the plan). Carrying-kid still accepts these (at 2× cost) but they no longer count as preferred. The actual routes are similar; the label changed.

**kid-starting-out + training barely move** — both modes' acceptance sets are relatively untouched by the overhaul (starting-out was always 1a only; training picked up the elevated-sidewalk exclusion but it rarely affects Berlin routes).

## Cross-router comparison (clientRouter vs Valhalla vs BRouter)

_Not run for this benchmark._ `--no-external` was used to keep iteration time under 5 min; external runs add ~2s rate-limit pauses × 22 Berlin routes × 5 modes × 2 routers ≈ 44 min. Plan to run overnight and append results.

## Route-cost metric

_Not yet wired into the harness._ Task #104 tracks adding `%-by-level` and cross-router cost logging; deferred to a follow-up benchmark run per Bryan's 2026-04-21 ask.

## Known harness issue (pre-existing, not caused by this change)

Both baseline and post-overhaul SF runs find only 9/17 routes across all modes. The 8 failures are the same pairs in both runs and fail across all 5 modes identically, which means it's a graph-connectivity problem (origin/dest not reachable in the built graph), not a mode-specific routing issue. Same pairs that fail are geographically spread — e.g. Tartine (600 Guerrero) is 0.6 km from Hancock and fails; Lands End at ~5 km fails. Not bbox-clipping either.

Hypothesis: benchmark tile fetch returns 12628 ways for SF but the graph builder may be dropping some edges near origin/dest points. Worth diagnosing in a follow-up, but not a blocker for this PR (fails the same routes before and after — the overhaul doesn't regress anything).

## Changes covered

Implementation commits on `main`:
- `4635698` — `feat(lts): add PathLevel (1a/1b/2a/2b/3/4) to LtsClassification`
- `ff8c603` — `feat(classify): tier display by pathLevel + add Bike boulevard + Other road`
- `31e7db5` — `feat(modes): rewrite mode rules on pathLevel model + cost multipliers`

All 249 tests pass. Bridge-walk connectivity invariant preserved — rejected edges still enter the graph as bridge-walks per `.claude/rules/routing-changes.md`.

## Deferred to follow-ups

- Legend UI rewrite (Simple vs By Path Type toggle, inline per-viewport labels, delete floating legend panel) — task #103
- Benchmark harness extension (%-by-level, cross-router cost logging) — task #104
- Cross-router Berlin benchmark (with `--no-external` removed) — overnight run
- Investigate SF 9/17 harness failure — graph-connectivity diagnostic
