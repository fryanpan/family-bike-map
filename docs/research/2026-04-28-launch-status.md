# Launch status snapshot — 2026-04-28

Point-in-time record of what was live at the 2026-04-28 Phase 1 launch.
**Not current state** — read it as history. It was written as a `## Status`
section of `docs/product/vision.md` on branch
`docs/post-launch-vision-decisions`, which never merged; it is preserved here
under its own date so vision.md does not carry a stale "Status" heading, and
so the branch can be deleted without losing the record.

**Phase 1 MVP shipped.** Live at https://bike-map.fryanpan.com.

### What's live

- **Five travel modes** keyed off the LTS framework (Mekuria–Furth–Nixon 2012, with our extension into 1a/1b/2a/2b sub-tiers): kid-starting-out, kid-confident, kid-traffic-savvy, carrying-kid, training (admin-flagged off in prod). Default = kid-starting-out so new visitors land on the most-protective routing.
- **Two cities**: Berlin (110 benchmark pairs across 22 origin/dest combinations × 5 modes) and San Francisco (85 pairs × 17 combinations × 5 modes). Same code, both work.
- **Client-side router** (ngraph.path A*) built on Overpass tile data. 100% success on all 195 benchmark pairs (post-PR #138 fix). Route segments are scored, healed of short non-preferred gaps at intersections, and rendered tier-colored.
- **Mapillary + Google Street View** photos in segment-tap popovers — readers can SEE what the path looks like before committing.
- **Region rules** in Cloudflare KV — per-city classification overrides without code deploys.
- **Admin tools**: classification audit, settings (tier color/weight overrides, per-mode routing knobs), routing benchmarks tab listing all past runs.
- **Observability**: Sentry on both frontend and Worker (single project, runtime-tagged), PostHog session analytics, Userback feedback widget, anonymous route logging to D1.

### Benchmark headline (Berlin, 22 pairs × kid-confident)

| Router | Avg preferred % | Avg distance |
|---|---:|---:|
| **Client (ours)** | **68%** | 6.60 km (+39%) |
| BRouter | 42% | 4.80 km |
| Valhalla | 39% | 4.76 km |
| Google bicycling | 35% | 4.85 km |

Tradeoff: ~+20 percentage points more on preferred infrastructure, ~+30% farther on average, sometimes up to 2.6× in the worst case (long detours through Fahrradstraßen instead of arterials). Honest framing in the launch blog post — see `docs/research/2026-04-24-findnearestnode-reachability-fix.md` for the full benchmark.

### Active follow-ups (post-launch)

1. **Feedback triage cadence** — daily light-touch review of Userback + segment-feedback inflow if launch traffic warrants it.
2. **Overpass query coverage** — current query fetches only bike-tagged highways (`cycleway`, `residential` + bike, `path`, `track`, `footway` + bike, plus any street with a cycleway:* tag). Tertiary / secondary / unclassified streets without cycleway tags are absent from the graph. That works in Berlin where bike tagging is dense; it leaves SF with corridor-street gaps. Expanding the query (router would reject most expanded streets but they'd serve as bridge-walks) is the planned next router improvement.
3. **Live "current benchmark" view** — gated on user demand. The launch post screenshots are pinned to the frozen `2026-04-24-0.1.184-local-5478dd5-dirty/` folder; a live-current page can ship later.
4. **DNS apex** — `fryanpan.com` apex going to a personal site project (Job Search agent owns); bike-map stays subdomain-only. Coordinated.

### What's deferred from the original phasing

- **Time-of-day routing** (Phase 2): skipped — would need traffic data the OSM stack doesn't provide.
- **Route discussion / chat** (Phase 2): skipped — prioritized photo-driven feedback (segment popover with up/down + report) instead.
- **Personal route memory** (Phase 2): partial — "Save as Home / Save as School" landing-page shortcuts shipped, but no broader saved-route gallery.
- **Turn-by-turn navigation** (Phase 3): the wiring exists in `DirectionsPanel` (GPS heading, off-route detection scaffolding) but is admin-flagged off — UX wasn't ready for public.
- **Offline support / PWA** (Phase 3): tile cache persists in IndexedDB for visited regions, but no first-class offline mode yet.
