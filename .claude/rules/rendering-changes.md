# Rendering / Overlay Changes

Routing changes are protected by a benchmark gate (`routing-changes.md`) —
that gate caught a real regression (the DEM swap) pre-merge. Rendering and
overlay changes have had NO equivalent gate, which is why routing
regressions get caught and rendering regressions historically haven't.
This rule is the rendering equivalent.

## What counts as a nontrivial rendering change

Any edit that could plausibly change *what paints on the map*, *when it
paints or un-paints*, or *how much work painting costs*:

- `src/components/BikeMapOverlay.tsx`
- `src/services/mapEngine/` (layer add/remove, projection, zoom handling)
- `src/services/overlayReachability.ts`
- `src/services/overpass.ts` tile parsing (enriched or raw)
- Any overlay visibility gate or zoom floor (`OVERLAY_MIN_RENDER_ZOOM`,
  steepness / access-gradient / crossing / fragment gates)
- Anything on the tile-arrival or elevReady hot path

A cosmetic rename or pure comment edit does not count.

## Required verification (before merging)

1. **Time-stability check — the gate that catches paint-then-vanish.**
   In a real browser, pick a viewport, screenshot at t0 (right after tiles
   visibly finish loading) and again at t+15s with NO interaction in
   between. Compare. Repeat at 2–3 zooms (browse ~z12, metro ~z14, street
   ~z16). Any painted edge that disappears between t0 and t+15s is a
   regression until proven intentional. "Progressive loading" is not an
   acceptable explanation for content that VANISHES — loading adds paint,
   it never removes it.

2. **Falsification pass.** At each zoom, ask "what looks NEW and wrong
   vs. before?" — not just whether the intended effect landed. Click odd
   artifacts and read their popups. (See the #208/#209 white-pills lesson
   in `docs/process/learnings.md`.)

3. **Performance check.** With the DevTools Performance panel recording,
   pan across ~4 tile boundaries at metro zoom. Note long tasks
   attributable to overlay work on tile arrival and record before/after
   numbers in the PR description. Until an automated overlay-paint budget
   exists, this manual check is mandatory, and "perf not measured" must be
   stated explicitly — never implied fine.

4. **Version check before believing a prod repro.** Before treating a
   prod sighting (yours or Bryan's) as a live regression, confirm the
   reporting client is actually running the current deploy — iOS
   Home-Screen web apps in particular can pin a stale bundle for days.
   A regression that only reproduces on an old version is a caching
   problem, not a rendering one.

5. **State the verification in the PR**: viewports, zooms, and what the
   t0 vs t+15s comparison showed.

## Rollback lever

If the change activates new pipeline data or a new manifest version, ship
the rollback lever in the same PR as the activation lever
(`scripts/pipeline/upload-tiles.ts --rollback-to` pattern). A 5-minute
prod A/B via rollback settles "is this actually a regression?"
empirically — faster and more reliable than local reasoning.

## Why this rule exists

The 2026-07-02 steep-moat launch (#208) shipped three rendering
regressions past tests, benchmark, code review AND a browser verification
pass — white-pill stub confetti, a deck.gl layer leak double-plotting
geometry, and tile-arrival jank — because every check verified the
feature's intended effect and none asked what ELSE changed. The
verification screenshots contained the evidence; nobody interrogated
them. The escaping bug class is TIME-DEPENDENT rendering behavior: a
single static screenshot cannot catch it by construction. Bryan's framing
(2026-07-11 retro): "My challenge is the regressions that aren't being
caught."
