# Family Bike Map — blog pre-stage

**Status:** Raw material for blog-assistant to pull from. Not a final draft. Target publish Wed Apr 15. Canonical final draft lives in the blog-assistant repo.

**Audience:** Tech-curious blog readers, mixed devs and non-devs. Conversational tone.

**Live site:** [bike-map.fryanpan.com](https://bike-map.fryanpan.com)
**Source:** [github.com/fryanpan/family-bike-map](https://github.com/fryanpan/family-bike-map) (public, MIT)

---

## 1. The hook — why this exists

A parent's bike routing problem in one sentence: **every existing bike app treats a painted line on a four-lane stroad as equivalent to a car-free path through a park.**

If you're riding with a 4-year-old, those are completely different things. One is safe. One is terrifying.

### Concrete failure modes (from `docs/product/vision.md`)

- **Google Maps** routes bike trips down stroads with no bike infrastructure at all.
- **Apple Maps** has repeatedly suggested busy arterials with zero bike infra when asked for bike routes.
- **Google Maps** picks routes it calls "bike friendly" (e.g. Oranienstraße in Berlin) that are actually narrow elevated paths with tree roots — exactly what experienced cyclists avoid.
- **Komoot** is built for adult cycling enthusiasts, not families riding at 10 km/h with a kid.
- **InfraVelo / CyclOSM** have great data but no routing and a UX from 2005.
- **BBBike** has routing but looks and feels like it was built 20+ years ago.

**The deeper gap:** there is no tool where you can say "I prioritize Fahrradstraßen and car-free paths, and I absolutely will not ride on a painted line beside cars with my kid" — and have routes that match that preference, and have those preferences change based on who you're riding with today.

### Personal context

The project started because Bryan (the primary user) wanted to plan routes for family bike trips in Berlin with his 4-year-old daughter Bea. Bea is learning to ride on her own bike — she has some control, can stop to avoid danger, but is not ready to make split-second decisions around moving cars. Bryan also has lived cycling experience in Copenhagen and San Francisco, so he knew firsthand that a "protected bike lane" means very different things in different cities.

Copenhagen designs for 8-year-olds. Berlin has the infrastructure but the network has gaps. San Francisco has a few hero corridors (Slow Streets, JFK Promenade) surrounded by plastic-post "protected" lanes that are not actually safe for a kid. No global navigation app expresses any of this.

### Problem summary in one paragraph

*"I want to plan a route from home to a park across town with my 4-year-old on her own bike. I need a map that shows which paths are actually safe for her — car-free paths, bike-priority streets — and a router that finds a way using only those. Not just 'bike friendly' as some generic label, but specifically the kind of infrastructure a kid can survive on. Existing apps will happily route me down a painted line on a main road and call it good. That's not a route; that's a hazard."*

---

## 2. What it does

### Core features (from README)

- **Browse the map** — every bike-usable path colored by safety: green for car-separated infrastructure (Fahrradstraßen, car-free paths, protected tracks, park trails), orange for anywhere cars are present (painted lanes, residential streets, bus lanes). You can zoom in anywhere and instantly see what's safe.
- **Route with a travel mode** — five modes as of this week: Kid starting out (default), Kid confident, Kid traffic-savvy, Carrying kid, Training. Each mode picks different routes for the same A→B.
- **Multimodal walking bridges** — if a route needs to cross a short bad-infra segment, the router can switch to walking the bike on the sidewalk at 3 km/h instead of routing through traffic. The walking segments are visually distinct so you know where to dismount.
- **Navigate** — live GPS tracking, auto-advancing turn-by-turn directions, voice announcements.
- **Download areas for offline routing** — Google Maps-style viewport frame where you draw the area you want cached.
- **Quality scoring** — every route gets scored by percentage on safe infrastructure, with intersection gap healing so short non-preferred connectors between two good segments don't drag the number down.
- **Admin audit tool** — classify infrastructure samples against street-level Mapillary imagery to validate the classifier.

### What the map looks like

- Green paths = safe for a kid on their own bike.
- Orange paths = cars are present.
- Tap any path for its classification.
- The currently-selected route renders on top with its own color, and walking bridges render dashed.

### How you use it

1. Open the map, browse green paths to see which neighborhoods are bike-safe.
2. Search for a destination.
3. Pick a travel mode (or leave it on "Kid starting out" — the default).
4. Get a route. See its safety breakdown. Start navigating.

---

## 3. How it was built

### Tech stack

- **React + Leaflet** — frontend and map rendering
- **ngraph.path** — client-side A* routing on a graph built from OpenStreetMap
- **Cloudflare Workers + KV + D1** — API proxy, classification rules, route logs, deployment
- **OpenStreetMap via Overpass API** — infrastructure data, fetched in tiles and cached in browser
- **TypeScript + Vite + Bun** — build and test toolchain (204+ tests passing)
- **Claude Opus 4.6** — used heavily for research and for the experimental preference-compilation pipeline being built right now

### Interesting engineering decisions

#### 1. Client-side routing in the browser

Instead of hitting a routing server, the app downloads OpenStreetMap data for an area once and builds a routing graph in the browser. A typical city graph is 30,000–60,000 intersections and routes in 10–30 milliseconds. No rate limits, works offline, and the classifier that colors the map is literally the same code that builds the cost function for routing.

That last point is the key insight. In most routing apps, the display classification (what the map shows you) and the routing cost function (what the router actually optimizes for) are maintained separately and can drift. Here they're the same function. **What you see is what you route on.**

See: `src/services/clientRouter.ts`, `src/utils/classify.ts`.

#### 2. Speed-based costs, not arbitrary penalties

A lot of bike routers use arbitrary penalty multipliers: "painted lane is 1.5x worse than a path," whatever. It's hard to tune and it doesn't match how you actually think about routes.

Family Bike Map uses realistic travel speeds per infrastructure type. A kid bikes at 10 km/h on a Fahrradstraße. The same kid walks at 3 km/h on a sidewalk past a scary intersection. Cost is time = distance / speed. The router naturally minimizes total travel time by maximizing time on good infrastructure. No magic multipliers.

The upshot: if a 50-meter walking bridge lets you avoid a 200-meter detour on a sketchy road, the router takes the walking bridge because it's actually faster at "kid with parent" speeds. The math just works.

#### 3. Benchmark numbers (from the README)

22 test routes across Berlin, "Kid starting out" mode (strictest):

| Engine | Avg safe infrastructure |
|---|---|
| **Family Bike Map** | **57%** |
| BRouter (safety profile) | 40% |
| Valhalla (max bike preference) | 35% |

Wins 13 out of 16 head-to-head comparisons against Valhalla, largely by finding bike-priority streets and car-free paths that Valhalla routes through painted bike lanes instead.

#### 4. The three-layer scoring architecture (in progress as of this week)

The project is mid-refactor from a Berlin-biased classifier into a portable three-layer model:

- **Layer 1 — Global baseline:** Level of Traffic Stress (LTS 1–4) classification from raw OpenStreetMap tags. Research-backed, works on any city on Earth. Defensible against CROW (Netherlands), NACTO "All Ages & Abilities" (US), ERA (Germany), LTN 1/20 (UK), Vejdirektoratet (Denmark) — all five major cycling-infrastructure design standards converge on the same two variables (motor-vehicle speed × volume) with breakpoints within ~20% of each other.
- **Layer 2 — Per-city profile:** A short English paragraph describing how that city's infrastructure behaves. "Berlin has Fahrradstraßen — prefer them. Painted bike lanes are in the door zone here — don't trust them. Cobblestones in the old town are rough on kid bikes." These prose descriptions are then compiled (by Claude Opus) into structured routing filters.
- **Layer 3 — Family preferences:** Users edit the prose. "Bea is 4 and gets tired after 3 km. Cobblestones are fine at slow speeds." The merged text is re-compiled into a family-specific filter.

The prose-as-authoring surface is the interesting part. The idea: you never ask a user to fill out a form with technical fields. You show them a paragraph about their city, let them edit it in natural English, and an LLM compiles the edits into a deterministic filter that the router consumes. No free-text routing (too unreliable); just a natural language authoring step that produces a structured, testable output.

#### 5. Research-backed calibration

Before writing any of the Layer 2 code, a team of parallel Claude research agents crawled academic papers, government design manuals, and parent blogs for 15+ cities (Amsterdam, Copenhagen, Berlin, Potsdam, Paris, London, Barcelona, Seville, Montreal, San Francisco, NYC, Mexico City, Bogotá, Tokyo, Taipei). Every source URL is preserved. Every claim is traceable.

The research produced seven distinct city archetypes — not a linear spectrum:

1. **Amsterdam** — network-complete. Optimize for bike *congestion*, not cars.
2. **Copenhagen** — curb-separated connected network, designed for 8-year-olds.
3. **Berlin** — protected infra exists but the network has gaps; cobblestones matter.
4. **SF** — a few hero corridors, spotty network, "protected" means plastic posts.
5. **Bogotá split** — Sunday Ciclovía vs. hostile Monday CicloRuta; time-of-week matters.
6. **Tokyo slow-everything** — no separation; relies on Zone 30, narrow streets, legal sidewalk riding, and high mode share. An entirely distinct archetype not captured by LTS.
7. **Taipei trunk-and-capillary** — car-free recreational backbone behind a flood wall, hostile everywhere else.

The seven-archetype model is the bridge between "one global baseline" and "hundreds of city-specific profiles." A new city inherits from its nearest archetype until its own profile lands.

See `docs/research/family-safety/` — it's all committed to the repo with sources, including 16 city profile files.

#### 6. Safety in numbers (Jacobsen 2003)

There's a separate effect baked into the scoring: as cycling mode share rises, per-cyclist crash risk falls nonlinearly (Elvik & Goel 2019 meta-analysis, pooled exponent ~0.43). About half is real driver adaptation (drivers in high-mode-share cities anticipate cyclists better), half is infrastructure confound. The app applies a damped `(reference_mode_share / local_mode_share) ^ 0.25` multiplier at the city level — a tiebreaker between otherwise-comparable routes. Copenhagen at 28% mode share is the reference; New York at 1.3% gets a ~2.2× risk penalty.

Details in `docs/research/family-safety/safety-in-numbers.md`.

### How Claude Code helped (the honest version)

This project was built over ~3 weeks of evening sessions with Claude Code as the primary engineering collaborator. A few patterns that turned out to matter:

- **Parallel research agents.** The 15-city research above was done by ~6 Claude agents running simultaneously with WebSearch and WebFetch, each handling 2–4 cities. 30 minutes of wall-clock time produced ~60 pages of sourced research that would've taken me days alone. Every URL is real; nothing is fabricated; each agent cited its sources.
- **Refactor-before-rebuild.** When it was time to rebuild the 3-mode picker into 5 modes and rip out Valhalla, Claude Code did the whole refactor in one session: renamed mode keys across 13 files, moved routing engines into a `benchmark/` subdirectory, fixed all 204 tests, built clean. The key was writing a detailed plan first (`docs/product/plans/2026-04-13-three-layer-scoring-plan.md`) and then executing against it, not just asking for code.
- **Research → code → decision log.** Every time the architecture changed, Claude Code updated the decision log (`docs/product/decisions.md`) with the *why*, not just the *what*. Future sessions (or future collaborators) can read the chain and understand trade-offs without re-litigating them.
- **Refusing to add hype.** The initial README draft had a few lines of marketing speak ("revolutionary family cycling platform") that Claude Code suggested cutting in favor of concrete numbers. The final README leads with the benchmark table. The blog draft you're reading was instructed to be conversational and specific, not aspirational.

What Claude Code is *not* great at: visual design iteration. The current UI is functional but not beautiful, and icons are all emoji placeholders right now. That's on me.

---

## 4. Call to action / wrap

### What's next (roadmap)

- **Layer 3 prose-edit UI.** Give users an in-app way to edit their city's prose and re-compile on save. (This is the main feature coming up.)
- **Multi-day trip planning.** Plan a route from Berlin to Brandenburg with overnight stops, save segments, mark which you've done and which are planned.
- **Segment sharing.** Share "we rode this route last Sunday, Bea loved it" with another family and have it appear on their map.
- **More cities beyond Berlin.** The infrastructure exists for 16 cities in code; the prose profiles need human review before they're truly trustworthy.
- **Wire up the 5 new mode icons** that were drafted this week (they're custom SVGs in `src/components/icons/modes/`, not yet in the picker).

### How others could use / fork it

- **Source on GitHub:** [github.com/fryanpan/family-bike-map](https://github.com/fryanpan/family-bike-map) — public, MIT licensed. Free to fork, remix, deploy.
- **Works anywhere OpenStreetMap has cycling tags.** Berlin has the best data coverage today but the routing works anywhere in the world.
- **Each city is a single markdown file.** Adding a new city is ~25 minutes: write a short prose description (40–80 words), compile it, commit.
- **Bring your own cycling philosophy.** Don't agree with the 5-mode framing? Edit `src/data/profiles.ts`. Don't like the Berlin classification? Edit `src/data/cityProfiles/berlin.md`. The app is explicitly designed to be opinionated and forkable.

### One-sentence wrap options (for blog-assistant to pick from)

- "Family Bike Map exists because no other routing app understood that a kid cannot tell the difference between 'bike lane' and 'bike lane' — but the ground truth between them is the difference between a safe afternoon and a terrifying one."
- "Most bike routers solve 'shortest path.' Family Bike Map solves 'path my kid can survive.'"
- "If you've ever been on Google Maps, asked for a bike route, and then watched it suggest a painted line on a main road while your 4-year-old was strapped into the seat behind you — this is for you."

---

## 5. Raw quotes and pull-able facts

### Pull quotes (concrete, specific, not generic)

> *"A painted line on a four-lane stroad is not the same thing as a car-free path through a park. Every other bike routing app treats them as equivalent."*

> *"Copenhagen designs bike infrastructure for 8-year-olds. Berlin has the infrastructure but the network has gaps. San Francisco has a few hero corridors and a lot of plastic-post paint. A family bike map has to know these are different problems."*

> *"Most bike routers use arbitrary penalty multipliers — 'this road is 1.5x worse than that one.' Family Bike Map uses realistic travel speeds instead. A kid bikes at 10 km/h on a Fahrradstraße and walks at 3 km/h on a sidewalk past a scary intersection. The math just works."*

> *"What you see is what you route on. The code that colors the map is the same code that builds the routing cost function. There is no drift."*

> *"The seven-archetype model is the bridge between 'one global baseline' and 'hundreds of city-specific profiles.'"*

> *"We don't ask users to fill out forms with technical fields. We show them a paragraph about their city, let them edit it in natural English, and an LLM compiles the edits into a deterministic filter that the router consumes."*

> *"Every source URL is preserved. Every claim is traceable. If the research is wrong, you can argue with the source, not with us."*

### Hard numbers

- **57%** — Family Bike Map's average % on safe infrastructure, Berlin benchmark
- **40%** — BRouter (safety profile), same benchmark
- **35%** — Valhalla (max bike preference), same benchmark
- **13 of 16** — head-to-head wins against Valhalla
- **10–30 ms** — typical client-side route computation time
- **30,000–60,000** — intersections in a typical city graph
- **204** — passing tests as of the 2026-04-13 refactor
- **16** — city profiles seeded (Amsterdam, Barcelona, Berlin, Bogotá, Copenhagen, London, Mexico City, Montreal, NYC, Paris, Potsdam, SF, Seville, Taipei, Tokyo, plus `_default`)
- **5** — travel modes in the picker (Kid starting out, Kid confident, Kid traffic-savvy, Carrying kid, Training)
- **~25 min** — time to add a new city once the pipeline is in place
- **3 km/h** — walking pace for kids bridging over bad infra on a sidewalk
- **~0.43** — Elvik & Goel 2019 meta-analytic exponent for safety-in-numbers; damped to 0.25 in the scorer to avoid double-counting with infrastructure

### Names and terms to define (for non-dev readers)

- **Fahrradstraße** — German for "bicycle street." Cars are allowed only as guests, bikes have priority, 30 km/h max. The gold standard for quiet streets.
- **Cargo bike / longtail / bakfiets** — bikes designed to carry kids or groceries. Bakfiets is the Dutch front-load box bike; longtail has a rear deck with seats.
- **Level of Traffic Stress (LTS 1–4)** — a standardized 4-tier scoring system from transportation engineers. LTS 1 is "suitable for children." Used by most bike network planning in North America.
- **OpenStreetMap** — the free, crowdsourced world map. Has detailed bike infrastructure tags that Google Maps doesn't expose.
- **Overpass API** — query engine that lets you ask OpenStreetMap "show me every cycleway within 2km of here."
- **Valhalla, BRouter** — two popular open-source bike routing engines. Neither understands family-specific safety preferences by default.
- **Mode share** — the percentage of all trips in a city taken by bike. Copenhagen ≈ 28%, Amsterdam ≈ 35%, Berlin ≈ 18%, NYC ≈ 1.3%.

### Story beats blog-assistant might want

1. **The "painted line" anecdote** — Google Maps suggesting Oranienstraße as bike-friendly when it's a narrow elevated path full of tree roots. Concrete, specific, unfair to Google.
2. **The "Copenhagen 8-year-old" fact** — Copenhagen's official design target is "comfortable for an 8-year-old to ride alone." That's a real design criterion. Berlin's is "children are mentioned in the 2018 Mobilitätsgesetz but it's aspirational."
3. **The "walking bridge" insight** — cost-based routing naturally chooses to walk past a scary intersection instead of riding through it, because walking 50m at 3 km/h is faster (in the cost function) than detouring 200m through traffic. It's not a hack; it's emergent from modeling reality.
4. **The parallel research agents** — 30 minutes, 15 cities, 60 pages of sourced research, 6 agents running at the same time. This is a concrete "how I actually use Claude Code" story, not a hypothetical.
5. **The "useRoads is dead" moment** — when Bryan realized the Valhalla-era `useRoads` knob was orphaned in the codebase and asked "why is this still here?" The whole Valhalla/BRouter stack got ripped out of the main app in one session, moved to a `benchmark/` folder for comparison purposes only. Small vignette, but captures the vibe of "refactor fearlessly when the tests are green."

---

## 6. Metadata for blog-assistant

- **Publish target:** 2026-04-15 EOD
- **Source repo (public):** [github.com/fryanpan/family-bike-map](https://github.com/fryanpan/family-bike-map)
- **Local path:** `/Users/bryanchan/dev/family-bike-map`
- **Live site:** [bike-map.fryanpan.com](https://bike-map.fryanpan.com)
- **License:** MIT
- **Primary author:** Bryan Chan
- **Key files to pull from** if blog-assistant wants more depth:
  - `README.md` — current user-facing pitch
  - `docs/product/vision.md` — original product vision, concrete rider profiles
  - `docs/product/architecture.md` — system diagram and tech decisions
  - `docs/research/family-safety/` — city research, standards, safety-in-numbers, archetypes
  - `docs/research/family-safety/city-profiles/berlin.md` — example city profile with sources
  - `docs/product/plans/2026-04-13-three-layer-scoring-plan.md` — the three-layer architecture plan
  - `docs/product/decisions.md` — decision log with "why" entries
  - `docs/product/region-model.md` — governance / region model thinking (deferred, interesting)
  - `docs/research/family-safety/carrying-kid-hardware.md` — cargo bike / trailer market research
- **Tone guidance:** conversational, specific, unafraid of technical detail but explains jargon when it appears. Not a deep technical dive; not marketing. Think "engineer's blog post for a curious friend."
- **Avoid:** marketing speak, superlatives without evidence, pretending the product is more polished than it is (icons are emoji placeholders, UI is functional not beautiful, coverage is best in Berlin).
- **Keep:** benchmark numbers, concrete city examples, the "painted line" anecdote, the three-layer architecture summary, the parallel-research-agents vignette.

---

## 7. Suggested outline for the final post

1. **Cold open** — the painted-line anecdote. One paragraph, one concrete failure mode. No product pitch yet.
2. **The problem** — why existing apps fail families. Three cities (Copenhagen, Berlin, SF) as evidence of how differently "safe" is defined.
3. **What it does** — core features in prose, not bullet points. Focus on the one that matters most: the router will walk past a scary intersection instead of riding through it.
4. **How it's built** — tech stack in one sentence, then the three interesting engineering decisions: client-side routing, speed-based costs, three-layer architecture. Mention Claude Code naturally as the tool, not the story.
5. **The research** — parallel agents, 15 cities, seven archetypes. One paragraph, links to the research docs.
6. **What's next and how to fork** — roadmap and MIT license mention.
7. **Sign-off** — one of the three pull-quote wrap-up options.

Estimated final length: 1,200–1,800 words. Not a deep dive.
