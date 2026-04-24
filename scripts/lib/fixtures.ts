/**
 * Shared fixture data for benchmark + sample-generator scripts.
 *
 * Every Location has an optional `address` (Nominatim query). `verify-
 * Fixtures` geocodes each one and flags big deltas so bad coords like
 * the 600m-off Stadtbad Neukölln one can't silently corrupt benchmarks
 * again.
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface Location {
  lat: number
  lng: number
  label: string
  /**
   * Nominatim query for verification. Null = skip (used for generic
   * fixtures like "School" that aren't geocodable, or private labels).
   */
  address: string | null
}

export interface CityBbox {
  south: number
  west: number
  north: number
  east: number
}

export interface CityConfig {
  key: 'berlin' | 'sf'
  displayName: string
  bbox: CityBbox
  pairs: Array<{ origin: Location; dest: Location }>
}

export const MODES = [
  'kid-starting-out',
  'kid-confident',
  'kid-traffic-savvy',
  'carrying-kid',
  'training',
] as const
export type ModeKey = typeof MODES[number]

// ── Berlin fixtures ────────────────────────────────────────────────────

const BERLIN_HOME: Location = {
  lat: 52.5051, lng: 13.4145, label: 'Home',
  address: 'Dresdener Straße 112, 10179 Berlin',
}
const BERLIN_SCHOOL: Location = {
  lat: 52.5105, lng: 13.4247, label: 'School',
  // Private label; Nominatim doesn't have a specific building at this address.
  address: null,
}
const BERLIN_DESTS: Location[] = [
  // Coords aligned with Nominatim ≤ 50m where a clean geocode exists.
  // Verification catches future drift but never auto-rewrites.
  { lat: 52.5084, lng: 13.3392, label: 'Berlin Zoo',            address: 'Zoo Berlin' },
  { lat: 52.5284, lng: 13.3727, label: 'Hamburger Bahnhof',     address: 'Hamburger Bahnhof museum, Berlin' },
  { lat: 52.5219, lng: 13.4133, label: 'Alexanderplatz',        address: 'Alexanderplatz, Berlin' },
  { lat: 52.5125, lng: 13.4047, label: 'Fischerinsel Swimming', address: 'Schwimmhalle Fischerinsel, Berlin' },
  { lat: 52.5169, lng: 13.4019, label: 'Humboldt Forum',        address: 'Humboldt Forum, Berlin' },
  { lat: 52.4926, lng: 13.3966, label: 'Nonne und Zwerg',       address: 'Nonne und Zwerg, Berlin' },
  { lat: 52.4792, lng: 13.4397, label: 'Stadtbad Neukoelln',    address: 'Stadtbad Neukölln, Ganghoferstraße 3, 12043 Berlin' },
  { lat: 52.5373, lng: 13.5749, label: 'Garten der Welt',       address: 'Gärten der Welt Marzahn' },
  { lat: 52.5300, lng: 13.4519, label: 'SSE Schwimmhalle',      address: 'Schwimm- und Sprunghalle Europasportpark, Berlin' },
  { lat: 52.4898, lng: 13.3904, label: 'Ararat Bergmannstr',    address: 'Ararat Bergmannstraße Berlin' },
]
const BERLIN_EXTRAS: Array<{ origin: Location; dest: Location }> = [
  {
    origin: { lat: 52.5163, lng: 13.3777, label: 'Brandenburger Tor', address: 'Brandenburger Tor, Berlin' },
    dest:   { lat: 52.5084, lng: 13.3392, label: 'Berlin Zoo',        address: 'Zoo Berlin' },
  },
  {
    origin: { lat: 52.4921, lng: 13.3147, label: 'Thaipark',          address: 'Preußenpark, Berlin' },
    dest:   { lat: 52.4867, lng: 13.3546, label: 'Tranxx',            address: null },
  },
]

export const BERLIN: CityConfig = {
  key: 'berlin',
  displayName: 'Berlin',
  bbox: { south: 52.34, west: 13.08, north: 52.68, east: 13.80 },
  pairs: [
    ...[BERLIN_HOME, BERLIN_SCHOOL].flatMap((o) => BERLIN_DESTS.map((d) => ({ origin: o, dest: d }))),
    ...BERLIN_EXTRAS,
  ],
}

