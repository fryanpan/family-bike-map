# UX Review — bike-map.fryanpan.com (2026-04-25)

External UX walkthrough by **ux-review-plugin** (Week-1 MVP), commit `d37a65f` on `week-2-prompt-iter` branch. Run by a Claude agent via claude-in-chrome on `https://bike-map.fryanpan.com/?mobile=iphone` against four user-goal scenarios I supplied. Cost: $4.12. Calibration: 2 of 3 known issues caught organically.

**Honest framing from the plugin author**: Claude's published heuristic-recall ceiling is ~57–58% versus an aggregated human reviewer; this is a single fresh-eyed walkthrough, not a definitive audit. It is complementary to my own review work in `2026-04-17-ux-review*.md`, `2026-04-18-ux-review-post-chunks.md`, and `2026-04-20-pre-launch-ux-review.md`.

## Goal completion

| Goal | Result |
|------|--------|
| g1 — first-time understanding | ⚠️ Partial. Legend explained; product purpose + getting-started not. |
| g2 — kid-confident A→B route | ⚠️ Partial. Route computed (2.9 km · 26 min · 92% car-free) but camera moved off-route after zoom. |
| g3 — segment popover | ❌ Failed. Polyline hit-target too small at 375px. |
| g4 — mode switch repaint | ✅ Worked. (Tested kid-confident vs. carrying-kid — Training mode is admin-flagged, hidden in prod.) |

## Critical (block ship)

### C1. Map camera doesn't follow the route after zoom/swap

After computing a route, the map sometimes zoomed out to show all of metro Berlin (route as a tiny scribble). Clicking the "+" zoom button zoomed on viewport center, not the route — landing the agent in Wilmersdorf, ~5 km from the actual Kreuzberg route. Distance/time were readable from the bottom panel, but the route itself couldn't be visually verified without manual panning.

> *The whole point of this app is showing you a kid-friendly path. If the user can't see it, they can't trust it or follow it on their bike. This breaks the core value prop on the most common workflow.*

### C2. Intro card teaches the legend, not the product

The intro card is titled "Preferred paths for [mode]" and lists line-color categories. It does **not** say:
- what the app is
- who it's for
- how to start a route

"Family Bike Map — kid-safe bike routes" lives only in the browser-tab title. A first-time visitor with no marketing-copy context understands the legend but can't articulate the product purpose or how to begin.

## Issues (should fix)

### I3. Direction-panel "other" category undefined; numbers don't sum to 100%

Route stats bar shows `92% car-free + 6% other = 98%`. "Other" isn't in any visible legend, and the missing 2% erodes trust. Agent flagged this as both a label-clarity bug AND a numeric-correctness bug — worth checking the bar's underlying calculation, not just adding a legend entry.

### I4. Same route reports different distances after swap

Same A↔B reported 2.5 km before swap and 4.4 km after swap (same 38 min ETA). Either the routing graph is asymmetric by-design (one-way streets, different cycleways each direction) or one number is wrong. Either way, users will notice and lose trust in the distance figure.

### I5. Bike-segment polylines too thin to tap reliably on mobile

Visible green polyline tapped at 375px → no popover. Lines render at ~2-3 px, well below Apple HIG (44 pt) and Google MD (48 dp) touch-target guidance. Defeats one of the app's signature features (street-view + classification on tap).

### I6. Travel-mode icon set is opaque; no labels on first encounter

Four near-identical bike-related icons in a row. No text label, no first-hover tooltip, no caption. The mode is the most consequential setting in the app — it determines what counts as safe for *this* rider. Burying it behind cryptic icons is a UX hazard.

## Polish (post-ship OK)

- **38 min for 2.5 km** at kid-confident is ~4 km/h (walking pace). May bake in intersection waits; either way, surface the calibration assumption ("estimated at slow kid pace, including stops").
- **Mode-name drift** between my goal-description and the live app — Training mode is admin-flagged off in prod; rightmost public mode is "Carrying kid". Study-design note, not a product bug.

## What worked well (preserve in any rewrite)

- **Mode change → legend update → map recolor** is clean and ~1 s. Removing the blue "Bike route beside cars" category when switching to Kid-confident is exactly the right behavior and a clear demonstration of the app's core idea.
- **Place autocomplete** is fast and Berlin-aware (Hermannplatz / Görlitzer Park surfaced immediately).
- **Place-result card "Save as Home / Save as School"** — the agent specifically called out "Save as School" as the *only* place in the UI that signals who the product is for. Worth amplifying.
- **URL synchronization** of travel mode is excellent for sharing routes/views.
- **Stats breakdown bar** is a good at-a-glance summary (modulo I3).

## Triage

Pre-launch (Tue-Wed):

- ✅ **C1** (camera follow) — fix
- ✅ **C2** (intro card) — fix
- ✅ **I3** (other label + missing 2%) — investigate + fix
- 🔍 **I4** (distance swap) — investigate root cause first; could be by-design (one-way asymmetry) or a real bug

Defer post-launch:

- **I5** (polyline tap target) — fix, but lower priority than launch-blockers if time-constrained
- **I6** (mode-icon labels) — partially mitigated by the intro card change in C2; standalone fix later
- All polish items

## Reference

- Run: ux-review-plugin commit `d37a65f` on `week-2-prompt-iter`
- Artifacts (in the ux-review-plugin repo, not this one): `studies/2026-04-25-bike-map-prod/`
  - `evaluation/final-report.md` — full report verbatim above
  - `performers/performer-1/walkthrough.gif` — 10.3 MB, 21 frames
  - `viewer/index.html` — scrubbable narration ↔ frame links
