# Routing benchmark — 2026-10-18 — Joanna's four 2026-04-29 changes

Gate for the four routing changes from Joanna's 2026-04-29 user-research session,
rebuilt against current `main` rather than merged from the 6-month-old
`joanna-routing-changes` branch. **PASS, with one large intentional regression
that Bryan approved on the board** (review item `r-nBfnS9LbC1FE`, answer
"Ship all").

Routes-found holds at 22/22 (Berlin) and 17/17 (SF) on every mode — the
connectivity invariant the 2026-04-16 refactor broke. Every mode except Berlin's
youngest two moves within ±3pp. Berlin kid-starting-out loses 20pp of preferred
distance and kid-confident 12pp; that is the demote working as designed, and it
is the change the board decision was about.

## Baseline

Both cities were re-measured on `b790d84` (this branch's base, PR #244's tip) on
2026-10-18, in a worktree, within an hour of the "after" runs. Same-day pairing
matters here: the committed `2026-10-18-cycleway-left-benchmark-results.md`
recorded Berlin preferred as 52/66/69/60/46, and the same commit re-measured
today reads 55/69/70/61/47. That 1–3pp spread is live-OSM drift between runs, so
every delta below is computed against the fresh same-commit run, not against the
committed file.

## What changed

Four independent changes, each from a numbered item in Joanna's session.

**#3 — a separated track beside fast traffic is 2a, not 1a** (`src/utils/lts.ts`,
`src/services/overpass.ts`). Joanna's argument: a curb-separated lane beside
50 km/h traffic is not kid-safe. `classifyEdge` now demotes such a way out of 1a,
which puts it below the ceiling for kid-starting-out (`['1a']`) and kid-confident
(`['1a','1b']`), so both bridge-walk it instead of riding it. This is the
contested change.

Three corrections to the 2026-04-29 draft of this change, each measured rather
than assumed:

- **The speed line is the existing `QUIET_STREET_MAX_KMH` (40), not a hardcoded
  30.** The draft predates unit-aware `maxspeed` parsing, so `parseInt('25 mph')`
  gave it 25 and its `> 30` test barely fired in SF. With correct parsing a
  hardcoded 30 catches **380** SF ways instead of 115 — the extra 265 are 20 mph
  and 25 mph streets that this codebase calls calmed everywhere else. Berlin is
  unaffected either way: its streets are posted 30 or 50 and nothing sits
  between, so `> 30` and `> 40` select identically there. Reusing the existing
  constant also avoids a second threshold that can drift from the first.
- **A sidepath's speed comes from its parent road's class, via `is_sidepath:of`.**
  Never from its own `maxspeed` — a cycleway's `maxspeed` limits bikes, not the
  adjacent cars — and **no sidepath way in the Berlin corpus (0/685) carries one
  anyway**. A sidepath with no parent class returns false rather than being
  demoted on suspicion: joining it to its parent needs geometry, not tags, the
  same shape as the Mandela Parkway median in `learnings.md`.
- **The tier and the label come from one exported predicate.** A pre-existing
  test caught this: the demote moved the tier to 2a and the display classifier
  fell through to the default 2a label, "Painted bike lane on quiet street",
  which is wrong twice over for a curb-separated track beside 50 km/h traffic.
  `isSeparatedTrackBesideFastTraffic` is now exported from `lts.ts` and asked by
  both classifiers, so the label cannot disagree with the tier.

**#4 — charge for crossing an unsignalized major road** (`src/data/modes.ts`,
`src/services/edgeAStar.ts`). Waiting for a gap in 50 km/h traffic where OSM maps
no signal or stop node is real time, so it lands on cost and ETA, and it is what
makes the router detour a block to a signalised crossing. Per-mode:
kid-starting-out and kid-confident 50 s, kid-traffic-savvy and carrying-kid 30 s,
training 15 s. Only charged when the rider genuinely crosses — if the major road
is one of the two ways being traversed they are riding *along* it, and riding an
arterial must not cost 50 s a block. Walking edges are exempt, because the
bridge-walk is the designed escape. This change is ~60 lines rather than the
draft's ~160: its data plumbing (signal/stop nodes in `buildQuery`, tileStore v4,
`controlByCoord`) had already landed on `main` independently and in better form,
so only the *missing*-control case was left to add.

