# Render checks

Automated counterpart of `.claude/rules/rendering-changes.md` — that rule
mandates a manual browser-based verification pass for any change that could
plausibly affect what paints on the map, when, or how much it costs. This
directory automates the three checks that rule requires plus one extra
(perf) and a related pure-script CI gate. It is a **local/manual command
today** (`bun run render-check`), not wired into CI — see "Why not in CI
yet" below.

Sibling piece: `scripts/bench-overlay-paint.ts` (repo root, not in this
directory) is a pure-script, no-browser perf tripwire for the same overlay
pipeline, and **is** wired into `.github/workflows/ci.yml` on every PR.

## What each check does

| Check | What it verifies | File |
|---|---|---|
| DETERMINISM | The same final viewport reached two ways — direct cold load vs. load elsewhere + pan/zoom back — paints identically. | `checks/determinism.ts` |
| TIME-STABILITY | Screenshot at t0 (tiles settled) and t+15s with zero interaction, at z12/14/16: painted pixels may be ADDED, never REMOVED. Catches the "flicker/vanishing-edges" regression class. | `checks/time-stability.ts` |
| ALWAYS-VISIBLE | At citywide zoom (z11-z12) over a residential SF neighborhood, the overlay must paint at least a minimum pixel count. **Currently a known-fail** — see below. | `checks/always-visible.ts` |
| PERF BUDGET | Long tasks + total blocking time (TBT) during initial load and a zoom-out interaction, in a real browser. | `checks/perf-budget.ts` |

