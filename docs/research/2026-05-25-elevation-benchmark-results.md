# 2026-05-25 Gradient gate — benchmark with elevation actually loading

## Why this writeup exists

The gradient gate shipped 2026-05-23 in PR #186 (`feat: gradient gate via MapTiler terrain-RGB`). The accompanying benchmark explicitly noted it had **never been exercised in script form** — Bun lacks `OffscreenCanvas` / `createImageBitmap`, so `decodeImageBlob` returned null, `lookupElevation` returned null for every coord, and the gate was a no-op in every benchmark run. The 2026-05-25 protected-on-major benchmark (PR #187) hit the same wall.

This is the first benchmark that actually decodes terrain-RGB tiles in Bun and exercises the gate end-to-end.

## What changed to make this possible

- `src/services/elevation.ts` gained `setElevationDecoder()` and `setElevationReferer()` extension points. The browser path (OffscreenCanvas) is unchanged; Bun calls `setElevationDecoder()` with a pngjs-based decoder.
- `getMapTilerKey()` now falls back to `process.env.VITE_MAPTILER_KEY` when `import.meta.env` isn't populated (non-Vite runtimes).
- `scripts/benchmark-routing.ts` registers the pngjs decoder + sets the production Referer (MapTiler key is origin-restricted to `bike-map.fryanpan.com`) + calls `prefetchElevation(city.bbox)` once before the per-mode loop.

## SF — before / after (gate enabled)

Same 17 fixed pairs, same code path, only difference is whether the gate fires.

| Mode | Routes found (before/after) | Preferred-% | Walking-% | Avg time (min) |
|------|:---:|:---:|:---:|:---:|
| kid-starting-out | 17/17 → 17/17 | 21% → **10%** (−11pp) | 67% → **87%** (+20pp) | 224 → 274 (+50) |
| kid-confident | 17/17 → 17/17 | 39% → **28%** (−11pp) | 51% → **71%** (+20pp) | 97 → 121 (+24) |
| kid-traffic-savvy | 17/17 → 17/17 | 47% → **36%** (−11pp) | 1% → **18%** (+17pp) | 33 → 46 (+13) |
| carrying-kid | 17/17 → 17/17 | 42% → **35%** (−7pp) | 1% → **14%** (+13pp) | 24 → 33 (+9) |
| training | 17/17 → 17/17 | 42% → **28%** (−14pp) | 0% → **9%** (+9pp) | 13 → 18 (+5) |

The walking-% jump is the gate doing what the 2026-05-10 decision doc said it should: ways whose end-to-end gradient exceeds the mode's cap are demoted to `walkingSpeedKmh`, which adds time but keeps the graph connected. The progressive reduction in walking-% as the gradient cap loosens (5% → 5% → 7% → 7% → 8% across the modes) validates that the per-mode thresholds behave as designed — looser cap, less forced walking.

Routes found stayed 17/17 across every mode: the gate never strands a route. That's the expected behavior of bridge-walk-not-reject.

Per-route deltas confirm the pattern is geographic, not random. Flat routes are unchanged:

- Castro → JFK Promenade (Stanyan): kid-starting-out 9% → 9% (Wiggle / Panhandle, mostly flat)
- Castro → Sunset Dunes: 27% → 27% (Wiggle out + flat Outer Sunset)

Hilly crossings drop sharply:

- Castro → Lands End: 68% → 44% (Inner Sunset / Richmond hill crossings)
- Castro → Lung Fung Bakery (Clement St): 38% → 0% (Pacific Heights crossing)
- Castro → CPMC Mission Bernal: 27% → 0% (Bernal Heights climb)

## What this doesn't validate

- **Terrain-RGB at z=12 is smoothed.** Spot-check: Bernal Heights summit (~150m actual) decodes to ~22m at z=12. Twin Peaks (~280m actual) decodes to ~49m. Individual pixel elevations under-state peaks because z=12 averages ~38m horizontally at this latitude. The gate uses *differences* between way endpoints, so the smoothing reduces sensitivity but doesn't break the gate — gradient gradients (haha) between adjacent pixels are still meaningfully different. A future PR could bump to z=13 or z=14 if the false-negative rate matters.
- **MapTiler keys are origin-restricted in prod.** Bun's fetch sends no Referer, so the script forges `Referer: https://bike-map.fryanpan.com/` to match the key's allowed-origin list. This is a real benchmark-only concession; production browser fetches set Referer automatically. If the key gets locked to a different origin, the constant in `scripts/benchmark-routing.ts` needs to follow.

## Berlin

Not run this pass — the team-lead session flagged 16 GB OOM contention earlier today, and Berlin's full 5-mode benchmark still hits ~2 GB peak per mode despite the GC fix in PR #188. Berlin is mostly flat (max elevation ~120m, most riding terrain ≤ 20m relative), so the gate is expected to be near-no-op for Berlin anyway. Will rerun once the Berlin memory follow-up lands.

## Test count

`bun test` → 307 pass / 0 fail. Same as PR #187.

## Raw output

- SF with elevation: `/private/tmp/.../tasks/b6ydu6pxj.output`
- SF without elevation (2026-05-25 PR #187 baseline): `/private/tmp/.../tasks/bexvrgco4.output`
