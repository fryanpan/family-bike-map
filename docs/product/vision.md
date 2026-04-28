# Product Vision: Bike Route Finder

## The Problem

Parents and families want to bike safely with their kids, but existing navigation tools fail them:

- **Google Maps** routes bike trips down stroads with no bike infrastructure
- **Apple Maps** has repeatedly suggested routes on busy roads with zero bike infra even when routing for bike
- **Google Maps** picks routes that are supposedly "bike friendly" (e.g., Oranienstrasse) but are actually elevated narrow bike paths with tree roots — exactly what experienced cyclists hate
- **InfraVelo / CyclOSM** have great data but no routing and cluttered, unusable UX
- **BBBike** has routing but looks and feels like it was built 20+ years ago

**The core gap**: No tool lets you say "I prioritize Fahrradstrasse > separated paths > quiet streets" and routes that match *your* riding situation — which changes depending on who you're riding with.

---

## Our Solution

A bike routing tool that understands **personal safety preferences** and provides routes that match your specific riding situation. Start with Berlin, expand to any city worldwide.

---

## Rider Profiles

The key insight: the *same* person needs different routes depending on who they're riding with.

### Riding with Bea (age 4, doesn't ride on road yet)

Priority order:
1. **Best**: Fahrradstrasse, fully separated car-free paths, quiet neighborhood streets with no cars
2. **Acceptable**: Short connection segments riding together on the sidewalk — but only if sidewalk is wide enough and quiet
3. **Avoid**: Any road with cars moving alongside

### Riding with Joanna (confident adult cyclist)

Priority order:
1. **Best**: Fahrradstrasse (best overall), wide recreational nature trails that are car-free
2. **Good**: Quiet streets, bus lanes
3. **Avoid**: Elevated bike paths — full of tree roots, too narrow for 30+ km/h
4. **Context-dependent**: At certain times of day, major multi-lane roads are fine (can ride in the rightmost lane when traffic is light)

### Riding Solo / Other Configurations

Additional profiles to support over time as usage patterns emerge.

---

## Key Features (Priority Order)

### MVP (Phase 1)
1. **Custom Route Planning**: Route between two points with safety preference weighting
2. **Rider Profiles**: Select who you're riding with — routes adjust automatically
3. **OSM-based Data**: Leverage OpenStreetMap bicycle infrastructure tagging
4. **Visual Route Preview**: Show route on map with safety segments color-coded

### Phase 2
1. **Route Tweaking**: Manual route adjustment in the moment ("avoid this segment")
2. **Route Discussion**: Chat-style feedback to discuss alternate routes for future planning
3. **Personal Route Memory**: Save known-good custom routes (e.g., Yorkstrasse → Gneissenaustrasse → Baerwaldstrasse → Dresdener Str 112 as a good west-to-home route)
4. **Feedback System**: Rate segments, report changes — improves future routing
5. **Time-of-Day Routing**: Different route options based on traffic patterns

### Phase 3 (Optional / Nice to Have)
1. **Turn-by-Turn Navigation**: On watch or phone
2. **Offline Support**: Download routes for use without connectivity
3. **Community Route Collections**: Curated collections of popular family routes

---

## Long-Term Vision

### Today: Berlin

Help learn safe bike routes around Berlin quickly — for riding with Bea, with Joanna, or solo.

### Tomorrow: Any City

Expand to any city where we travel with bikes:
- San Francisco
- Amsterdam, Copenhagen
- Anywhere you visit with bikes

The same tool should work worldwide because it's built on OpenStreetMap, which covers every city.

### Ultimate: Worldwide Crowdsourced Map

Build a community-driven, worldwide map of kid-friendly bike infrastructure:
- Users rate route segments from their own rides
- Routes improve based on real feedback
- Local knowledge becomes discoverable by newcomers
- Families share what works in their city
- Any person or family anywhere can benefit

---

## Why Open Source / Open Data

- **OpenStreetMap**: Worldwide, free, community-maintained — covers Berlin, SF, and everywhere else
- **Open routing engines**: No lock-in, customizable for our specific preference model
- **Personal SaaS tools**: Use where they make sense (hosting, maps display), avoid where they impose routing logic we can't control

Build custom only where existing tools fail — which is: preference-aware routing with rider profiles.

---

## Success Looks Like

1. **Routes work**: Follow a suggested route without needing to deviate
2. **Routes match the rider**: Different suggestions for riding with Bea vs. Joanna vs. solo
3. **Routes improve**: Quality gets better over time based on feedback
4. **Knowledge transfers**: What works in Berlin helps bootstrap SF
5. **Community grows**: Users contribute data for their own cities
6. **Impact scales**: Families bike safely in cities worldwide

---

## Existing Tools Assessment

See `docs/research/existing-tools.md` for full analysis. Summary:

| Tool | Data | Routing | UX | Family-Safe? |
|------|------|---------|-----|-------------|
| InfraVelo | ✅ | ❌ | ❌ Cluttered | ❌ No routing |
| CyclOSM | ✅ | ❌ | ❌ Too many layers | ❌ No routing |
| BBBike | ✅ | ✅ | ❌ 20yr old UI | ❌ No profiles |
| Google Maps | ⚠️ | ✅ | ✅ | ❌ Bad bike logic |
| Apple Maps | ⚠️ | ✅ | ✅ | ❌ Routes on stroads |
| Komoot/ADFC | ⚠️ | ✅ | ✅ | ⚠️ Curated only |

**This tool combines**: OSM data + custom family routing logic + modern UX + community feedback

---

## Constraints

- Use open source tools and data wherever possible
- Build custom solutions only where existing tools fail
- Prioritize route quality over feature count
- Mobile-friendly experience for actual navigation

---

## Status (2026-04-28 launch)

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
- No user accounts required for MVP (add auth when needed for Phase 2 saved routes)
