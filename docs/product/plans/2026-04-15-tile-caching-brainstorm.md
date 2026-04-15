# Tile caching & global availability — brainstorm findings

Consolidates a research + 4-agent parallel brainstorm on "how do we avoid making users manually cache bike data before the app works anywhere in the world." Conducted 2026-04-15 after Bryan's production review surfaced the "Download Berlin cycling data?" dialog as the main UX blocker.

## Background

The app loads bike infrastructure as 0.1° OSM tiles fetched from the public Overpass API via a Cloudflare Worker proxy. Current architecture:

- **Tile grid**: 0.1° × 0.1° (~74 km² per tile at Berlin latitude), profile-independent
- **In-memory cache**: `_tileCache` Map in `src/services/overpass.ts`, session-lifetime, never evicted
- **IndexedDB persistence**: `src/services/tileCache.ts`, stores whole *named regions* (Berlin, Copenhagen, etc.) on demand — not individual tiles
- **Edge cache**: Cloudflare Worker proxy at `/api/overpass` caches responses with `Cache-Control: public, max-age=2592000` (30-day TTL) at edge, keyed by synthetic GET URL `https://overpass-tile-cache.internal/v1/{row}/{col}`
- **Rate limiting**: `Semaphore(2)` caps concurrent Overpass fetches client-side
- **Tile cache IS the routing graph**: architecture invariant from `architecture.md:201`. The overlay display and the router share a single tile-derived data source. Any alternative data source must still produce `OsmWay[]` the classifier understands.

### What `overlayEnabled` actually does

`BikeMapOverlay` is the React component that renders the green/orange bike-infrastructure overlay on the map. Its `enabled` prop (sourced from `overlayEnabled` in `App.tsx`, hardcoded to `true` at line 214) controls an `OverlayController` that:

1. **Listens** to Leaflet `moveend` / `zoomend` / `resize` events, debounced 400 ms
2. On each event, runs `loadVisibleTiles()`:
   - Gets the visible tiles for the current bounds via `getVisibleTiles`
   - Rejects with status `'zoom'` if viewport covers more than `MAX_VISIBLE_TILES = 12` — prevents world-zoom from blowing up into thousands of requests
   - Filters to tiles that aren't already loaded or in-flight
   - Fires `fetchBikeInfraForTile` for each, gated by the semaphore
   - Writes successful responses to `tileData` state
3. On mount, pre-populates `tileData` from `_tileCache` for instant re-render of already-fetched tiles
4. Reports status to `onStatusChange`: `'idle' | 'loading' | 'zoom' | 'error' | 'ok'`. The status is shown as a user-facing message (`⏳ Loading bike map…` / `🔍 Zoom in to see bike infrastructure` / `⚠️ Could not load bike map`).

**In short**: `overlayEnabled` is a kill switch. When `true` the overlay auto-fetches visible tiles on every map interaction and shows the colored bike-infrastructure lines. When `false` it renders nothing and stops listening. As of PR #110 (the routing refactor) `overlayEnabled` is hardcoded `true` — there's no runtime toggle left; the flag exists mainly as a hook for future "hide overlay" UX.

### The surprising finding

**Viewport-driven auto-fetch is already 80% built.** The `OverlayController` already handles `moveend` / `zoomend` events, debounces, respects `MAX_VISIBLE_TILES`, and goes through the `Semaphore(2)` rate limiter. Bryan can already pan around anywhere in the world with `overlayEnabled = true` and tiles will lazy-fetch on demand, subject to zoom level.

The "Download Berlin cycling data?" dialog that PR #113 removed was **not** gating the auto-fetch. It was a separate path that persisted a whole named region to IndexedDB for offline use. Removing it didn't break the overlay — it just removed a confusing prompt that wasn't actually required for the overlay to work.

So the "global availability" question is mostly already solved. What's left is polish:

- Repeat visits re-fetch tiles from scratch (no per-tile IndexedDB persistence)
- First visit to a new area has a brief "loading" period before the overlay appears
- No visual signal to distinguish "still loading" from "no infrastructure here"

## Four-agent brainstorm

Four parallel Sonnet agents explored different angles. Summary of each:

### Agent A — Client-side smart fetch strategies

Explored viewport auto-fetch, corridor pre-fetch, service worker cache, progressive LOD, Web Worker parsing, predictive pre-fetch, and lazy IndexedDB persistence.

**Key insight**: The viewport auto-fetch is already built; the dialog was the only thing blocking global usage.

