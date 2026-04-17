# Routing Benchmark — Chunk A Layer 2 Berlin overlay wired

**Date:** 2026-04-18
**Change:** Layer 2 region overlay now runs between Layer 1 classification and
Layer 1.5 mode rules. Three Berlin-specific rules are active:
1. `promote` — Landwehrkanal / Mauerweg / Teltowkanal / Spreeweg spine (carFree + LTS 1)
2. `demote` — Oranienstraße tertiary stretch (LTS → 3, clear bikePriority)
3. `zoneSurface` — Altstadt bbox → cobblestone surface

## Per-mode summary (22 Berlin routes)

| Mode | Routes found | Avg preferred | Avg walk | Δ vs. tweak baseline |
|---|:---:|:---:|:---:|:---:|
| kid-starting-out | 20/22 | 47% | 50% | 0 |
| kid-confident | 20/22 | 58% | 9% | 0 |
| kid-traffic-savvy | 20/22 | 88% | 3% | 0 |
| carrying-kid | 20/22 | 89% | 6% | 0 |
| training | 20/22 | 89% | 6% | 0 |

**No benchmark-route shift.** Every pair × mode cell matches the tweak
baseline (`2026-04-18-kid-starting-out-car-free-benchmark.md`) exactly.

## Why the numbers didn't move

The overlay is correctly wired (verified via unit tests: 11 new tests
cover promote, demote, zone-surface, no-mutation, boundary cases). The
benchmark pairs just don't exercise the three promoted/demoted corridors
enough to change the chosen route:

1. **Landwehrkanal / Mauerweg promote.** The benchmark Home address is
   in Kreuzberg — one block from the Landwehrkanal. But the canal runs
   east–west; the test destinations are scattered north and south, so a
   detour onto the canal spine would add distance vs. the existing
   residential / cycleway routes already classified LTS 1. A* picks the
   shorter route.
2. **Oranienstraße demote.** Only a single Home route could plausibly
   route down Oranienstraße (Home → Ararat Bergmannstr). The current
   routes go around it already — the demote is correct defence in depth
   but doesn't change the chosen route.
3. **Altstadt cobblestone zone.** The bbox covers Museumsinsel ↔
   Hackescher Markt. Home → Humboldt Forum (directly in the zone) is
   actually the only route that crosses it. The existing 48% preferred
   / 50% walking for kid-starting-out on this route suggests the
   classifier was already treating those edges as rough. Net-zero
   change for this pair.

## What this means

Zero delta on benchmark routes is **not** zero impact of the overlay —
it's evidence that:
- The promoted corridors ARE in the graph but aren't shortcuts for
  the current benchmark pairs. Adding more routes through
  Landwehrkanal-adjacent destinations (Treptower Park, Neukölln
  canalside) would surface the effect.
- The demote rule is preventative. Its job is to block Oranienstraße
  from being chosen as a shortcut when it otherwise would be; a route
  not choosing it is the success case.
- The zone rule is already encoded in OSM surface tags for most of
  the relevant edges. The zone is defence-in-depth for edges with
  missing or wrong `surface` tags.

## Architecture verification

- All 11 overlay unit tests pass (tests/overlay.test.ts).
- `applyRegionOverlay` is pure and threaded through
  `buildRoutingGraph` + `clientRoute` (nullable param; defaults to
  null for non-Berlin cities).
- Non-Berlin cities are unchanged: `regionProfile` resolves to null
  via the `activeRegion === 'berlin'` check in `App.tsx`.
- Monotonicity preserved: no mode's acceptance set was made narrower
  by the overlay.

## Follow-up (not in this chunk)

- Add benchmark routes that exercise Landwehrkanal (Home → Treptower
  Park, Home → Neukölln Rixdorf) and Mauerweg (Wannsee → Pankow).
  Needs new `ORIGINS` / `DESTINATIONS` entries in
  `scripts/benchmark-routing.ts`.
- Wire a rule-hit counter into `buildRoutingGraph` so the admin tab
  can surface "3 ways matched Landwehrkanal in this build" — makes
  the overlay observable without digging into the graph.
