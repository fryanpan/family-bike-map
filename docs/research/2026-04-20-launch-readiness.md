# Launch-Readiness Review — 2026-04-20

Audit of security and scalability concerns before the Tue Apr 21 public launch
of bike-map.fryanpan.com. Scope: Cloudflare Worker (`src/worker.ts`), client
fetches to `/api/*`, exposed `VITE_*` env vars, Mapillary + Overpass client
usage, persistence surface (KV, D1, IndexedDB).

TL;DR: one P0 (publicly writable classification rules), three P1s (no input
caps on feedback/route-log/route-logs), the rest is P2/monitoring.

## P0 — block launch until fixed

### PUT /api/rules/:region is publicly writable

`src/worker.ts:193` accepts `PUT /api/rules/:region` with **no auth check, no
origin check, no token header**. The JSON body is written directly to
`CLASSIFICATION_RULES` KV under `rules:<region>`. `src/App.tsx:296` reads that
KV on every page load and feeds it into the routing classifier. Anyone who
sends

```
curl -X PUT https://bike-map.fryanpan.com/api/rules/berlin \
  -H 'content-type: application/json' \
  -d '{"rules":[],"legendItems":[]}'
```

wipes Berlin's live ruleset. The app falls back to empty overrides and
routing quality silently degrades for every user. Recovery requires someone
to re-`PUT` a good snapshot — we don't keep a local copy in the repo today.

**Fix options (any one is enough before launch):**
1. Short-term, low-effort: put the endpoint behind a bearer-token secret. Add
   `CLASSIFICATION_RULES_WRITE_KEY` via `wrangler secret put`, check
   `Authorization: Bearer <key>` on PUT, return 401 otherwise. The admin UI
   stores the key in `localStorage` on the maintainer's browser.
2. Slightly more robust: disable PUT in production entirely and restrict the
   Audit UI to the dev environment. The KV still seeds from a committed JSON
   snapshot in the repo.

Either way — **also ship a one-off `wrangler kv:key get "rules:berlin"` dump
into the repo today** so the current state is version-controlled and
recoverable.

## P1 — fix this week, ideally before launch

### Feedback endpoint accepts unbounded text

`handleFeedback` (`src/worker.ts:254`) does not cap the length of
`text`, `annotations[].text`, `author`, or `pageUrl`. A single request with a
10 MB body fills KV (25 MB value cap) and then tries to POST it to Linear
GraphQL (which will reject — but not before the request has been logged and
tried). No rate limit either.

**Fix:** cap `text` at 10 KB, each annotation at 1 KB, total annotations
array ≤ 20, reject oversized bodies with 413. Optional but cheap: require
`Content-Length < 50 KB` up front.

### /api/route-log accepts unbounded writes with no rate limiting

`src/worker.ts:221` writes arbitrary JSON fields into D1 `route_logs` with no
cap on frequency or payload. An attacker can fill the DB with bogus rows.
Same concern as feedback.

