#!/usr/bin/env bun
/**
 * Fetch Google Directions API bicycle routes for every benchmark pair
 * and cache the results to public/route-compare/google-routes.json.
 *
 * Run once per fixture-set update. The cache is committed; the render
 * script reads it for free.
 *
 * Requires: GOOGLE_MAPS_API_KEY env var with the Directions API enabled.
 * Cost:  39 pairs × $5/1000 ≈ $0.20 (absorbed by Google's $200/mo free
 *        credit if you have one).
 *
 * Usage:
 *   GOOGLE_MAPS_API_KEY=AIza... bun scripts/fetch-google-routes.ts
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CITIES } from './lib/fixtures'
import type { Location } from './lib/fixtures'

const API_KEY = process.env.GOOGLE_MAPS_API_KEY
if (!API_KEY) {
  console.error('GOOGLE_MAPS_API_KEY is not set in env. See comment at top of this file.')
  process.exit(1)
}

function decodePolyline5(encoded: string): [number, number][] {
  // Google's polyline algorithm: 1e5 precision (not 1e6 like Valhalla).
  const points: [number, number][] = []
  let lat = 0, lng = 0, idx = 0
  while (idx < encoded.length) {
    let b, shift = 0, result = 0
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
    lat += ((result & 1) ? ~(result >> 1) : (result >> 1))
    shift = 0; result = 0
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
    lng += ((result & 1) ? ~(result >> 1) : (result >> 1))
    points.push([lat / 1e5, lng / 1e5])
  }
  return points
}

interface GoogleRoute {
  coords: [number, number][]
  distanceKm: number
  durationMin: number
  warnings?: string[]
}

async function fetchGoogleRoute(origin: Location, dest: Location): Promise<GoogleRoute | null> {
  // Use `alternatives=false` (single best route) and `mode=bicycling`.
  const params = new URLSearchParams({
    origin: `${origin.lat},${origin.lng}`,
    destination: `${dest.lat},${dest.lng}`,
    mode: 'bicycling',
    alternatives: 'false',
    units: 'metric',
    key: API_KEY!,
  })
  const url = `https://maps.googleapis.com/maps/api/directions/json?${params}`
  try {
    const resp = await fetch(url)
    if (!resp.ok) {
      console.warn(`  HTTP ${resp.status} for ${origin.label} → ${dest.label}`)
      return null
    }
    const data = await resp.json() as {
      status: string
      routes: Array<{
        overview_polyline: { points: string }
        legs: Array<{ distance: { value: number }; duration: { value: number } }>
        warnings?: string[]
      }>
      error_message?: string
    }
    if (data.status !== 'OK') {
      console.warn(`  status=${data.status} for ${origin.label} → ${dest.label} — ${data.error_message ?? ''}`)
      return null
    }
    const route = data.routes[0]
    if (!route) return null
    const coords = decodePolyline5(route.overview_polyline.points)
    const distanceM = route.legs.reduce((a, l) => a + l.distance.value, 0)
    const durationS = route.legs.reduce((a, l) => a + l.duration.value, 0)
    return {
      coords,
      distanceKm: distanceM / 1000,
      durationMin: durationS / 60,
      warnings: route.warnings,
    }
  } catch (e) {
    console.warn(`  fetch error for ${origin.label} → ${dest.label}: ${e}`)
    return null
  }
}

async function main() {
  // Key per pair: "<city>:<origin.label>→<dest.label>".
  const cache: Record<string, GoogleRoute | null> = {}

  const allPairs: Array<{ city: string; origin: Location; dest: Location }> = []
  for (const city of CITIES) {
    for (const p of city.pairs) {
      allPairs.push({ city: city.key, origin: p.origin, dest: p.dest })
    }
  }
  // Deduplicate (Home appears in many Berlin pairs — but each pair is
  // unique by origin→dest, so no de-dup needed across our fixture set).
  console.log(`Fetching ${allPairs.length} Google bike routes…`)

  for (let i = 0; i < allPairs.length; i++) {
    const { city, origin, dest } = allPairs[i]
    const key = `${city}:${origin.label}→${dest.label}`
    process.stdout.write(`\r  ${i + 1}/${allPairs.length}  ${origin.label} → ${dest.label}`.padEnd(80))
    cache[key] = await fetchGoogleRoute(origin, dest)
    // Google's published QPS limit is 100/s; 300 ms spacing is well under.
    await new Promise((r) => setTimeout(r, 300))
  }
  console.log('')

  const outPath = join(process.cwd(), 'public/route-compare/google-routes.json')
  await writeFile(outPath, JSON.stringify(cache, null, 2))
  const successCount = Object.values(cache).filter((v) => v != null).length
  console.log(`✓ Wrote ${successCount}/${allPairs.length} routes to ${outPath}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
