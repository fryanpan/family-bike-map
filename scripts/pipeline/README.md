# Enriched-tiles pipeline

Offline bake of the browse-map's expensive per-way numbers (gradient,
minimax access gradient, painted-component length) into 0.1° tile JSONs,
plus a daily updater that keeps them current from Geofabrik replication
diffs. Part of `docs/product/plans/enriched-tiles-plan.md`.

Everything that decides a number is a **production import**
(`classifyEdge`, `computeWayGradientPct` / `lookupElevation`,
overpass.ts's tile grid and filters) — there is no pipeline-local
classifier or gradient formula. See the headers of `lib/*.ts`.

## Dependencies

```sh
brew install osmium-tool   # required: PBF filter/extract/OPL dump + apply-changes
brew install pyosmium      # daily updater only: pyosmium-get-changes
                           # (alternative: pipx install osmium)
```

Linux: `apt install osmium-tool pyosmium` (or `pip install osmium`).

Large inputs (source PBFs, DEM tiles, diffs, baked tiles) live under
`data/`, which is fully gitignored.

## Initial bake

```sh
# 1. Fetch the region extract (Geofabrik PBFs carry the replication
#    header the pipeline uses for builtFromSeq provenance).
curl -L -o data/norcal.osm.pbf \
  https://download.geofabrik.de/north-america/us/california/norcal-latest.osm.pbf

# 2. Bake. DEM tiles (AWS Terrain Tiles, open data) are fetched over HTTP
#    and cached under data/dem-cache so re-bakes are network-free.
bun scripts/pipeline/enrich-region.ts --pbf data/norcal.osm.pbf --out data/tiles
```

Useful flags: `--bbox south,west,north,east` (clip), `--no-dem` (skip the
gradient bake), `--built-at ISO` / `--seq N` (pin provenance for
byte-reproducible output).

### Large regions (statewide) — bake in latitude halves

`enrich-region.ts` holds every bike-relevant node coordinate for the whole
input in one in-memory `Map`, so a single-pass bake of a full state PBF
(e.g. all of California, ~90M nodes) OOMs the ~4 GB JS heap. Split at an
integer tile-row boundary (tiles are 0.1°, so lat 35.0 = row 350), bake each
half within heap, then merge by row seam:

```sh
bun scripts/pipeline/enrich-region.ts --pbf data/california.osm.pbf \
  --out data/tiles/ca-north --bbox 35.0,-124.6,42.05,-114.0
bun scripts/pipeline/enrich-region.ts --pbf data/california.osm.pbf \
  --out data/tiles/ca-south --bbox 32.4,-124.6,35.0,-114.0
bun scripts/pipeline/merge-tile-halves.ts \
  --north data/tiles/ca-north --south data/tiles/ca-south \
  --seam-row 350 --out data/tiles/california
```

Both bakes use osmium complete-ways extraction, so a way crossing the seam
spills a sparse boundary tile into the other half; `merge-tile-halves.ts`
takes each tile from its authoritative side only (row ≥ seam → north,
row < seam → south), so every segment is stored exactly once. A
`spillover-fallback 0` line in the merge output confirms a clean seam.

## Overview level (1.0° cells, browse zoom < 12)

The overlay's coarse level. Below `OVERVIEW_MAX_ZOOM` (z12) the client fetches
1.0° cells instead of 0.1° tiles, so a NorCal-scale view covers the WHOLE
viewport with a handful of requests instead of 64 full-detail tiles around the
cursor. Baked FROM an already-baked 0.1° tile dir — no PBF, no DEM, seconds:

```sh
bun scripts/pipeline/bake-overview.ts --tiles data/tiles/california
# → data/tiles/california/overview/<row>_<col>.json   (row/col = integer degrees)
```

Flags: `--out <dir>` (default `<tiles>/overview`), `--tolerance 0.001` (DP, in
degrees), `--min-length 200` (metres, post-simplification).

Two deliberate reductions, both DISPLAY-only (the router never reads these
tiles — it keeps using 0.1° tiles via `fetchBikeInfraForTile`):

1. **Bike-infrastructure network only** — ways where the production
   `classifyEdge` yields `carFree || bikePriority || bikeInfra`. Plain quiet
   residential is excluded: at z10 one pixel ≈ 150 m, so painting every
   residential street is a colour wash that answers no question.
2. **Simplified geometry** — Douglas-Peucker at ~0.001° (~110 m), then drop
   ways shorter than 200 m post-simplification (sub-pixel at overview zoom).

Ways keep their **full tags and enriched fields**, so the client runs the same
classifier and the same visibility gates on an overview way as on a detail way.

Size: the bake prints raw AND gzipped bytes per cell. Measured on the Bay Area
bake (2026-07-12): the two densest SF cells are 2.7 MB / 2.1 MB raw (over the
1.5 MB raw budget) but **428 KB / 313 KB gzipped**, which is what the wire
carries. Tightening `--tolerance` is a weak lever (DP already leaves ~2.6 points
per way; 0.001° → 0.003° moved the worst cell 2.7 → 2.5 MB) — the payload is
tags + JSON scaffolding. If raw size must come down, use `--min-length`. Never
strip tags: that would fork the classifier's inputs between the two levels.

Upload: the `overview/` subdir rides along with the normal upload (below) under
the SAME version prefix (`<version>/overview/<row>_<col>.json`) and the SAME
manifest — so `--rollback-to` reverts both levels in one write.

A region with no overview bake (Berlin) simply 404s on `/api/overview`, and the
client falls back to the 0.1° path — exactly today's behaviour at every zoom.

## Daily updates

```sh
./scripts/pipeline/update-region.sh
```

Cron: `0 3 * * * cd $HOME/dev/family-bike-map && ./scripts/pipeline/update-region.sh >> data/update-region.log 2>&1`

The script fetches all pending Geofabrik diffs into one .osc
(`pyosmium-get-changes`), then runs `apply-diff.ts`, which:

- **gates the sequence** — the tile dir's `region-state.json` (or the
  uniform `builtFromSeq` of a fresh bake) must be exactly one behind the
  .osc's target sequence; `--allow-gap` accepts an aggregated multi-day
  .osc; anything else refuses;
