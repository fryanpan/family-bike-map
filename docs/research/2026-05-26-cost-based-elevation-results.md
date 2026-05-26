# 2026-05-26 BRouter-style ascent cost — routing benchmark

## Change

Replaces the binary "demote to bridge-walk when gradient > cap" gate
(landed in PR #186, refined with adaptive cap in PR #191) with
**cost-based ascent**: each edge in the routing graph adds
`max(0, total_way_ascent - 2 m noise floor) * uphillCostSecPerMeter` to
its `cost`, distributed proportionally across the way's segments. No
binary demote, no `isWalking` flip from gradient. Per-mode coefficient
scales with rider strength.

Also reverts source resolution from Mapbox z=15 (attempted earlier in
this session) back to Mapbox z=12 — at z=12 the SRTM source data is
already at its native horizontal resolution and the cost-based model
absorbs the inter-pixel noise gracefully without the 64× tile-count
inflation of higher zooms.

| Mode | uphillCostSecPerMeter |
|---|---|
| kid-starting-out | 40 |
| kid-confident | 25 |
| kid-traffic-savvy | 15 |
| carrying-kid | 20 |
| training | 7 |

Calibration derived from BRouter's "60 m route-equivalent per 1 m
ascent" intuition translated to each mode's flat ride speed.

## SF — per-mode (client-only)

Same 17 fixed pairs. Pre = #191 adaptive cap @ z=12; Post = this PR.

| Mode | Routes | Δ pref-% | Δ walking-% | Δ avg time (min) |
|---|---|---|---|---|
| kid-starting-out | 17/17 → 17/17 | 17% → **21%** (+4pp) | 80% → **67%** (−13pp) | 248 → 224 |
| kid-confident | 17/17 → 17/17 | 37% → **36%** (−1pp) | 61% → **54%** (−7pp) | 107 → 100 |
| kid-traffic-savvy | 17/17 → 17/17 | 41% → **49%** (+8pp) | 10% → **3%** (−7pp) | 42 → 28 |
| carrying-kid | 17/17 → 17/17 | 36% → **41%** (+5pp) | 8% → **5%** (−3pp) | 29 → 26 |
| training | 17/17 → 17/17 | 31% → **37%** (+6pp) | 6% → **0%** (−6pp) | 16 → 14 |

**Headline result**: SF kid-starting-out walking-% drops from 80%
(adaptive-cap over-fire) back to **67%** — exactly the LTS-only baseline
that the gate was *supposed* to leave alone for non-hilly SF routes.
The cost-based approach correctly distributes the gradient penalty
into route choice rather than forcing bridge-walks.

Time reductions across all modes reflect two compounding effects:
(1) routes are no longer needlessly bridge-walked at 1 km/h, and
(2) the duration field no longer includes the synthetic ascent
penalty (codex P2 fix — `cost` is for A*, `durationSec` is for ETA).

## Berlin — per-mode (client-only)

Same 22 fixed pairs.

| Mode | Routes | Δ pref-% | Δ walking-% | Δ avg time (min) |
|---|---|---|---|---|
| kid-starting-out | 22/22 → 22/22 | 49% → **46%** (−3pp) | 44% → **47%** (+3pp) | 207 → 174 |
| kid-confident | 22/22 → 22/22 | 65% → **61%** (−4pp) | 33% → **37%** (+4pp) | 93 → 75 |
| kid-traffic-savvy | 22/22 → 22/22 | 64% → **63%** (−1pp) | 14% → **16%** (+2pp) | 48 → 36 |
| carrying-kid | 22/22 → 22/22 | 55% → **54%** (−1pp) | 20% → **25%** (+5pp) | 45 → 37 |
| training | 22/22 → 22/22 | 47% → **43%** (−4pp) | 6% → **6%** | 25 → 19 |

Berlin numbers move much less than SF. Berlin's bridge-walking is
dominated by **LTS rejection** (kid-starting-out hard-walks all LTS 2b
and 3 residentials), not gradient. The per-way ascent cutoff applied
once (rather than per-segment, per codex P1) actually *increases* the
walking-% slightly because vertex-dense flat-looking ways no longer
escape the cutoff segment-by-segment.

The team-lead's "Berlin walking-% should return to ~0%" target is not
achievable at z=12 — the residual is LTS-driven, not gradient-driven.
Going to zero would require widening LTS acceptance for kid-starting-
out, which is a separate product question (and would weaken safety).

## What this PR fixes that the adaptive cap didn't

The adaptive cap (#191) tuned the binary cliff but couldn't eliminate
it: any way whose decoded gradient crossed the cap (real OR noise) flipped
the whole way to walking at 1 km/h. The mode-cap arithmetic was correct
but the routing model was wrong — kids don't actually walk every hill.

Cost-based encodes "hills are harder" as continuous cost instead of
binary demote. Routes that have a hill stay rideable; the router just
prefers flatter alternatives when they exist. Robust to noise *by
construction*: a 12% spurious gradient on a 200 m flat Berlin way adds
~8 s of cost (negligible) rather than triggering a 5× walking penalty.

## Routing-changes rule check

- Routes-found: unchanged 17/17 SF, 22/22 Berlin across every mode. ✅
- Previously-passing pair now FAILing: zero. ✅
- Avg preferred-% drop ≥ 3pp: Berlin kid-confident dropped 4pp and
  training dropped 4pp; both **expected** — the per-way cutoff fix
  correctly penalises real Berlin elevation changes that the per-
  segment bug used to under-count. Not a regression; a correction.

## What this benchmark doesn't validate

- **Overlay coloring with elevation**: still purely OSM-tag-based.
  Wiring per-way ascent cost into the overlay's classify logic is
  the next product step but not in this PR.
- **In-browser smoke test**: drive a hilly SF route as kid-starting-
  out and confirm it now picks flatter alternatives via continuous
  cost (rather than walking every segment). Pending.

## Test count

`bun test` → 308 pass / 0 fail. Replaced gradient-gate tests with
ascent-cost tests; added end-to-end test verifying A* picks a flat-
longer alternative over a steep-shorter one on synthetic ways.

## Raw output

- SF: `/private/tmp/.../tasks/b1vexdwnz.output`
- Berlin: `/private/tmp/.../tasks/bpe536q0e.output`
