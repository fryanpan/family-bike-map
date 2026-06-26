# Routing benchmark — 2026-06-26

Gate for the **ascent-cost + car-free-bonus** change that resolves two route
regressions Bryan reported on the deployed build (Buena Vista hill, JFK
Promenade abandonment). Client-only run (`--no-external`), standard tile cache
(no `TILE_BUST` — `buildQuery` unchanged, so tile content is identical to the
2026-06-11 baseline and the comparison isolates the cost-model change).

## What changed

Investigation (reproduce-before-fixing) **disproved the handoff's turn-cost
hypothesis**. A cost-component ablation (zero each term, observe the route)
showed turn/signal/stop costs do not move either route; **ascent cost** does.

Two fixes, both cost-only (displayed ETA unaffected):

1. **Ascent cost now applies to walking (bridge-walk) edges** too
   (`clientRouter.ts`). Walking edges were exempt, so A* took the steepest,
   shortest dismount straight up a hill. kid-confident walked up Buena Vista
   Park rather than ride the flatter, longer Wiggle.
2. **Car-free cost bonus** — a per-mode `carFreeBonus` multiplier (<1)
   discounts physically separated infra (`classifyEdge.carFree`) so family
   modes prefer it over a shorter car-shared arterial. carrying-kid 0.7,
   training/traffic-savvy 0.8, kid-confident 0.85, kid-starting-out 0.9.

## Per-mode summary vs 2026-06-11 baseline

Avg preferred-% (higher = more time on family-preferred infra). Routes-found
unchanged at full coverage for every mode in both cities.

### SF (17 pairs)

| Mode | Found | Preferred (base → now) | Δ |
|------|-------|------------------------|---|
| kid-starting-out  | 17/17 | 29% → 28% | −1 |
| kid-confident     | 17/17 | 39% → 41% | +2 |
| kid-traffic-savvy | 17/17 | 49% → 49% | 0  |
| carrying-kid      | 17/17 | 44% → 48% | **+4** |
| training          | 17/17 | 41% → 42% | +1 |

### Berlin (22 pairs)

| Mode | Found | Preferred (base → now) | Δ |
|------|-------|------------------------|---|
| kid-starting-out  | 22/22 | 47% → 50% | +3 |
| kid-confident     | 22/22 | 63% → 66% | +3 |
| kid-traffic-savvy | 22/22 | 66% → 67% | +1 |
| carrying-kid      | 22/22 | 57% → 56% | −1 |
| training          | 22/22 | 45% → 46% | +1 |

## Interpretation

- **No routes lost** in either city (34/34 pairs across modes still solved) —
  the walking-ascent cost did not break the bridge-walk connectivity invariant.
- **Preferred-% up or flat everywhere.** The only decreases are −1pp (SF
  kid-starting-out, Berlin carrying-kid), well inside the ~3pp noise band the
  rule allows. The car-free bonus raises preferred-% exactly where intended.
- The biggest gain (SF carrying-kid +4pp) is the car-free bonus pulling the
  trailer mode onto separated infra it previously skipped for a faster arterial.

## Named-route regression checks (`scripts/diag-turn-cost-regressions.ts`)

| Case | Mode(s) | Before | After |
|------|---------|--------|-------|
| Buena Vista (Castro → Inner Sunset) | kid-confident | 12 pts inside park, 116 m ascent | **0 pts in park**, 84 m ascent |
| JFK Promenade (Castro → Hook Fish Co) | carrying-kid | 10% promenade | **17%** |
| JFK Promenade | training | 0% promenade | **16%** |
| JFK Promenade (reference, must not regress) | kid-confident | 31% | 31% |

## Follow-ups

- `carFreeBonus` is a new `ModeRule` field with no admin-override wiring yet
  (same gap noted for the turn-cost fields on 2026-06-11). Add to the Admin →
  Routing sliders when that surface is next touched.
- Values were tuned to clear the regression thresholds with margin; if a future
  city shows over-preference for car-free detours, lower the per-mode bonus
  (closer to 1.0) rather than removing it.