// ── San Francisco fixtures ─────────────────────────────────────────────

const SF_HOME: Location = {
  lat: 37.7605, lng: -122.4311, label: 'Home (120 Hancock St, Castro)',
  address: '120 Hancock Street, San Francisco',
}
const SF_DESTS: Location[] = [
  { lat: 37.7955, lng: -122.3935, label: 'Ferry Building',                           address: 'Ferry Building, San Francisco' },
  { lat: 37.7798, lng: -122.5116, label: 'Lands End',                                address: 'Lands End Lookout San Francisco' },
  // JFK Promenade and 22nd St Caltrain: Nominatim doesn't return a
  // clean match for either phrasing we tried; coords hand-placed at
  // the actual intersections. Set address=null to skip verification.
  { lat: 37.7711, lng: -122.4542, label: 'JFK Promenade east end (Stanyan)',         address: null },
  { lat: 37.7507, lng: -122.5085, label: 'Sunset Dunes (Ocean Beach)',               address: 'Sunset Dunes San Francisco' },
  { lat: 37.7261, lng: -122.4434, label: 'Balboa Pool',                              address: 'Balboa Pool, San Francisco' },
  { lat: 37.7619, lng: -122.4219, label: 'Dumpling Story (694 Valencia)',            address: '694 Valencia Street, San Francisco' },
  { lat: 37.7615, lng: -122.4239, label: 'Tartine (600 Guerrero)',                   address: '600 Guerrero Street, San Francisco' },
  { lat: 37.7573, lng: -122.3924, label: '22nd St Caltrain',                         address: null },
  { lat: 37.7769, lng: -122.3951, label: '4th + King Caltrain',                      address: '4th and King Caltrain, San Francisco' },
  { lat: 37.7650, lng: -122.4204, label: '16th St Mission BART',                     address: 'Mission 16th Street BART' },
  { lat: 37.7475, lng: -122.4216, label: 'CPMC Mission Bernal (Cesar Chavez + Valencia)', address: 'CPMC Mission Bernal Campus, San Francisco' },
  { lat: 37.7631, lng: -122.4574, label: 'UCSF Parnassus (505 Parnassus)',           address: '505 Parnassus Ave, San Francisco' },
  { lat: 37.7896, lng: -122.4079, label: '450 Sutter Medical Building',              address: '450 Sutter Street, San Francisco' },
  { lat: 37.7887, lng: -122.4072, label: 'Apple Store Union Square',                 address: 'Apple Store Union Square, San Francisco' },
  { lat: 37.7960, lng: -122.4054, label: "Yummy's (607 Jackson, Chinatown)",         address: '607 Jackson Street, San Francisco' },
  { lat: 37.7822, lng: -122.4789, label: 'Lung Fung Bakery (1823 Clement)',          address: '1823 Clement Street, San Francisco' },
  { lat: 37.7805, lng: -122.4806, label: 'Dragon Beaux (5700 Geary)',                address: '5700 Geary Boulevard, San Francisco' },
]
export const SF: CityConfig = {
  key: 'sf',
  displayName: 'San Francisco',
  bbox: { south: 37.70, west: -122.52, north: 37.82, east: -122.38 },
  pairs: SF_DESTS.map((d) => ({ origin: SF_HOME, dest: d })),
}

export const CITIES: CityConfig[] = [BERLIN, SF]

// ── Verification ───────────────────────────────────────────────────────

export interface VerifyEntry {
  label: string
  city: string
  fixtureLat: number
  fixtureLng: number
  geocodeLat: number | null
  geocodeLng: number | null
  deltaM: number | null
  severity: 'ok' | 'warn' | 'error' | 'skipped' | 'no-match'
  address: string | null
}

const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
const NOMINATIM_UA = 'family-bike-map/1.0 (Bryan Chan, https://bike-map.fryanpan.com)'

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 6371000
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

async function geocode(address: string): Promise<{ lat: number; lng: number } | null> {
  const url = `${NOMINATIM}?q=${encodeURIComponent(address)}&format=json&limit=1`
  const resp = await fetch(url, { headers: { 'User-Agent': NOMINATIM_UA } })
  if (!resp.ok) return null
  const data = await resp.json() as Array<{ lat: string; lon: string }>
  if (data.length === 0) return null
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
}

