#!/usr/bin/env bash
# Daily enriched-tile update for a region (the cron entry point).
#
# Flow (details + dependencies: scripts/pipeline/README.md):
#
#   1. pyosmium-get-changes downloads every replication diff published since
#      the region PBF was built — it reads the replication base URL +
#      sequence from the PBF header (Geofabrik extracts carry both) — into
#      ONE aggregated .osc, and prints the newest sequence number to stdout.
#   2. apply-diff.ts gates that sequence against the tile dir's
#      region-state.json, applies the .osc (osmium apply-changes),
#      re-enriches through the production bake, rewrites ONLY tiles whose
#      content changed (bumping meta.builtFromSeq), deletes emptied tiles,
#      and writes the updated PBF to $REGION_PBF.next.
#   3. The PBF is rotated only after a fully successful apply, so a failed
#      run leaves both the PBF and the tile dir at the previous sequence
#      and the next run simply retries.
#
# --allow-gap is required on this path because the aggregated .osc jumps
# several sequences after a skipped day. When applying hand-downloaded
# Geofabrik daily files one at a time instead
# (https://download.geofabrik.de/north-america/us/california/norcal-updates/),
# call apply-diff.ts once per sequence WITHOUT --allow-gap — the strict
# base+1 gate then catches an out-of-order or skipped file; or merge several
# with `osmium merge-changes --simplify` and pass the newest sequence with
# --allow-gap.
#
# Cron (03:00 daily, after Geofabrik's daily diff lands; run from repo root):
#   0 3 * * * cd $HOME/dev/family-bike-map && ./scripts/pipeline/update-region.sh >> data/update-region.log 2>&1

set -euo pipefail

REGION_PBF="${REGION_PBF:-data/norcal.osm.pbf}"
TILE_DIR="${TILE_DIR:-data/tiles}"
DIFF_DIR="${DIFF_DIR:-data/diffs}"
DEM_CACHE="${DEM_CACHE:-data/dem-cache}"

if [ ! -f "$REGION_PBF" ]; then
  echo "region PBF not found: $REGION_PBF (run the initial enrich-region bake first)" >&2
  exit 1
fi

mkdir -p "$DIFF_DIR"
OSC="$DIFF_DIR/$(date -u +%Y%m%dT%H%M%SZ).osc"

# pyosmium-get-changes prints the newest downloaded sequence number.
# Non-zero exit: network failure, no replication header in the PBF, or
# (exit 3) no new diffs available yet.
if ! SEQ="$(pyosmium-get-changes -O "$REGION_PBF" -o "$OSC")"; then
  status=$?
  rm -f "$OSC"
  if [ "$status" -eq 3 ]; then
    echo "[update-region] no new diffs available; region already up to date"
    exit 0
  fi
  echo "[update-region] pyosmium-get-changes failed (exit $status)" >&2
  exit "$status"
fi

echo "[update-region] fetched diffs up to seq $SEQ -> $OSC"

bun scripts/pipeline/apply-diff.ts \
  --pbf "$REGION_PBF" \
  --osc "$OSC" \
  --state "$SEQ" \
  --tiles "$TILE_DIR" \
  --out-pbf "$REGION_PBF.next" \
  --allow-gap \
  --dem-cache "$DEM_CACHE"

# Rotate the PBF only after a fully successful apply.
mv "$REGION_PBF.next" "$REGION_PBF"
echo "[update-region] region updated to seq $SEQ"
