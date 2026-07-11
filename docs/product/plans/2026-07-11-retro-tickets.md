# Tickets from 2026-07-11 retro

## Ticket 1: iOS Home-Screen app pins a stale version (perf + flicker reports were version skew)

**Symptom**: Bryan's iPhone Home-Screen bookmark (iOS standalone web app) served an
earlier app version — showing the paint-then-vanish flicker and poor performance that
were fixed in later deploys. Fresh loads of the web page in a browser show neither
symptom.

**Mechanism (confirmed plausible, needs repro)**: `public/sw.js` is a hand-rolled
service worker caching the app shell. HTML went network-first in v2 (2026-05-05), but
iOS *standalone* apps have their own lifecycle quirks: the SW update check runs on
launch, and iOS aggressively snapshots/retains standalone web-app state — a user who
never force-quits the app can sit on an old shell for days. There is currently **no way
for the user (or us) to see which version a client is running** in the UI, so version
skew is indistinguishable from a live regression.

**Work**:
1. Repro on the actual device: open the Home-Screen app, capture its version
   (via Sentry event or userback custom_data — both carry `APP_VERSION`), compare to
   current deploy.
2. Surface `APP_VERSION` visibly in the UI (settings/about corner — small, always
   reachable).
3. Add stale-detection + update prompt: on launch/foreground, fetch a tiny
   `/version` endpoint (worker already knows `APP_VERSION`); if mismatch,
   show a "new version available — reload" toast that triggers
   `registration.update()` + reload. iOS standalone honors this.
4. Verify the SW `activate` cleanup actually evicts old shells on iOS standalone
   (not just Safari tab).

**Acceptance**: Bryan's Home-Screen app shows the current version within one
launch of a new deploy, and the in-UI version string makes future skew reports
self-diagnosing.

## Ticket 2: Automated overlay-paint performance budget

**Context**: The #208 tile-arrival jank shipped with no perf gate to notice.
`rendering-changes.md` now mandates a *manual* DevTools check; this ticket automates it.
De-prioritized from "prod is slow" urgency since the 2026-07-11 perf report traced to
version skew (Ticket 1) — but the gap is real.

**Work**:
1. `scripts/bench-overlay-paint.ts` (sibling of `bench-route-latency.ts`): load a
   fixture enriched tile + a fixture raw tile, run the full classify → verdict →
   geometry-prep path for a mode switch and a simulated tile arrival, assert wall-time
   budgets (calibrate on the Mac mini, set budget ~3× measured).
2. CI: run it in ci.yml (deterministic, no browser).
3. Optional follow-up: scripted browser harness (pan across 4 tile boundaries,
   collect long-task count via PerformanceObserver) with recorded baseline —
   run as part of rendering-change verification, not CI.

**Acceptance**: a PR that reintroduces #208-style synchronous over-the-full-fetched-set
work on tile arrival fails CI.