export interface VerifyOptions {
  /** Delta ≥ errorM → severity='error'. Default 150. */
  errorM?: number
  /** Delta ≥ warnM → severity='warn'. Default 50. */
  warnM?: number
  /** Politeness delay between Nominatim requests (ms). Default 1200. */
  delayMs?: number
  onProgress?: (done: number, total: number) => void
}

/**
 * Geocode every fixture address via Nominatim, compare to the hardcoded
 * lat/lng, and return a report. Fixtures with `address: null` are
 * skipped. Rate-limited to Nominatim's 1-req/s guidance with a small
 * buffer.
 */
export async function verifyFixtures(
  cities: CityConfig[] = CITIES,
  opts: VerifyOptions = {},
): Promise<VerifyEntry[]> {
  const errorM = opts.errorM ?? 150
  const warnM  = opts.warnM  ?? 50
  const delayMs = opts.delayMs ?? 1200

  // Deduplicate fixtures — Home appears in 10+ pairs; only geocode it once.
  const seen = new Map<string, { city: string; loc: Location }>()
  for (const city of cities) {
    for (const p of city.pairs) {
      const oKey = `${p.origin.label}::${p.origin.lat},${p.origin.lng}`
      const dKey = `${p.dest.label}::${p.dest.lat},${p.dest.lng}`
      if (!seen.has(oKey)) seen.set(oKey, { city: city.displayName, loc: p.origin })
      if (!seen.has(dKey)) seen.set(dKey, { city: city.displayName, loc: p.dest })
    }
  }

  const entries: VerifyEntry[] = []
  const list = [...seen.values()]
  for (let i = 0; i < list.length; i++) {
    const { city, loc } = list[i]
    opts.onProgress?.(i + 1, list.length)

    if (loc.address == null) {
      entries.push({
        label: loc.label, city,
        fixtureLat: loc.lat, fixtureLng: loc.lng,
        geocodeLat: null, geocodeLng: null,
        deltaM: null, severity: 'skipped',
        address: null,
      })
      continue
    }

    const hit = await geocode(loc.address)
    if (!hit) {
      entries.push({
        label: loc.label, city,
        fixtureLat: loc.lat, fixtureLng: loc.lng,
        geocodeLat: null, geocodeLng: null,
        deltaM: null, severity: 'no-match',
        address: loc.address,
      })
    } else {
      const dm = haversineM(loc.lat, loc.lng, hit.lat, hit.lng)
      entries.push({
        label: loc.label, city,
        fixtureLat: loc.lat, fixtureLng: loc.lng,
        geocodeLat: hit.lat, geocodeLng: hit.lng,
        deltaM: dm,
        severity: dm >= errorM ? 'error' : dm >= warnM ? 'warn' : 'ok',
        address: loc.address,
      })
    }

    if (i + 1 < list.length) await new Promise((r) => setTimeout(r, delayMs))
  }
  return entries
}

export function printVerifyReport(entries: VerifyEntry[]): void {
  const rows = entries.map((e) => {
    const bench = `(${e.fixtureLat.toFixed(4)}, ${e.fixtureLng.toFixed(4)})`
    const geo   = e.geocodeLat != null ? `(${e.geocodeLat.toFixed(4)}, ${e.geocodeLng!.toFixed(4)})` : '-'
    const delta = e.deltaM != null ? `${e.deltaM.toFixed(0)}m` : '-'
    const tag   = e.severity.toUpperCase().padEnd(7)
    return `  ${tag} ${e.city.padEnd(14)} ${e.label.padEnd(42).slice(0, 42)} bench=${bench}  nomin=${geo}  Δ=${delta}`
  })
  console.log('\n── Fixture verification ─────────────────────────────────')
  for (const r of rows) console.log(r)
  const errors = entries.filter((e) => e.severity === 'error').length
  const warns  = entries.filter((e) => e.severity === 'warn').length
  const misses = entries.filter((e) => e.severity === 'no-match').length
  const ok     = entries.filter((e) => e.severity === 'ok').length
  const skipped = entries.filter((e) => e.severity === 'skipped').length
  console.log(`\n  ${ok} ok · ${warns} warn · ${errors} error · ${misses} no-match · ${skipped} skipped`)
}

export function hasVerifyErrors(entries: VerifyEntry[]): boolean {
  return entries.some((e) => e.severity === 'error')
}
