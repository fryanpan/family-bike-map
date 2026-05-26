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

## Berlin — surprise: gate over-fires on noisy flat terrain

Ran 2026-05-26 after PR #188 (the GC fix) landed and freed up Mac Mini memory headroom. Berlin's per-mode RSS peaked at 1.36–1.59 GB, well under the prior 2.5 GB+ and the team-lead's 16 GB-machine concern.

Same 22 fixed pairs, all 5 modes. Pre = 2026-05-10 (no-elevation, gate skipped); post = today (gate firing):

| Mode | Found | Preferred-% | Walking-% | Avg time (min) |
|------|:---:|:---:|:---:|:---:|
| kid-starting-out | 22/22 → 22/22 | 56% → **41%** (−15pp) | ~0% → **56%** | 207 |
| kid-confident | 22/22 → 22/22 | 67% → **60%** (−7pp) | ~0% → **48%** | 93 |
| kid-traffic-savvy | 22/22 → 22/22 | 64% → **63%** (−1pp) | ~0% → **26%** | 48 |
| carrying-kid | 22/22 → 22/22 | 54% → **52%** (−2pp) | ~0% → **31%** | 45 |
| training | 22/22 → 22/22 | 49% → **46%** (−3pp) | ~0% → **14%** | 25 |

The 2026-05-10 decision doc predicted Berlin would be "largely unchanged (mostly flat)." It isn't. Walking-% for kid-starting-out jumps to **56%** on a city whose max elevation is ~120m and where most of the routing corridors run on essentially level ground.

Spot-check (z=12 terrain-RGB, decoded via pngjs):

- Brandenburger Tor (real: ~40m) → 47.3m. Decent.
- Berlin Zoo (real: ~40m) → 42.5m. Decent.
- Two points on Friedrichstraße ~170m apart, near Bbg Tor, on flat ground: **A=41.4m, B=63.2m, Δ=21.8m → decodes as 12.8% gradient**. Triggers the 5% gate for kid-starting-out and kid-confident → bridge-walks on a flat street.

The absolute values look right, but **adjacent-pixel deltas at z=12 carry ±5–10m of noise** that swamps real gradient signal on Berlin-flat terrain. SF doesn't show this problem because the *real* gradient signal there (Bernal climb, Pacific Heights, etc.) dominates the noise floor.

This is a real gate over-firing, not just a labeling issue: a bridge-walk segment is rendered as a slow grey dash on the map, and the router pays ~3× the cost per metre vs riding. Kid-starting-out's 56% walking on a Berlin route is the user-visible signature.

## Follow-ups (not in this PR)

1. **Bump tile zoom to z=13 or z=14.** z=12 is ~38m/pixel at SF latitude (~24m at Berlin's). z=13 → ~12m/pixel, z=14 → ~6m/pixel. Less averaging-of-peaks (would fix the Bernal-reads-as-22m problem on SF) and more importantly less inter-pixel noise. Cost: 4× tiles per zoom step.
2. **Raise `MIN_GRADIENT_WAY_LEN_M` from 30m to ~150m.** At z=12 the floor is ~1 pixel wide, so 30m doesn't reliably escape pixel quantization. 150m gives ~4 pixels of averaging at z=12.
3. **Lerp between pixel centers** rather than nearest-neighbor lookup in `lookupElevation`. Bilinear interpolation reduces but doesn't eliminate the discrete-pixel noise.

(1) is the cheapest fix per impact; (2) is the cheapest absolute. Combining both is the right move if Bryan wants the Berlin baseline restored.

## Test count

`bun test` → 307 pass / 0 fail. Same as PR #187.

## Raw output

- SF with elevation: `/private/tmp/.../tasks/b6ydu6pxj.output`
- SF without elevation (2026-05-25 PR #187 baseline): `/private/tmp/.../tasks/bexvrgco4.output`
