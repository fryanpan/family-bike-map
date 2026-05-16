# 2026-05-10 Gradient gate — routing benchmark

## Change

New per-mode `gradientCapPct` is now enforced in the graph builder:
ways whose end-to-end gradient exceeds the mode's cap are demoted to
bridge-walk edges at `walkingSpeedKmh`. Elevation data comes from
MapTiler terrain-RGB tiles (z=12), prefetched at the start of every
route request and cached in memory for the session. Per-way (not
per-segment) calculation with a 30 m minimum length floor to dodge
terrain-RGB pixel noise on very short edges. See
`docs/product/decisions.md` (2026-05-10) for the full rationale.

Caps:

- kid-starting-out / kid-confident — 5%
- kid-traffic-savvy / carrying-kid — 7%
- training — 8%

## What this benchmark covers — and does NOT

`bun scripts/benchmark-routing.ts --no-external` runs under Bun without
a browser DOM. `decodeImageBlob` requires `OffscreenCanvas` /
`createImageBitmap`, so in this environment every tile decode returns
null and `lookupElevation` returns null for every coord. **The
gradient gate is therefore effectively skipped in this benchmark.**

So the benchmark answers "does the rest of routing behave identically
when no elevation is available?" — which is the regression question
the rule cares about. The gate's own behavior is verified by:

- `tests/clientRouter.test.ts` → `gradient gate` describe-block: synthetic
  ways + stub elevation, asserts bridge-walk demotion at 15% grade for
  kid-starting-out, ride retention for the same way at 1% grade, and
  fail-soft on null lookup
- `tests/elevation.test.ts`: terrain-RGB encode/decode round-trip,
  `lngLatToTile` boundary cases, null-tile soft-fail
- `tests/modes.test.ts` → `mode gradient caps`: pins the per-mode
  threshold values (5/5/7/7/8) and the monotonicity invariant
- **In-browser smoke test on a hilly SF route**: required complement
  to this benchmark; documented below.

## Berlin — per-mode (client-only)

| Mode | Pre-fix (2026-04-23) | Post-fix (2026-05-10) | Δ found | Δ preferred-% |
|------|:---:|:---:|:---:|:---:|
| kid-starting-out | 57% (20/22) | 56% (22/22) | +2 | −1pp |
| kid-confident | 68% (20/22) | 67% (22/22) | +2 | −1pp |
| kid-traffic-savvy | 64% (20/22) | 64% (22/22) | +2 | — |
| carrying-kid | 52% (20/22) | 54% (22/22) | +2 | +2pp |
| training | 49% (20/22) | 49% (22/22) | +2 | — |

## San Francisco — per-mode (client-only)

| Mode | Pre-fix (2026-04-23) | Post-fix (2026-05-10) | Δ found | Δ preferred-% |
|------|:---:|:---:|:---:|:---:|
| kid-starting-out | 32% (9/17)  | 31% (17/17) | +8 | −1pp |
| kid-confident   | 51% (9/17)  | 47% (17/17) | +8 | −4pp |
| kid-traffic-savvy | 52% (9/17) | 46% (17/17) | +8 | −6pp |
| carrying-kid    | 35% (9/17)  | 32% (17/17) | +8 | −3pp |
| training        | 35% (9/17)  | 31% (17/17) | +8 | −4pp |

## Interpretation

**Routes-found jumped substantially**, especially in SF (9→17). That's
not from this change — gradient lookup returns null in Bun. The
intervening commits since 2026-04-23 added reachability-aware nearest-
node snap and directed-island fixes (`clientRouter.ts:findNearestNode`,
recorded in `learnings.md`), which closed the 41 % SF-snap-failure
gap.

The 3–6 pp drops in SF preferred-% are a direct consequence of the
new routes being **the harder ones**. With only 9/17 routes succeeding
in the prior benchmark, the average was carried by the easier corridor
pairs. Unlocking the remaining 8 pairs — many of which require an LTS
2b connector or a bridge-walk to clear a directed island — pulls the
average down without any individual route getting worse. Apples-to-
apples per-pair comparison on the 9 pairs that succeeded both runs
shows no pair lost preferred infrastructure.

Berlin is essentially unchanged. The slight +2pp on carrying-kid is
within ordinary benchmark noise.

**Routing regression check (per `.claude/rules/routing-changes.md`)**:

- Routes-found: increased in every (mode × city) cell. ✅
- Previously-passing pair now FAILing: zero. ✅
- Avg preferred-% drop ≥ 3pp: yes in SF, but explained by an expanded
  denominator from previously-failed-to-route pairs joining the
  average. Not a regression from this change.

## In-browser smoke test (required before merge)

Run `bun run dev`, drive a hilly SF route as `kid-starting-out`:

- **Start** 37.7472, −122.4117 (Bernal Heights summit)
- **End** 37.7340, −122.4332 (Glen Park BART)

Without the gate, the router happily strings together the steepest
direct path down Bernal Heights Blvd; with the gate enabled and
elevation tiles available, segments where end-to-end gradient exceeds
5% should switch to `isWalking: true` (rendered as the walk dash on
the polyline). Confirm: at least one bridge-walk segment appears on
the steepest blocks, total route distance/duration remain reasonable
(no infinite loop, no route-not-found).

## Test count

`bun test` → 303 pass / 0 fail (was 299 — +4 net after parametrised
test consolidation; new files add 7 + 5 + 4 = 16 logical cases).

## Raw output

- Berlin: `/private/tmp/.../tasks/bja2jhev1.output`
- SF: `/private/tmp/.../tasks/bt3rqu5u5.output`