All four screenshot ONLY the map canvas (`[data-testid="map-canvas"]` on
the engine's container div, added to `src/components/Map.tsx` for this
harness) and compare **painted (non-background) pixels**, defined as pixels
within a small RGB-distance tolerance of the overlay's known tier palette
(`colorForLevel`'s output colors) — see `lib/pixels.ts`'s file header for
why this beats a generic saturation heuristic, and its scope note: this is
calibrated for the Leaflet/OSM-Carto engine, which is what every check
actually renders under (no `VITE_GOOGLE_MAPS_KEY` / `VITE_MAPTILER_KEY` are
set in this harness, so `resolveEngine` always falls back to OSM Carto).

## Setup

```bash
bun install
bunx playwright install chromium   # one-time, NOT run automatically by
                                    # `bun install` or in CI (see below)
```

## Usage

```bash
bun run render-check                              # all 4 checks
bun scripts/render-checks/run-all.ts --only determinism,perf-budget
bun scripts/render-checks/checks/always-visible.ts # a single check standalone
```

Each check is also an independently runnable script (has its own
`if (import.meta.main)` entry point) — useful when iterating on one check
without paying the ~2-4 minute cost of the full suite.

### How the app gets served

`serveApp()` (`lib/serve.ts`) runs `bun run build` then `wrangler dev`.
`wrangler.toml`'s `[assets]` block points at `./dist` with SPA fallback, so
**one wrangler process serves the built app AND the live Worker `/api/*`
routes** (the Overpass proxy the bike-infra overlay needs) on a single
port — the closest local approximation to production topology, and the
only local option where the overlay actually has real data to paint.
`vite preview` alone can't do this (no `/api` proxy in preview mode).

If `bun run build` fails on an environment-only issue (missing
`SENTRY_AUTH_TOKEN` for sourcemap upload, etc. — the same class of failure
called out in the top-level agent setup notes), `serveApp()` falls back to
`vite dev` + a separate `wrangler dev --port 8791`, using the `/api` proxy
already configured in `vite.config.ts`'s `server.proxy` block for exactly
this local-dev pattern.

**Port collisions**: this machine runs several other long-lived local
services (a live-feedback plugin server was observed squatting on port
`8787`, wrangler's own conventional default). `serveApp()` uses `8793`
instead, and `waitForServer` verifies the response body actually contains
`"Family Bike Map"` before declaring the server ready — if you see a
"doesn't look like family-bike-map" error, something else has grabbed the
port; pass `serveApp({ port: N })` (or edit the default) to pick another.

### Wrangler local state and cold vs. warm runs

`wrangler dev` persists R2/D1/cache state to `.wrangler/state/` **on
disk**, surviving across process restarts within the same worktree. This
matters a lot for the ALWAYS-VISIBLE and PERF-BUDGET checks: a "warm" run
(state left over from a previous render-check run, or from manually
poking at the app) fetches tiles from local disk cache almost instantly
and paints far more than a genuinely first-ever run would. **Every real
CI run starts cold** (fresh checkout, `.wrangler/` is gitignored), so
budgets and thresholds in this directory are calibrated against a cold
cache. To reproduce a cold run locally:

```bash
rm -r .wrangler/state/v3/cache .wrangler/state/v3/r2   # NOT -rf; do this deliberately
bun scripts/render-checks/checks/always-visible.ts
```

This bit the harness once during calibration: the Outer Sunset viewport
in `always-visible.ts` read 3000+ painted px on a warm cache and only
~360 on a cold one — a 8x difference from cache state alone, unrelated to
any code change.

### Waiting for tiles

`lib/mapControl.ts`'s `waitForTilesSettled()` polls the app's own
tile-loading indicator (`.tile-loading-boxes`, disappears when
`src/services/tileLoadStatus.ts`'s `status.active` goes false) rather than
a fixed timeout or Playwright's `networkidle` — `networkidle` was found to
time out unpredictably (Sentry/Plausible beacons, or the overlay's own
tile-fetch cascade at wide zooms, can keep something in flight past its
500ms-idle window). `waitForTilesSettled` is deliberately best-effort: a
single slow/retrying tile can keep the indicator "active" indefinitely
even after every other tile has resolved and painted, so it caps its wait
at 15s (calibration observed the painted count stabilizing within ~10s in
every case tested) and logs a warning rather than failing when it times
out. If you need a *hard* guarantee that painting is fully done, re-
screenshot after an additional wait and compare against the first — none
of the current checks need that, but a future one might.

## OVERVIEW-COVERAGE (z9 / z10 / z11) — needs seeded overview tiles

`checks/overview-coverage.ts` asserts the property the baked 1.0° overview level
exists to deliver: at overview zoom the overlay covers the **whole viewport**,
not a blob around the cursor. It splits the map canvas into a 4×4 grid and
requires painted overlay pixels in at least 60% of the cells at z9, z10 and z11
(Bay Area → Sacramento Delta, land in every quadrant).

ALWAYS-VISIBLE cannot catch this: a non-empty floor is satisfied by the old
centre-blob behaviour too — 64 nearest-to-centre tiles always paint *something*
near the middle. The regression it misses is the deterministic coverage GAP at
the edges. So this check asserts a spatial property, not a count.

**It SKIPs unless the local R2 has baked overview cells.** The overview level is
served from R2 through the active manifest; a fresh `wrangler dev` has an empty
local R2, `/api/overview` 404s, and the client (by design) falls back to the
0.1° path — where the coverage gap is EXPECTED, so a failure there would be
unattributable. Seed it first:

```sh
bun scripts/pipeline/bake-overview.ts --tiles data/tiles/california
bun scripts/pipeline/upload-tiles.ts  --tiles data/tiles/california --local
```

The check probes `/api/overview?row=38&col=-122` and reports `SKIPPED` when it
404s. The 60% threshold is derived from the geometry of the gap, NOT calibrated
against a real bake — re-calibrate it (and record the measured numbers in the
check) against the first CA overview bake.

## The ALWAYS-VISIBLE known-fail

`scripts/render-checks/known-fails.ts` lists checks that are expected to
fail against current `main`, with the reason and the fix expected to flip
them. `run-all.ts` treats a listed check's failure as XFAIL (exit code
stays 0) and loudly warns if a listed check unexpectedly *passes* (a
signal the fix landed and the entry is stale).

`always-visible` is listed today: on a cold cache, a residential SF
neighborhood with sparse preferred (1a/1b) infra (Outer Sunset, chosen
deliberately over downtown SF — see `checks/always-visible.ts`'s comment;
downtown's dense infra already paints comfortably and would mask the gap)
paints only ~360px at z12, under the check's 500px floor. There is no
code path on current `main` that guarantees a minimum overlay density at
citywide zoom — `feat/always-visible-overlay` (sibling PR) is expected to
add one. **Once that PR merges, delete the `always-visible` entry from
`known-fails.ts`** — don't just leave it; the whole point of XFAIL is that
it's a tracked, time-bound debt, not a permanent suppression.

## Recalibrating budgets

Every numeric threshold in this directory (`MIN_PAINTED_PIXELS` in
always-visible.ts, `MAX_DIVERGENT_PIXEL_RATIO` in determinism.ts,
`MAX_VANISHED_PIXEL_RATIO` in time-stability.ts, `BUDGETS_MS` in
perf-budget.ts, and the sibling `BUDGETS_MS` in `scripts/bench-overlay-
paint.ts`) is a **generous regression tripwire calibrated against a
measured baseline**, not a hand-picked target. When a check starts
failing after an intentional change (e.g. the overlay legitimately paints
more infrastructure now, or a new pipeline stage adds real, justified
cost):

1. **Ablate first, believe the number second.** Confirm the failure
   traces to the change you expect, not something else — re-run the check
   against `main` (before your branch) and against your branch, and
   compare. If `main` ALSO fails, the threshold itself is stale/flaky, not
   your change.
2. **Re-measure on a cold cache.** See "Wrangler local state" above —
   `rm -r .wrangler/state/v3/cache .wrangler/state/v3/r2` before
   measuring, or you'll calibrate against warm-cache numbers that don't
   represent a real CI run.
3. **Run 3+ times** and note the range (min/max), not just one sample —
   perf numbers in particular vary run to run.
4. **Set the new budget at ~3x the worst observed run**, same convention
   as `scripts/bench-overlay-paint.ts` and `.claude/rules/routing-
   changes.md`'s benchmark gate. Round up to a clean number.
5. **Update the calibration comment** next to the constant with the date,
   the raw numbers, and the machine/conditions (cold/warm cache, which
   commit) — the next person recalibrating needs that context, not just
   the final number.
6. Commit the threshold change with the code change that justified it, not
   as a separate "bump the budget" PR with no context.

## Why not in CI yet

The Playwright suite needs a live network (`overpass-api.de` via the
Worker proxy) and takes 2-4 minutes end to end (`time-stability` alone
runs 3 zooms x 15s of enforced idle wait). `bench-overlay-paint.ts` is the
CI-appropriate subset: deterministic, offline, seconds not minutes. This
directory is the human-in-the-loop complement, run before merging a
rendering change per `.claude/rules/rendering-changes.md`'s required
verification steps — not yet a CI gate. A future iteration could wire a
subset (e.g. `determinism` + `time-stability`, both offline-network-light
once a fixture Overpass response is recorded) into CI; that's explicitly
out of scope here.