- applies the .osc to the PBF (`osmium apply-changes`) and re-enriches
  through the same production bake as the initial run;
- **rewrites only tiles whose content changed** (dirty ways = tag /
  geometry / gradient edits, creations, deletions — a node move dirties
  the ways that reference it; rippled ways = component-scoped
  invalidation where only `accessGradientPct` / `componentPaintedLenM`
  moved), bumping `meta.builtFromSeq` on those tiles and leaving the rest
  byte-identical so an R2 sync uploads only the delta;
- records the new sequence in `data/tiles/region-state.json` and writes
  the updated PBF for the next run.

The re-enrichment is region-wide by design: the minimax mainland seed is
a global decision, and the DEM disk cache makes the re-bake network-free.
Run the updater with the **same DEM settings** as the original bake
(default `--dem-cache data/dem-cache`; a `--no-dem` update of a
DEM-baked dir would re-grade every way to null and rewrite everything).

## Serving: R2 upload, manifest cutover, rollback

Baked tiles are served by the production Worker from the
`bike-map-enriched-tiles` R2 bucket (binding `ENRICHED_TILES` in
`wrangler.toml`, logic in `src/workerEnrichedTiles.ts`). On a tile
request (`/api/overpass?row=&col=`) the Worker first looks for
`<version>/<row>_<col>.json` in R2; on any miss — no manifest, no
object, R2 error — it falls through to the Overpass proxy unchanged,
so non-enriched regions (Berlin until its bake) keep working.

Bucket layout:

```
manifest.json                                ← names the ACTIVE version ({"version": "..."})
2026-07-03-seq2776/377_-1223.json            ← 0.1° detail tiles (one tileset per version prefix)
2026-07-03-seq2776/…
2026-07-03-seq2776/overview/37_-123.json     ← 1.0° overview cells (same version, same manifest)
2026-07-03-seq2776/overview/…
```

### Upload (atomic cutover)

```sh
bun scripts/pipeline/upload-tiles.ts --tiles data/tiles/bayarea-core
```

Uploads every tile under a NEW version prefix (default
`<date>-seq<builtFromSeq>`; override with `--version`), then writes
`manifest.json` LAST — readers only ever see a complete tileset, and a
failed run aborts *before* the manifest so the previously active
version stays live (re-run to resume; puts are idempotent). Flags:
`--dry-run` (print the plan), `--concurrency N` (default 4),
`--bucket` (default `bike-map-enriched-tiles`).

The Worker caches the manifest in isolate memory for 60s
(`MANIFEST_TTL_MS`), so a cutover propagates within about a minute.
Tile bodies are deliberately not edge-cached — that would stretch the
rollback window past the manifest TTL.

### Rollback

Point the manifest back at the previous, still-uploaded prefix — no
deploy, no re-upload:

```sh
bun scripts/pipeline/upload-tiles.ts --rollback-to 2026-07-02-seq2740
```

Old version prefixes are kept until you prune them manually (they ARE
the rollback targets). Prune with `wrangler r2 object` once a version
is no longer a plausible rollback target.

### Local dev

`wrangler dev --local` uses miniflare's local R2 (`.wrangler/state`).
Seed it with `--local`:

```sh
bun scripts/pipeline/upload-tiles.ts --tiles data/tiles/bayarea-core --local
bunx wrangler dev --port 8791 --local
curl -s -D - -X POST 'http://localhost:8791/api/overpass?row=377&col=-1223' --data 'data='
# → 200 with X-Tile-Source: enriched, X-Enriched-Version: <version>
curl -s -D - 'http://localhost:8791/api/overview?row=37&col=-123' -o /dev/null
# → 200 with X-Tile-Source: overview  (404 if the dir had no overview/ subdir)
```

Seeding the overview level locally is also what unblocks the render-check
`overview-coverage` scenarios (z9/z10/z11) — see `scripts/render-checks/README.md`.

Without seeded local objects every request takes the Overpass proxy
path, same as before enriched tiles existed.

## Tests

```sh
bun test tests/pipeline/                    # bake + diff + upload planning
bun test tests/workerEnrichedTiles.test.ts  # Worker-side R2 serving logic
```

Fixtures are hermetic: a hand-written `.osm` extract (converted with
osmium on first run), synthetic `.osc` change files, and an injected fake
DEM fetch. No network.
