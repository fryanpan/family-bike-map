# Route server

A bun HTTP service that runs **the same routing code the browser runs** —
`clientRoute` from `src/services/clientRouter.ts` — over a directory of
pre-fetched/enriched tile JSONs held in memory. Part of the enriched-tiles
plan (`docs/product/plans/enriched-tiles-plan.md`, scope update §3).

There is **no routing/classification logic in this directory**. Tile JSONs
are loaded into the overpass.ts in-memory tile cache through the existing
`injectCachedTile` seam (the same seam the browser's IndexedDB warm-load
uses), so `clientRoute` finds every corridor tile in cache and never touches
the network. Mode rules, LTS classification, costing, bridge-walks — all of
it is the production `src/` code, imported directly.

## Run

```sh
bun server/route-server.ts --tiles <dir> [--port 8787] [--region <label>] [--no-elevation]
```

- `--tiles <dir>` (required) — directory of tile JSONs, loaded fully into
  memory at startup.
- `--region <label>` — name reported by `/health`; defaults to the tiles
  dir basename.
- `--no-elevation` — skip registering the bun terrain-RGB decoder. Without
  it (or without `VITE_MAPBOX_TOKEN` in the environment) elevation fails
  soft: routes get no ascent cost, same as a browser with no terrain data.

## Tile files

One file per 0.1° tile, named `<row>_<col>.json` (`row = floor(lat/0.1)`,
`col = floor(lng/0.1)`, negatives allowed — SF is `377_-1225.json`). Two
accepted shapes:

- **Enriched tile** (the pipeline's output format):
  `{"meta": {"builtFromSeq": …, …}, "ways": [{osmId, tags, coordinates, …baked fields}]}`.
  `meta.row`/`meta.col`, when present, override the filename.
- **Bare `OsmWay[]`** — `[{osmId, tags, coordinates}, …]`.

Baked enrichment fields (`gradientPct`, `accessGradientPct`,
`componentPaintedLenM`) are carried along untouched; the router ignores
them. Files that don't parse or match either shape are skipped with a
warning.

Tiles inside the region's bounding rectangle (plus a one-tile ring) that
have no file are injected as **empty** tiles — a cache hit with zero ways,
exactly like an empty Overpass response — so route corridors near coverage
gaps resolve instantly instead of waiting out clientRoute's network-retry
ladder in a runtime with no `/api/overpass` to call.

## API

### `POST /route`

```json
{
  "start": { "lat": 37.77, "lng": -122.45 },
  "end": { "lat": 37.79, "lng": -122.41 },
  "travelMode": "kid-confident",
  "preferredItemNames": ["Bike path", "Fahrradstrasse"]
}
```

- `travelMode` — one of the `MODE_RULES` keys (`kid-starting-out`,
  `kid-confident`, `kid-traffic-savvy`, `carrying-kid`, `training`).
- `preferredItemNames` (optional) — the user's legend-item toggles, sent
  per request; mode/preferences stay client-side concepts. Defaults to the
  same per-mode defaults the browser uses
  (`getDefaultPreferredItems(travelMode)`).

Responses:

| Status | Body |
|---|---|
| 200 | The exact `clientRoute` result: a `Route` JSON, or `null` when no path exists (deliberately mirrors the in-browser call's `Route \| null` contract — a `null` body is "routing worked, no path", not an error) |
| 400 | `{error}` — malformed JSON, missing/invalid `start`/`end`, unknown `travelMode`, bad `preferredItemNames` |
| 422 | `{error}` — `start` or `end` falls in a tile that isn't in the loaded region |
| 500 | `{error: "internal server error"}` — details logged server-side only, never leaked |

### `GET /health`

```json
{ "ok": true, "region": "norcal", "tilesLoaded": 812, "builtFromSeq": 12346 }
```

`builtFromSeq` is the max across loaded tiles' `meta.builtFromSeq`
(provenance from the diff updater), `null` if no tile carried one.

## Docker

See the header of `server/Dockerfile`. Build from the repo root (the image
needs `src/`), mount the tiles dir at `/tiles`. Not deployed anywhere —
the production target is a separate decision after latency data exists.

## Tests

`bun test tests/routeServer.test.ts` — contract tests over synthetic
fixture tiles, including the same-code invariant: the server's route must
be **identical (tolerance zero)** to a direct `clientRoute` call on the
same tile data.
