# 2026-05-26 Adaptive gradient cap — benchmark results

## Why this change exists

Yesterday's elevation benchmark (PR #190) showed the gate over-firing
on flat Berlin: kid-starting-out walking-% jumped from ~0% (gate
skipped pre-decoder) to 56% with the decoder live, because
terrain-RGB at z=12 has ~±10 m inter-pixel noise that fakes 12%
gradients on flat 170 m runs like Friedrichstraße.

Bryan greenlit all three proposed mitigations (zoom bump, bilinear
pixel lerp, way-length floor raise). When I implemented each:

| Fix | Tried | Result |
|---|---|---|
| Bump zoom to z=13 | Yes (2026-05-26) | **Not possible** — MapTiler caps terrain-rgb at z=12. z=13+ returns HTTP 400. Verified by direct fetch at z=11/12/13/14/15. |
| Bilinear pixel interpolation | Yes | **Lost SF signal.** Bernal Heights' 22 m nearest-pixel read dropped to 10 m bilinear because the peak occupies one z=12 pixel surrounded by valley floor — smoothing collapsed the gradient. SF preferred-% would regress. |
| Raise way-length floor (30 → 300 m) | Yes | **Disabled most of the gate on SF.** SF kid-starting-out walking returned to the gate-off baseline (67%). Doesn't differentiate flat-noise from real-short-climbs. |

None of the three landed as cheap defense-in-depth fixes. Instead,
shipping a fourth approach: **way-length-adaptive gradient cap**.

## The fix

```
effectiveCap = mode.gradientCapPct + ELEVATION_NOISE_M / wayLen * 100
```

With `ELEVATION_NOISE_M = 20`:

| Way length | Kid effective cap (base 5%) | Training effective cap (base 8%) |
|---|---|---|
| 100 m | 25% | 28% |
| 170 m | 16.8% | 19.8% |
| 300 m | 11.7% | 14.7% |
| 500 m | 9% | 12% |
| 1000 m | 7% | 10% |
| 3000 m | 5.7% | 8.7% |

Short ways need a higher *decoded* gradient to fire the gate (because
noise dominates at short scale). Long ways are close to the base cap
(noise averages out). This matches the actual noise model of z=12
terrain-RGB without requiring better data.

## SF — adaptive cap stays sensitive to real climbs

| Mode | Gate-off baseline | Floor=30 (PR #189, over-fire) | Floor=300 (gate-off) | **Adaptive (this PR)** |
|------|:---:|:---:|:---:|:---:|
| kid-starting-out | walk 67%, pref 21% | walk **87%**, pref 10% | walk 67%, pref 21% | walk **80%**, pref 17% |
| kid-confident | walk 51%, pref 39% | walk **71%**, pref 28% | walk 51%, pref 39% | walk **61%**, pref 37% |
| kid-traffic-savvy | walk 1%, pref 47% | walk **18%**, pref 36% | walk 3%, pref 55% | walk **10%**, pref 41% |
| carrying-kid | walk 1%, pref 42% | walk **14%**, pref 35% | walk 3%, pref 48% | walk **8%**, pref 36% |
| training | walk 0%, pref 42% | walk **9%**, pref 28% | walk 1%, pref 42% | walk **6%**, pref 31% |

Walking-% sits between the over-fire (floor=30) and gate-off
(floor=300) extremes. The gate is still catching Bernal, Twin Peaks,
Pacific Heights climbs (per-route breakdown shows the hilly routes
still demote) — just less aggressively.

## Berlin — partial improvement, not back to baseline

| Mode | Gate-off (2026-05-10) | Floor=30 with elev (2026-05-25, over-fire) | **Adaptive (this PR)** |
|------|:---:|:---:|:---:|
| kid-starting-out | pref 56%, walk ~0% | pref 41%, walk **56%** | pref 49%, walk **44%** |
| kid-confident | pref 67%, walk ~0% | pref 60%, walk **48%** | pref 65%, walk **33%** |
| kid-traffic-savvy | pref 64%, walk ~0% | pref 63%, walk **26%** | pref 64%, walk **14%** |
| carrying-kid | pref 54%, walk ~0% | pref 52%, walk **31%** | pref 55%, walk **20%** |
| training | pref 49%, walk ~0% | pref 46%, walk **14%** | pref 47%, walk **6%** |

Adaptive cap **halves the over-firing across every mode** — but
doesn't return to the gate-off ~0% walking baseline. The 44% walking
on kid-starting-out is still much higher than reality (Berlin is
nearly flat). z=12 inter-pixel noise on long ways is the residual.
A 2 km Berlin way could decode 4–8% spurious gradient from noise
accumulation; that clears the adaptive cap on a 2 km way (~6%).

The team-lead's target ("walking back to ~0% on flat ground") is
not achievable at z=12 without either:

- **Multi-point sampling along ways** with smoothing — needs to be
  noise-aware too, so this is more involved than a simple "sample
  every 50 m" because 50 m samples are still pixel-noise-dominated
- **Higher-resolution data source** — MapTiler caps terrain-rgb at
  z=12. Alternatives: USGS NED (USA only, free, ~10 m resolution),
  Mapbox terrain-rgb (their max is z=15), AWS Terrain Tiles
  (z=15 max), OpenTopoData hosted SRTM (~30 m, similar to MapTiler)

Both are bigger lifts. Documented for follow-up.

## Why not crank `ELEVATION_NOISE_M` higher?

Tried mentally with `ELEVATION_NOISE_M = 30`:

- 1000 m way kid cap = 5 + 3 = 8%. SF Bernal climb (~25%) still
  fires; OK.
- 1000 m way training cap = 11%. Training would less aggressively
  walk hills, fine for that mode.
- Berlin 2 km way at 6% decoded noise = under 6.5% cap on a 2 km
  way at NOISE_M=30 — barely helps Berlin further.

Higher noise budget mostly disables the gate on long ways without
fixing the residual short-way Berlin issue, because Berlin's
remaining over-firing is on the medium-length ways (~500 m–1.5 km)
where the adaptive cap is already ~7–9%. Stuck at NOISE_M=20 as
the trade-off floor for now.

## Memory + routes-found

- Berlin: 22/22 every mode. Peak RSS 1.75 GB. GC fix from PR #188
  still holds.
- SF: 17/17 every mode. Peak RSS 0.97 GB.

## Test count

`bun test` → 308 pass / 0 fail. One new test pins the Berlin
Friedrichstraße-style adaptive-cap behavior so a future refactor
can't silently regress to floor-only logic.

## Raw output

- SF: `/private/tmp/.../tasks/b9kqquhwl.output`
- Berlin: `/private/tmp/.../tasks/b46a4r39l.output`