**Fix:** Cloudflare Workers has a [Rate Limiting API](https://developers.cloudflare.com/workers/platform/rate-limiting/)
binding — add a 10 req/min/IP limit to `/api/route-log`, `/api/feedback`,
`/api/segment-feedback`, and `/api/rules/:region` PUT. Alternative: basic
in-memory IP set with short TTL (leaks to other edge locations but still
raises the bar).

### GET /api/route-logs has no upper limit on ?limit=

`src/worker.ts:242`: `const limit = parseInt(url.searchParams.get('limit') ?? '50')`
with no cap. `?limit=9999999999` issues an unbounded D1 SELECT. This is also
unauthenticated — anyone can read every route anyone has ever run.

**Fix:** clamp to `Math.min(parsedLimit, 500)`. Separately consider whether
this endpoint should be public at all — the admin UI is the only consumer
today; lock it behind the same bearer-token key as PUT /api/rules.

## P2 — follow-up, not launch-blocking

### Mapillary token is in the client bundle — RESOLVED 2026-04-21

**Original claim was wrong.** The earlier doc said Mapillary client-tokens are
"referrer-locked" and that the launch checklist just needed to confirm the
scope in the Mapillary dashboard. That mitigation is not possible:
Mapillary client tokens have permission scopes (`read` / `write` / `upload`)
but **no domain / referrer allowlist mechanism**. Once shipped in the client
bundle, anyone could copy the token and use it on any site.

**Fix:** the token moved to a Cloudflare Worker secret (`MAPILLARY_TOKEN`)
and the client now calls `/api/mapillary/*` through the Worker, which
injects the token server-side and edge-caches the response for 7 days.
See `src/worker.ts` Mapillary proxy section. `VITE_MAPILLARY_TOKEN` is
deleted from the build environment (`.github/workflows/deploy.yml`,
`.env.example`).

### No CORS / origin pinning on the Worker

Every `/api/*` route returns without a `Access-Control-Allow-Origin` header
and doesn't check the `Origin` header. Any third-party site can embed
bike-map's APIs in a browser and use them as a free Overpass/Valhalla/Linear
proxy. Mitigation is low-priority because the upstream limits apply too, but
it's worth adding a Worker-level origin allowlist for POST/PUT endpoints
after launch.

### D1 route_logs has no retention policy

Every routed trip is kept forever. At the current ~10 rides/day this is
negligible, but if launch drives to ~500/day over a year the table hits
~180 K rows. D1 can handle that trivially but an index + a 12-month
`DELETE FROM route_logs WHERE timestamp < date('now', '-1 year')` cron is
cheap to add once the rate is known.

### Mapillary IDB cache is unbounded

`src/services/mapillaryCache.ts` writes without a max entry count. A user who
taps many segments over weeks could accumulate MBs of cache. 7-day TTL helps
(entries expire on read), but there's no cap on the store size. On tight
mobile storage this could bloat before TTLs kick in. Low priority — worst
case is the browser evicts the whole IDB.

### Overpass proxy accepts any POST body

`/api/overpass` forwards whatever body the client sends. Malicious traffic
could issue expensive Overpass queries (e.g. giant bbox) and evict the 30-day
cache. The cache key is `row/col` query-string only, so two different
bodies with the same `row/col` collide — first write wins. That's
actually a safety feature (the 30-day entry is sticky) but it means a bad
actor can poison a tile with a junk response. Defense-in-depth: validate
the body is a valid Overpass query matching our expected pattern before
forwarding.

## Scalability: green-light points

- **Overpass edge cache** (`src/worker.ts:97`) is the single biggest launch
  protection. 30-day shared edge cache on the OSM-tile query means Overpass
  gets hit only on cache-miss per tile per month. At launch scale (thousands
  of users in Berlin + SF) this is ~hundreds of Overpass requests/month, not
  thousands/day.
- **Routing is client-side** (`src/services/clientRouter.ts`). No server CPU
  per route; the Worker is only a static-asset + proxy layer.
- **Mapillary IDB cache + 429 backoff** (shipped in 895c75e) eliminates the
  launch-day risk of the Mapillary API rate-limiting the whole user base at
  once.
- **Feedback KV fallback** (shipped in 865855b) means a Linear outage or
  unconfigured secrets never cause a user-visible error. All feedback
  survives even in the degenerate configuration.

## Launch-day monitoring

- Cloudflare observability is enabled (`wrangler.toml:25`). Worker errors +
  requests/sec are visible in the CF dashboard. Watch these tabs on launch:
  - Workers > family-bike-map > Logs (live tail for errors)
  - Workers > family-bike-map > Metrics (requests by route)
  - KV > CLASSIFICATION_RULES (feedback key count, rule writes)
  - D1 > bike-route-logs (row count)
- Sentry DSN is configured client-side (`VITE_SENTRY_DSN` in `src/sentry.ts`).
  Confirm DSN is set in the prod `.env` before building — easy to forget.

## Recommended actions before Tue launch

In priority order:

1. **Gate `PUT /api/rules/:region`** behind a bearer-token secret (P0). ~15
   min of Worker code + one `wrangler secret put`.
2. **Dump current `rules:berlin` KV value into the repo** as
   `data/classification-rules/berlin.json`. Recovery artifact. ~5 min.
3. **Clamp `/api/route-logs?limit=` to max 500** and gate the GET behind the
   same bearer-token (P1). ~10 min.
4. **Cap feedback body size** (P1). Reject if `text` > 10 KB or
   `annotations.length` > 20. ~10 min.
5. Everything else in this document is post-launch.

Steps 1-4 together are ~45 minutes of code and are worth doing Monday
evening. Nothing here blocks the core routing or map UX.

## What was checked

- `src/worker.ts` — all `/api/*` routes, auth, input validation, caps
- `src/services/mapillary.ts` + `src/services/mapillaryCache.ts` — token
  exposure, rate-limit handling, cache bounds
- `src/services/rules.ts`, `src/services/routeLog.ts`,
  `src/services/audit.ts`, `src/services/overpass.ts` — client call sites
- `wrangler.toml` — KV/D1 bindings, compatibility flags, observability
- `.env.example` — documented envs; confirmed secrets are Worker-only
- grep for `import.meta.env.VITE_` — only DSN, Mapillary, Calendly (all
  intended-public)
- grep for hardcoded secrets (`sk-|AIza|ghp_|xoxb-|eyJ`) — clean (done in
  the README/LICENSE pass earlier today)
