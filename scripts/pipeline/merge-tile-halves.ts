/**
 * Merge two bbox-clipped tile bakes that partition a region at an integer
 * tile-row seam. Tiles are 0.1 deg; filename is "<row>_<col>.json" where
 * row = round(lat*10). Both bakes use osmium complete-ways extraction, so a
 * way crossing the seam latitude spills geometry into the OTHER half's row
 * (that half re-emits a sparse boundary tile). To keep every segment stored
 * exactly once, we take each tile from its AUTHORITATIVE side only:
 *
 *   row >= seamRow  -> north bake   (authoritative for lat >= seam)
 *   row <  seamRow  -> south bake   (authoritative for lat <  seam)
 *
 * A tile present only as spillover on the non-authoritative side (absent on
 * the authoritative side) is taken as a fallback so no data is dropped.
 *
 * Usage:
 *   bun scripts/pipeline/merge-tile-halves.ts \
 *     --north data/tiles/ca-north --south data/tiles/ca-south \
 *     --seam-row 350 --out data/tiles/california
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'

function rowOf(file: string): number {
  return parseInt(file.split('_')[0], 10)
}

function main(): void {
  const { values } = parseArgs({
    options: {
      north: { type: 'string' },
      south: { type: 'string' },
      out: { type: 'string' },
      'seam-row': { type: 'string' },
    },
  })
  const north = values.north
  const south = values.south
  const out = values.out
  const seamRow = Number(values['seam-row'])
  if (!north || !south || !out || !Number.isFinite(seamRow)) {
    throw new Error('required: --north <dir> --south <dir> --out <dir> --seam-row <int>')
  }

  // New statewide coverage is a superset of any prior clip, so every existing
  // tile filename is overwritten below; no stale-orphan cleanup is needed.
  fs.mkdirSync(out, { recursive: true })
  const northFiles = new Set(fs.readdirSync(north).filter((f) => f.endsWith('.json')))
  const southFiles = new Set(fs.readdirSync(south).filter((f) => f.endsWith('.json')))
  const all = new Set([...northFiles, ...southFiles])

  let fromNorth = 0
  let fromSouth = 0
  let fallback = 0
  for (const file of all) {
    const authoritative = rowOf(file) >= seamRow ? 'north' : 'south'
    const authDir = authoritative === 'north' ? north : south
    const authHas = authoritative === 'north' ? northFiles.has(file) : southFiles.has(file)
    let srcDir: string
    if (authHas) {
      srcDir = authDir
      if (authoritative === 'north') fromNorth++
      else fromSouth++
    } else {
      // Only present as spillover on the non-authoritative side — keep it.
      srcDir = authoritative === 'north' ? south : north
      fallback++
    }
    fs.copyFileSync(path.join(srcDir, file), path.join(out, file))
  }

  console.log(
    `[merge] ${all.size} tiles -> ${out} ` +
      `(north-authoritative ${fromNorth}, south-authoritative ${fromSouth}, spillover-fallback ${fallback})`,
  )
}

main()
