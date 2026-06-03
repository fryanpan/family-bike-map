# Overlay gradient gate + crossing hide — 2026-06-02

## What changed

Two overlay-only fixes, prompted by Bryan looking at SF kid-confident:

1. **Crossing/traffic-island stubs hidden from the browse overlay.** Every
   intersection carries a tiny `footway=crossing` / `cycleway=crossing` /
   `footway=traffic_island` way. They're real network connectors (routing
   keeps them) but on the overlay they paint as disconnected confetti.
   New `isOverlayCrossing()` skips them in `BikeMapOverlay` Pass-0.

2. **Too-steep ways hidden from the overlay, per mode.** The browse overlay
   had zero elevation awareness, so bare `highway=path` hiking trails (e.g.
   SF's Edgewood / Historic / Timber / West Ridge trails at 19–26%) rendered
   as preferred green "Bike path." New `overlayGradientPct()` computes a
   way's gross gradient from the shared terrain-RGB elevation source; ways
   above `getOverlayMaxGradientPct(mode)` are hidden.

Per-mode thresholds (rise with capability; preserve the kid-skill superset
invariant): kid-starting-out 6%, kid-confident 8%, carrying-kid 8%,
kid-traffic-savvy 10%, training 15%.

## Routing is UNCHANGED

This is a display change. `clientRouter` was edited only to extract the
per-way ascent sum into a shared `wayAscentMeters()` helper (now the single
source of "what counts as uphill" for both the router's A* cost and the
overlay's steepness gate). The refactor is behavior-preserving — the full
benchmark reproduces PR #192's numbers **exactly**:

### SF (client, elevation on) — identical to 2026-05-26 cost-based

| Mode | Found | Avg Pref | Avg Walk | Avg Time |
|------|-------|----------|----------|----------|
| kid-starting-out | 17/17 | 21% | 67% | 224 min |
| kid-confident | 17/17 | 36% | 54% | 100 min |
| kid-traffic-savvy | 17/17 | 49% | 3% | 28 min |
| carrying-kid | 17/17 | 41% | 5% | 26 min |
| training | 17/17 | 37% | 0% | 14 min |

### Berlin (client, elevation on) — identical to 2026-05-26 cost-based

| Mode | Found | Avg Pref | Avg Walk | Avg Time |
|------|-------|----------|----------|----------|
| kid-starting-out | 22/22 | 46% | 47% | 174 min |
| kid-confident | 22/22 | 61% | 37% | 75 min |
| kid-traffic-savvy | 22/22 | 63% | 16% | 36 min |
| carrying-kid | 22/22 | 54% | 25% | 37 min |
| training | 22/22 | 43% | 6% | 19 min |

Routes-found, preferred-%, walk-%, and time match the prior committed
benchmark to the digit → the ascent-helper extraction changed no routes.

## Overlay effect (measured on real SF OSM, central tiles, kid-confident)

Replicating Pass-0 with the production classify/elevation/crossing functions:

- **Shown preferred ways: 1638 → 1360** (−17%)
  - −203 crossing/traffic-island stubs
  - −75 too-steep ways (the 19–26% `highway=path` hiking trails, by name:
    Edgewood Trail, Historic Trail, Timber Trail, West Ridge Trail,
    Gardener's Trail, …)

Threshold sensitivity (graded ways ≥40 m, kid-confident, 913 ways):
6%→14% hidden, 8%→8%, 10%→5%, 12%→4%, 15%→2%. 8% for kid-confident hides the
genuinely-steep tail without touching moderate hills.

## Performance (answers "is gradient calc too expensive for the overlay?")

- `prefetchElevation(viewport bbox)`: **~300 ms** one-time, ~a dozen z=12
  tiles, cached in-memory and **shared with the router** (a later route
  request reuses them).
- Per-way gradient for all 1638 shown ways: **~31 ms** total (sync
  nearest-pixel reads over already-loaded tiles).

Negligible. The gate fails soft: until the terrain tiles arrive,
`overlayGradientPct` returns null and every way shows, so steep ways simply
drop out a beat after pan rather than blocking the overlay.

## Not addressed (possible follow-ups)

- Bare `highway=path` with no bike tag still classifies as "Bike path" in
  `classifyEdge` (`bikeOnPath = isPath && bicycle !== 'no'`). The slope gate
  catches the *steep* ones; flat no-bike-tag park paths still show. Changing
  the classifier touches routing and would need its own benchmark.
- Remaining short stubs (sidewalk `bicycle=yes`, short real cycleway
  fragments chopped at intersections) are legitimate infra, left visible.
