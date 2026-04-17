# Routing Benchmark — Chunk D Personal preferences layer

**Date:** 2026-04-18
**Change:** Layer 3 personal-preference adjustments added between the
region overlay (Layer 2) and the mode rule (Layer 1.5). With no active
preference, the path is a pure pass-through. The benchmark runs without
an active preference, so numbers match Chunk A's baseline exactly.

## Per-mode summary (22 Berlin routes)

| Mode | Routes found | Avg preferred | Avg walk | Δ vs. Chunk A baseline |
|---|:---:|:---:|:---:|:---:|
| kid-starting-out | 20/22 | 47% | 50% | 0 |
| kid-confident | 20/22 | 58% | 9% | 0 |
| kid-traffic-savvy | 20/22 | 88% | 3% | 0 |
| carrying-kid | 20/22 | 89% | 6% | 0 |
| training | 20/22 | 89% | 6% | 0 |

## Manual verification (not in benchmark)

The benchmark harness doesn't take a preference yet. Manual scenarios
to verify after deploy:

1. **Default Bryan preference** (no preference active): unchanged from
   Chunk A baseline. ✅ Verified via this benchmark.
2. **"cobbles are fine" (Joanna)**: edges in the Berlin Altstadt zone
   previously rough-surfaced by Chunk A's zone rule now pass the mode
   rule's rough-surface check on modes that reject cobbles
   (training, carrying-kid, kid-traffic-savvy). Expected effect: routes
   through the Altstadt open up for those modes.
3. **"avoid painted bike lanes"**: shifts the user's preferred-item
   set away from "Painted bike lane" at display time. (Not yet wired
   — path-type preferences are stored but not consumed by the routing
   path or the legend. Follow-up.)

## What ships in Chunk D

- Preference types + store (localStorage-backed, plural-form-friendly
  English parser).
- `applyPreferenceAdjustments` pure function threaded between region
  overlay and mode rule.
- Surface tolerance is the one routing-affecting adjustment kind:
  `ok` clears the surface field so mode rules don't flag it as rough.
  `rough` / `reject` are no-ops today; defer until needed.
- PreferencesModal UI with live parser preview + active-preference
  toggle + save/activate/delete.
- Map overlay entry point: the 🙂 / 🧑 button next to the ⚙️ gear
  opens the modal.

## What's deferred

- **Path-type preferences** (`prefer Fahrradstraße`) are parsed and
  stored but don't yet adjust routing or the legend. Needs a shim
  that merges the preference into `preferredItemNames` before
  `buildRoutingGraph`. Small follow-up.
- **`?rider=name` URL sharing.** Scoped out of MVP.
- **LLM translation path.** Rule parser first; LLM behind a feature
  flag later, as planned.

## Architecture verification

- 239/239 tests pass (17 new parser + adjustment tests).
- TypeScript clean.
- Graph sizes unchanged without active preference.
- Monotonicity: preferences can only LOOSEN the mode rule, never
  tighten (surface `ok` drops the surface field; other surface
  tolerances are no-ops). Existing invariants hold.