**#5a — carrying-kid does not prefer elevated sidewalk paths**
(`src/utils/classify.ts`). Already correct on `main`; this adds the 9-line
comment recording why (a trailer or cargo bike amplifies tree-root heaves and
forces closer pedestrian passes) so a later tidy-up does not move it back.

**#5b — training prefers bike-infra tiers over the shortest line**
(`src/data/modes.ts`). `training.levelMultipliers` was `{}`. Edge cost is
distance/speed, so an empty map made A* take the shortest line regardless of
infrastructure. Now `{'3': 1.5, '2b': 1.2}`.

### Scale of the demote, measured on live Overpass

`scripts/diag-arterial-pbl-demote.ts` runs the production classifier over the
production Overpass corpus. It needs no synthetic "before" tags: the demote fires
only on a way whose segment tier was already 1a, so a way reading 2a came from 1a
by construction, and a way the demote did not touch still reads its own
pre-demote tier.

| | SF (3514 ways) | Berlin (7782 ways) |
|---|---|---|
| demoted 1a → 2a | **115** | **592** |
| …inline track on an arterial | 115 | 155 |
| …sidepath of a fast parent | 0 | 437 |
| extra ways a hardcoded `> 30` would catch | 265 | 0 |
| sidepath ways left at 1a for want of `is_sidepath:of` | 19 | 216 |

Berlin's 437 sidepath demotes break down as 308 sidepaths of a secondary
(50 km/h assumed) and 129 of a primary (60). The 216 left at 1a are the honest
cost of refusing to guess: 469 of Berlin's 685 sidepath ways name their parent's
class, and the rest cannot be joined to a parent without geometry.

## Berlin (22 pairs)

| Mode | Found | Preferred | Walk | Time | Turns |
|------|-------|-----------|------|------|-------|
| kid-starting-out  | 22/22 → 22/22 | 55% → **35%** (−20pp) | 39% → **65%** | 171 → 222 min | 12.3 → 13.6 |
| kid-confident     | 22/22 → 22/22 | 69% → **57%** (−12pp) | 29% → **42%** | 75 → 90 min | 11.0 → 15.1 |
| kid-traffic-savvy | 22/22 → 22/22 | 70% → 68% (−2pp) | 13% → 15% | 37 → 38 min | 12.3 → 13.3 |
| carrying-kid      | 22/22 → 22/22 | 61% → 60% (−1pp) | 20% → 22% | 37 → 38 min | 15.0 → 16.9 |
| training          | 22/22 → 22/22 | 47% → **49%** (+2pp) | 7% → 8% | 21 → 21 min | 11.7 → 13.6 |

## SF (17 pairs)

| Mode | Found | Preferred | Walk | Time | Turns |
|------|-------|-----------|------|------|-------|
| kid-starting-out  | 17/17 → 17/17 | 29% → 28% (−1pp) | 59% → 60% | 210 → 217 min | 8.5 → 11.0 |
| kid-confident     | 17/17 → 17/17 | 43% → 42% (−1pp) | 48% → 50% | 95 → 96 min | 9.6 → 9.5 |
| kid-traffic-savvy | 17/17 → 17/17 | 61% → **62%** (+1pp) | 0% → 1% | 27 → 28 min | 8.3 → 9.3 |
| carrying-kid      | 17/17 → 17/17 | 53% → **55%** (+2pp) | 0% → 1% | 23 → 25 min | 7.3 → 10.6 |
| training          | 17/17 → 17/17 | 54% → **55%** (+1pp) | 0% → 0% | 15 → 15 min | 7.0 → 8.4 |