**Ranked recommendation**:
1. Enable viewport auto-fetch by default — 2–3 hrs — **already done by PR #113**
2. Lazy IndexedDB per-tile persistence — 4–6 hrs — repeat visits become instant
3. Corridor pre-fetch on destination pick — 3–4 hrs — routing feels instant
4. Service Worker cache for offline — 6–8 hrs — survives Cloudflare outages
5. Skip: predictive ring fetch (3× load on Overpass), progressive LOD (marginal savings), Web Worker parsing (parser isn't the bottleneck)

### Agent B — Server-side data pipeline strategies

Explored PMTiles, self-hosted Overpass, R2 pre-rendered tiles, Protomaps, Overture Maps, PostGIS vector tile server, hybrid Worker + R2, and osmium diff pipelines.

**Key insight**: The "tile cache IS the routing graph" invariant rules out most rendering-oriented alternatives (Protomaps, OpenMapTiles, Mapbox, Overture) because they flatten OSM tags into schemas that drop `bicycle_road`, `cycleway=track vs lane`, `motor_vehicle=destination`, and surface detail.

**Ranked recommendation**:
1. **R2 + nightly JSON blobs** (5–7 person-days) — regional pipeline first (Germany via Geofabrik, 3.6 GB PBF), global later via Planet file. One JSON file per 0.1° tile matching the existing client schema. Client URL swap is literally one line. Zero classifier changes.
2. Hybrid Worker + R2 fast path (3–4 days) — Worker checks R2 before forwarding to Overpass; pre-warmed popular cities are free, cold tiles fall through to Overpass
3. Self-hosted Overpass (3–5 days) — solves rate-limiting but explicitly rejected earlier for ops burden
4. Reject: Protomaps, Overture, OpenMapTiles, PostGIS tile server, Mapbox — all break tag fidelity. osmium diff pipeline — correct for real-time freshness but tiled diff invalidation is a swamp.

### Agent C — Alternative data sources

Evaluated every major OSM-derived data source against the specific tags `classifyEdge` reads: `highway`, `cycleway` (+ `:right` / `:both`), `maxspeed`, `lanes`, `surface`, `bicycle_road`, `cyclestreet`, `bicycle`, `motor_vehicle`, `access`.

**Key finding**: Only two sources preserve full tag fidelity — raw OSM (via Overpass, Planet file, or Geofabrik extracts). Every curated schema (Protomaps, Overture, OpenMapTiles, Mapbox) drops at least one tag the classifier depends on.

**Ranked recommendation**:
1. **Geofabrik regional extract + tilemaker → PMTiles on R2** — top pick, near-term. Germany extract is 850 MB, nightly updates, ~$5/mo R2 hosting. Whitelist the 10 tags we care about. Zero classifier changes.
2. **OSM Planet + tilemaker** — same pipeline scaled global. ~$15–25/mo. Add once Berlin proves the model.
3. **Overture Maps** — monitor, not adopt. Apache 2.0 license is nice but the schema is missing Fahrradstraße and `cycleway` subtypes as of April 2026. Check quarterly.

Everything else fails the tag fidelity test.

### Agent D — Hybrid and novel approaches

Explored Bloom filters, density bitmaps, crowd-warming edge cache, speculative cache from route logs, progressive detail by zoom, LLM-summarized bike networks, partial corridor fetch, tile quality signals, Durable Object shared caches, OSM diff subscribers, ML pre-fetch, and graceful display degradation.

**Key insight**: The most novel and highest-leverage angle is **progressive detail by zoom** — at city zoom, serve a pre-rendered PMTiles file containing only LTS 1 ways (Fahrradstraßen, car-free paths) from a static global artifact. At street zoom, fall back to the existing tile fetch. This reframes the problem from "caching" to "rendering contract per zoom level" and eliminates the blank-map-at-world-zoom problem globally without any client intelligence.

**Ranked recommendation**:
1. **Progressive detail by zoom** (3–4 days) — pre-rendered LTS 1 PMTiles for city zoom; existing fetch at street zoom
2. **Density bitmap pre-fetch prioritization** (1–2 days) — ~50–80 KB global bitmap shipped in bundle, skips fetches for empty tiles
3. **Crowd-warming edge cache** (0.5 days) — add explicit `Cache-Control` headers to browser response (with caveat: POST response caching is limited)
4. **Graceful display degradation** (2–4 hours) — subtle "loading" / "no data" patterns instead of blank overlay
5. **Tile quality signals + corridor freshness** (1–2 days) — `fetchedAt` timestamps per tile, surgical re-fetch only for stale tiles along a corridor
6. **Skip**: Bloom filters (density bitmap does the same job simpler), Durable Objects (overkill), OSM diff subscribers (tiled diff invalidation is hard), ML pre-fetch (premature), LLM summaries (too imprecise for navigation)

## Synthesis — consolidated tier list

Tiers ranked by effort-to-impact ratio, drawing from all four agents.

### Tier 1 — This week, low-risk polish

| Item | Effort | Source | Status |
|---|---|---|---|
| Remove auto-show download dialogs | 2 hrs | A#1 | ✅ **Done in PR #113** |
| Verify `overlayEnabled` defaults to `true` | 15 min | A#1 | ✅ **Confirmed** — hardcoded `true` at `App.tsx:214` |
| **Lazy per-tile IndexedDB persistence** | 4–6 hrs | A#2 | ⏳ **This PR** |
| Graceful degradation display polish | 2–4 hrs | D#6 | Already partially in place via overlay status messages |

### Tier 2 — Next 1–2 weeks for bigger wins

| Item | Effort | Source |
|---|---|---|
| Corridor pre-fetch on destination pick | 3–4 hrs | A#3 |
| Density bitmap pre-fetch prioritization | 1–2 days | D#2 |
| Service Worker cache (for offline) | 6–8 hrs | A#4 |
| Crowd-warming Cache-Control headers | 0.5 days | D#4 — deferred due to POST limitation |

### Tier 3 — Only if Overpass becomes a real bottleneck

| Item | Effort | Source |
|---|---|---|
| **R2 + nightly JSON blobs (Geofabrik)** | 5–7 person-days | B#3, C#1 (convergent pick) |
| OSM Planet + tilemaker → PMTiles | 1 person-week | C#2 |
| Progressive detail by zoom (LTS 1 PMTiles) | 3–4 days | D#3 |

Tier 3 is the *clean long-term answer* but shouldn't be rushed. Tier 1 may make it unnecessary for months. Revisit when:
- Overpass public-instance reliability degrades
- We want to eliminate rate-limit dependency entirely
- Multi-city demos start hitting cold-tile latency
- Cost of Overpass reliance becomes visible in user reports

### Tier 4 — Skip or monitor

- **Protomaps / OpenMapTiles / Mapbox / Overture (as drop-in data source)** — all drop `bicycle_road`, `cycleway` subtypes, or `motor_vehicle=destination` from their schemas. Classifier breaks.
- **Self-hosted Overpass** — operational complexity explicitly rejected earlier. Only if public Overpass becomes unreliable.
- **LLM summaries for uncached cities** — too imprecise for navigation.
- **Bloom filters** — density bitmap does the same job with simpler math.
- **Durable Objects shared cache** — overkill at current scale.
- **ML pre-fetch** — premature.

### What the agents agreed on

1. **The dialog was gating the wrong layer.** The viewport auto-fetch works globally as long as `overlayEnabled=true`. Removing the dialog was the only technically-required change.
2. **Per-tile IndexedDB persistence is the highest-value remaining quick win.** Agents A and D both flagged it. ~5 hours of work; repeat visits to any area become instant.
3. **If we go long-term, go R2 + tilemaker-built PMTiles.** Agents B and C independently converged on this. Preserves tag fidelity, eliminates Overpass dependency, runs for ~$5/mo on R2.
4. **Flatten-schema data sources (Protomaps, Overture, Mapbox) all fail the classifier's tag requirements.** This is a hard ceiling — don't waste time evaluating them further unless one of them explicitly adds `bicycle_road=yes` support.

## Concrete recommendation for this session

1. **Write this brainstorm doc** — done (this file).
2. **Explain `overlayEnabled` to Bryan** — done (in the "What overlayEnabled actually does" section above).
3. **Ship Tier 1 #3 — lazy per-tile IndexedDB persistence** as PR #114. New IDB store keyed by `row:col`, 7-day TTL, silent write on every successful tile fetch, silent read on every `fetchBikeInfraForTile` cache miss, age-based eviction. Keep the existing named-region store intact for power users who still want pre-cached offline regions.
4. **Defer the R2 pipeline** until Tier 1 is proven insufficient. Estimated that's several weeks or months away unless Overpass reliability degrades.

## Open questions

1. **Storage budget for per-tile IDB.** A Berlin tile is ~50 KB JSON; the whole city is ~100 tiles ~5 MB; a heavy user could accumulate 50–200 MB over time across international travel. Cap total storage? Evict oldest first when over budget?
2. **Freshness policy.** 7 days is reasonable for bike infrastructure but arbitrary. Consider 30 days to match edge cache, since OSM bike edits are infrequent.
3. **Worker header policy.** Should the worker tag cached responses with `Cache-Control: public, max-age=2592000` on the browser-facing response too, not just on the edge-cached synthetic GET? Currently the browser has no HTTP cache entry for these because they're POST and the outbound response headers are just `Content-Type` + `X-Cache`. Low priority since lazy IDB persistence replaces the need for browser HTTP cache.
4. **Status message UX.** The "⏳ Loading bike map…" message reads well but doesn't reassure the user that it will eventually work — could be mistaken for a permanent error. Consider adding progress (e.g. "Loading 4/12 tiles…") once multi-tile fetches become common.

## References

- `src/components/BikeMapOverlay.tsx` — viewport auto-fetch implementation (`OverlayController`)
- `src/services/overpass.ts` — tile fetch + in-memory cache + semaphore
- `src/services/tileCache.ts` — existing IndexedDB region-store (what the banner used to populate)
- `src/worker.ts` — Cloudflare Worker Overpass proxy with 30-day edge cache
- `docs/product/architecture.md` — "tile cache is the routing graph" invariant
- `docs/product/decisions-client-router.md` — client-side A* router decision, April 2026
- `docs/research/existing-tools.md` — InfraVelo and alternative map tools review
- Peter Furth LTS criteria page — external anchor cited in `docs/research/family-safety/standards.md`
