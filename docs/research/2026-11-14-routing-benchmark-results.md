# Routing benchmark — 2026-11-14

Gate run for `feat/joanna-three-routing-changes` (three of the four changes from
PR #245; the arterial demote is deliberately held back — see "What is NOT in this
branch").

**Verdict: PASS.** No routes lost in either city, every mode average flat or up,
no pair regressed to FAIL. Per-pair movement in both directions is listed below
rather than averaged away.

## Method

Both arms measured the same day, as `.claude/rules/routing-changes.md` requires.
Base is a worktree at `471ffc7`, which was `origin/main`'s tip at the time of the
run — not a committed results file.

| | Base arm | Branch arm |
|---|---|---|
| Routing code | `471ffc7` (origin/main) | `ca7779e` |
| Berlin tiles | 36/36, 161,626 ways | same 36 tiles from shared cache, 161,626 ways |
| SF tiles | prod Worker, baked R2 (`x-tile-source: enriched`) | same |

Two methodology notes that matter for reading these numbers:

1. **Berlin was fetched from `overpass-api.de` directly, not through the prod
   Worker.** The Worker's Overpass fallback was failing on every upstream during
   this run (see `docs/process/learnings.md`, Overpass upstream reachability), so
   the usual path could not serve an unbaked region at all. Berlin therefore
   measures RAW Overpass. SF went through prod as usual and measures the
   ENRICHED tile shape real users are served, because California is baked.
2. **Both Berlin arms read byte-identical input.** The first attempt lost 3/36
   tiles to HTTP 429/502 from the rate-limiting mirror. Fetching each arm
   independently from a flaky upstream risks the two arms measuring different
   cities, which would make the delta meaningless, so tiles are now cached to
   disk and shared between arms (`BENCH_TILE_CACHE`). The branch arm made zero
   network requests and reported the same 161,626 ways.

## Berlin (22 pairs)

| Mode | Found | Preferred | Time | Walk | Turns |
|---|---|---|---|---|---|
| kid-starting-out | 22/22 → 22/22 | 56% → 56% | 171 → 171 min | 40% → 40% | 13.0 → 13.1 |
| kid-confident | 22/22 → 22/22 | 64% → 64% | 77 → 78 min | 34% → 34% | 11.3 → 11.0 |
| kid-traffic-savvy | 22/22 → 22/22 | 66% → **67%** | 36 → 37 min | 14% → 14% | 12.1 → 12.7 |
| carrying-kid | 22/22 → 22/22 | 59% → 59% | 37 → 37 min | 20% → 20% | 14.5 → 14.7 |
| training | 22/22 → 22/22 | 50% → **53%** | 21 → 21 min | 7% → 7% | 11.1 → 11.7 |

Level breakdown — only two modes moved:

| Mode | LTS 1a | LTS 1b | LTS 2b | LTS 3 |
|---|---|---|---|---|
| kid-confident | 44% → 45% | 20% → 20% | 14% → 14% | 16% → 16% |
| training | 25% → **27%** | 19% → 20% | 25% → 28% | 25% → **19%** |

The training LTS 3 drop of 6pp is the clearest single result in the run: six
percent of route distance moved off high-stress road.

## SF (17 pairs)

| Mode | Found | Preferred | LTS 3 | Turns |
|---|---|---|---|---|
| kid-starting-out | 17/17 → 17/17 | 29% → 29% | 1% → 1% | 8.5 → 8.5 |
| kid-confident | 17/17 → 17/17 | 43% → 43% | 2% → 2% | 9.6 → 9.6 |
| kid-traffic-savvy | 17/17 → 17/17 | 61% → 61% | 1% → 1% | 8.3 → 8.3 |
| carrying-kid | 17/17 → 17/17 | 53% → 53% | 1% → 1% | 7.3 → 7.3 |
| training | 17/17 → 17/17 | 54% → **55%** | 3% → **2%** | 7.0 → 7.5 |

Only `training` moved in SF. Every other mode is identical to the pp.

## Per-pair movement

Mode averages hide reallocation, so the pairs that moved are named here. All are
Berlin; SF per-pair output is unchanged except in `training`.

Up:

| Pair (mode) | Base → Branch |
|---|---|
| School → Hamburger Bahnhof (training) | 35% → 59% |
| Brandenburger Tor → Berlin Zoo (training) | 67% → 88% |
| SSE Schwimmhalle (training) | 36% → 52% |
| Fischerinsel Swimming (training) | 31% → 44% |
| Garten der Welt (training) | 55% → 67% |
| Garten der Welt (kid-traffic-savvy) | 73% → 80% |
| Stadtbad Neukoelln (training) | 58% → 64% |

Down:

| Pair (mode) | Base → Branch |
|---|---|
| School → Nonne und Zwerg (training) | 50% → 41% |
| School → Ararat Bergmannstr (training) | 50% → 43% |
| Garten der Welt (kid-confident) | 80% → 75% |
| School → SSE Schwimmhalle (training) | 49% → 48% |

The three decreases above 5pp are within a mode whose average rose (`training`
+3pp) or stayed flat (`kid-confident`), so they are reallocation rather than a
net regression — but they are not attributed. **I did not ablate to establish
which cost term moved any individual pair.** The rule mandates ablation for a
reported regression, and the gate shows none at the level it gates on; anyone
picking up a complaint about one of these specific pairs should ablate rather
than trust the attribution guess below.

## Interpretation

`training` moved by far the most in both cities, which is what
`3f913de` ("training prefers bike-infra tiers over the shortest line") is for.
That attribution is consistent with the data but not proven by it — the run did
not isolate cost terms.

The unsignalized-crossing charge (`41afcc8`, plus the two fixes `8843bb7` and
`7633156`) produced **no** change in three of five Berlin modes and none at all
in four of five SF modes. Turn counts rose slightly where it did bite
(kid-traffic-savvy 12.1 → 12.7, training 11.1 → 11.7). This is the expected
shape for a charge whose geometry gate is deliberately biased toward NOT
charging — the fixes in this branch exist precisely because the first cut
charged a Berlin Hauptstraße sidepath the full gap wait at every node it shares
with its carriageway. A small, mostly-zero footprint is the fix working.

## What is NOT in this branch

`3c6f988` ("a separated track beside fast traffic is 2a, not 1a") is held back on
purpose. It makes Berlin kid-starting-out walk 65% of route distance with trip
time rising 171 → 222 min, and that cost needs its own decision rather than
riding along with three unrelated changes.

## Follow-ups

- The arterial demote needs its own gate run and its own decision.
- Berlin cannot currently be measured through the prod Worker at all. While that
  holds, any Berlin gate run measures raw Overpass rather than what users get.
  Baking Berlin (in progress) would remove that gap and make the Berlin arm
  fast, deterministic and independent of a public mirror.
- The four per-pair decreases are unattributed. Ablate before acting on any
  report about those specific routes.