Turn counts rise in 9 of 10 mode/city figures. That is change #4 doing what it
was built to do: the router detours to a signalised crossing rather than take an
unsignalized one, which costs turns and buys waiting time. Berlin
kid-starting-out's time going 171 → 222 min is walking, not detouring — it walks
65% of the distance at ~1 km/h.

## Joanna's own corridor

`scripts/diag-rudower-training.ts` routes Dresdener Str 112, Kreuzberg →
Rudower Chaussee 12, through the production Worker proxy:

| Mode | Preferred | Protected lane | Painted lane beside traffic |
|---|---|---|---|
| training | 64.3% → **68.3%** | 4.60 → 5.34 km | 1.91 → 1.10 km |
| kid-traffic-savvy | 92.7% → 92.7% | 3.35 → 5.91 km | — |

kid-traffic-savvy's share does not move but its route does: 2.56 km shifts onto
protected lanes, within the same preferred set.

## Three figures from the board decision have moved

The review item Bryan answered quoted the 2026-04-29 benchmark file. Measured
against current `main`, three of its numbers are different. Two moved in his
favour and one against; "Ship all" is still satisfied, but the numbers under the
decision are not the ones he was shown.

| What the item said | Measured now |
|---|---|
| Berlin kid-starting-out −39pp, kid-confident −20pp | **−20pp and −12pp** — about half |
| SF −7pp and −9pp | **−1pp and −1pp** — the 2026-04-29 draft's `parseInt('25 mph')` bug meant its demote barely fired in SF, so that column never described the rule in either direction |
| "roughly 40% of Berlin route distance converts to walk the bike" for kid-starting-out | **65% of distance is walked**, up from 39% — a 26pp conversion. This is the one that moved against him, and it is the cost the decision accepted |
| training on Joanna's Rudower route: 25% → 79.3% preferred | **64.3% → 68.3%.** The 25% baseline was 6-month-old `main`; the corridor has since improved on its own, so the change's own contribution there is +4pp, not +54pp |

## Limits of this run

- `--no-external`, so Valhalla and BRouter were skipped. They are benchmark-only.
- **No overlay verification.** The demote changes `pathLevel` for 592 Berlin and
  115 SF ways and changes the displayed item name for the demoted ones, so
  `.claude/rules/rendering-changes.md` applies and is **not** satisfied: the
  render-check harness is itself under repair in #232 and can report green
  against a map that never rendered, and prod spot-checks on a branch are not
  possible before merge. The honest statement is that the rendering side is
  unverified, not that it is fine. Performance was not measured.
- **No tile re-bake is needed**, unlike PR #244. `isPaintedCandidate`
  (`scripts/pipeline/lib/graph.ts`) gates on `pathLevel === '4'` and a 1a → 2a
  move does not cross that boundary; `isOverviewCandidate`
  (`scripts/pipeline/bake-overview.ts`) reads `carFree || bikePriority ||
  bikeInfra` and the demote leaves `carFree` true; `itemName` is always baked
  `null`. So no baked field changes value.
- Graph node and edge counts fall slightly in Berlin (kid-starting-out 636,550 →
  635,360 nodes) because demoted edges re-enter as bridge-walks rather than
  ridable edges.

## Also run

`bunx tsc --noEmit` clean. `bun test` **833 pass / 0 fail**, including 22 new
cases. Falsification: 9 of them fail on the pre-change `lts.ts` / `overpass.ts` /
`modes.ts`. Only 1 of the 6 new `edgeAStar` cases fails on the pre-change
`edgeAStar.ts` — the other five assert that the crossing penalty does *not* fire
(secondary road, calmed primary, riding along, walking, signal already mapped),
so they pass with or without it by construction. That is the right structure
anyway, since over-firing is what the 2026-04-29 draft got wrong, but it means
one test pins the feature and five pin its exclusions.
