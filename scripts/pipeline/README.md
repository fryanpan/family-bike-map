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

## Tests

```sh
bun test tests/pipeline/
```

Fixtures are hermetic: a hand-written `.osm` extract (converted with
osmium on first run), synthetic `.osc` change files, and an injected fake
DEM fetch. No network.
