# Classification Audit Tool — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an admin panel that scans cities via Overpass, groups bike infrastructure by tag pattern and classification, shows Mapillary street-level imagery, and lets reviewers set per-region classification rules stored in Cloudflare KV.

**Architecture:** A new `/audit` route in the SPA renders the audit panel. The scan runs client-side (Overpass API via our Worker proxy). Classification rules are stored in Cloudflare KV and fetched by the app on load. Mapillary images are lazy-loaded per group.

**Tech Stack:** React, Leaflet (mini-maps), Overpass API, Mapillary API v4, Cloudflare KV, IndexedDB (scan cache)

---

## Task 1: Add KV binding and rules API to Cloudflare Worker

**Files:**
- Modify: `wrangler.toml`
- Modify: `src/worker.ts`
- Test: `tests/worker-rules.test.ts` (new)

**Step 1: Add KV namespace binding to wrangler.toml**

```toml
[[kv_namespaces]]
binding = "CLASSIFICATION_RULES"
id = "TBD_AFTER_CREATE"
preview_id = "TBD_AFTER_CREATE"
```

Run: `wrangler kv namespace create CLASSIFICATION_RULES`
Run: `wrangler kv namespace create CLASSIFICATION_RULES --preview`
Update wrangler.toml with the returned IDs.

**Step 2: Add GET/PUT /api/rules/:region to worker.ts**

Add after the existing `/api/feedback` route:

```typescript
// GET /api/rules/:region — fetch classification rules for a region
if (request.method === 'GET' && path.startsWith('/api/rules/')) {
  const region = path.split('/')[3]
  if (!region) return new Response('Missing region', { status: 400 })
  const rules = await env.CLASSIFICATION_RULES.get(`rules:${region}`)
  return new Response(rules ?? '{"rules":[],"legendItems":[]}', {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  })
}

// PUT /api/rules/:region — update classification rules for a region
if (request.method === 'PUT' && path.startsWith('/api/rules/')) {
  const region = path.split('/')[3]
  if (!region) return new Response('Missing region', { status: 400 })
  const body = await request.text()
  JSON.parse(body) // validate JSON
  await env.CLASSIFICATION_RULES.put(`rules:${region}`, body)
  return new Response('OK', { status: 200 })
}
```

Add `CLASSIFICATION_RULES: KVNamespace` to the Env interface.

**Step 3: Write test for rules API**

```typescript
// tests/worker-rules.test.ts
describe('classification rules API', () => {
  it('GET /api/rules/berlin returns empty rules for new region', ...)
  it('PUT /api/rules/berlin stores rules', ...)
  it('GET /api/rules/berlin returns stored rules', ...)
  it('PUT /api/rules/ without region returns 400', ...)
})
```

Note: Worker tests may need to be integration-style or mock KV. Check existing test patterns.

**Step 4: Run tests, commit**

```bash
bun test
git add wrangler.toml src/worker.ts tests/worker-rules.test.ts
git commit -m "feat(audit): add KV-backed classification rules API"
```

---

## Task 2: Create scan service — Overpass city sampling

**Files:**
- Create: `src/services/audit.ts`
- Test: `tests/audit.test.ts` (new)

**Step 1: Define types**

```typescript
// In src/services/audit.ts

export interface AuditWay {
  osmId: number
  tags: Record<string, string>
  lat: number
  lng: number
}

export interface AuditGroup {
  signature: string          // e.g. "highway=tertiary + cycleway:right=lane"
  classification: Record<string, string | null>  // { toddler: "Painted bike lane", trailer: null, ... }
  ways: AuditWay[]
  wayCount: number
}

export interface CityScan {
  city: string
  bbox: [number, number, number, number]  // [south, west, north, east]
  scannedAt: string
  groups: AuditGroup[]
  totalWays: number
}

export interface CityPreset {
  name: string
  bbox: [number, number, number, number]
}

export const CITY_PRESETS: CityPreset[] = [
  { name: 'Berlin', bbox: [52.42, 13.25, 52.58, 13.55] },
  { name: 'Copenhagen', bbox: [55.6, 12.4, 55.75, 12.7] },
  { name: 'SF Bay Area', bbox: [37.7, -122.6, 38.1, -122.1] },
]
```

**Step 2: Implement tile sampling**

```typescript
export function sampleTiles(bbox: [number, number, number, number], count: number): Array<{ row: number; col: number }> {
  // Divide bbox into grid, pick `count` tiles spread across the area
  const TILE_DEG = 0.1
  const [south, west, north, east] = bbox
  const minRow = Math.floor(south / TILE_DEG)
  const maxRow = Math.floor(north / TILE_DEG)
  const minCol = Math.floor(west / TILE_DEG)
  const maxCol = Math.floor(east / TILE_DEG)

  const allTiles: Array<{ row: number; col: number }> = []
  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      allTiles.push({ row: r, col: c })
    }
  }

  // Shuffle and take `count`
  for (let i = allTiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allTiles[i], allTiles[j]] = [allTiles[j], allTiles[i]]
  }
  return allTiles.slice(0, Math.min(count, allTiles.length))
}
```

**Step 3: Implement audit Overpass query**

Build a broader query than the overlay — includes tertiary, unclassified, service roads:

```typescript
export function buildAuditQuery(bbox: { south: number; west: number; north: number; east: number }): string {
  const { south, west, north, east } = bbox
  const b = `${south},${west},${north},${east}`
  return `
[out:json][timeout:25];
(
  way["highway"="cycleway"](${b});
  way["bicycle_road"="yes"](${b});
  way["cyclestreet"="yes"](${b});
  way["cycleway"](${b});
  way["cycleway:right"](${b});
  way["cycleway:left"](${b});
  way["cycleway:both"](${b});
  way["highway"="living_street"](${b});
  way["highway"="residential"](${b});
  way["highway"="tertiary"](${b});
  way["highway"="unclassified"](${b});
  way["highway"="service"]["service"!="parking_aisle"](${b});
  way["highway"="path"](${b});
  way["highway"="footway"]["bicycle"~"yes|designated"](${b});
  way["highway"="track"](${b});
);
out tags center;
`
}
```

Note: `out tags center;` returns tags + centroid without full geometry — much smaller response.

**Step 4: Implement tag signature generation**

```typescript
const SIGNATURE_KEYS = [
  'highway', 'bicycle_road', 'cyclestreet', 'cycleway',
  'cycleway:right', 'cycleway:left', 'cycleway:both',
  'surface', 'smoothness', 'maxspeed', 'bicycle',
  'segregated', 'tracktype',
]

export function tagSignature(tags: Record<string, string>): string {
  return SIGNATURE_KEYS
    .filter((k) => tags[k])
    .map((k) => `${k}=${tags[k]}`)
    .join(' + ')
}
```

**Step 5: Implement full scan function**

```typescript
import { classifyOsmTagsToItem } from './overpass'

export async function scanCity(
  city: string,
  bbox: [number, number, number, number],
  onProgress: (pct: number) => void,
): Promise<CityScan> {
  const tiles = sampleTiles(bbox, 20)
  const TILE_DEG = 0.1
  const allWays = new Map<number, AuditWay>()  // deduplicate by osmId

  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i]
    const tileBbox = {
      south: t.row * TILE_DEG,
      north: (t.row + 1) * TILE_DEG,
      west: t.col * TILE_DEG,
      east: (t.col + 1) * TILE_DEG,
    }
    const query = buildAuditQuery(tileBbox)
    try {
      const resp = await fetch('/api/overpass', {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      if (resp.ok) {
        const data = await resp.json() as { elements: Array<{ type: string; id: number; tags?: Record<string, string>; center?: { lat: number; lon: number } }> }
        for (const el of data.elements) {
          if (el.type === 'way' && el.tags && el.center && !allWays.has(el.id)) {
            allWays.set(el.id, { osmId: el.id, tags: el.tags, lat: el.center.lat, lng: el.center.lon })
          }
        }
      }
    } catch (err) {
      console.warn(`[Audit] Tile ${t.row}:${t.col} failed:`, err)
    }
    onProgress((i + 1) / tiles.length)
    // Rate-limit pause between tiles
    if (i < tiles.length - 1) await new Promise((r) => setTimeout(r, 2000))
  }

  // Group by signature + classification
  const groupMap = new Map<string, AuditGroup>()
  const profiles = ['toddler', 'trailer', 'training']

  for (const way of allWays.values()) {
    const sig = tagSignature(way.tags)
    const classification: Record<string, string | null> = {}
    for (const p of profiles) {
      classification[p] = classifyOsmTagsToItem(way.tags, p)
    }
    const key = `${sig}||${JSON.stringify(classification)}`

    if (!groupMap.has(key)) {
      groupMap.set(key, { signature: sig, classification, ways: [], wayCount: 0 })
    }
    const group = groupMap.get(key)!
    group.wayCount++
    if (group.ways.length < 5) {
      group.ways.push(way)
    }
  }

  const groups = [...groupMap.values()].sort((a, b) => b.wayCount - a.wayCount)

  return {
    city,
    bbox,
    scannedAt: new Date().toISOString(),
    groups,
    totalWays: allWays.size,
  }
}
```

**Step 6: Write tests**

```typescript
// tests/audit.test.ts
describe('sampleTiles', () => {
  it('returns correct number of tiles', ...)
  it('tiles are within bbox', ...)
})
describe('tagSignature', () => {
  it('produces stable signature from tags', ...)
  it('ignores non-signature keys', ...)
})
describe('buildAuditQuery', () => {
  it('includes tertiary and residential roads', ...)
  it('excludes parking_aisle service roads', ...)
})
```

**Step 7: Commit**

```bash
bun test
git add src/services/audit.ts tests/audit.test.ts
git commit -m "feat(audit): city scan service with tile sampling and tag grouping"
```

---

## Task 3: IndexedDB scan cache

**Files:**
- Create: `src/services/auditCache.ts`

**Step 1: Implement IndexedDB wrapper for scan results**

```typescript
const DB_NAME = 'bike-audit'
const STORE_NAME = 'scans'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveScan(city: string, scan: CityScan): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(scan, city)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function loadScan(city: string): Promise<CityScan | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(city)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => reject(req.error)
  })
}
```

**Step 2: Commit**

```bash
git add src/services/auditCache.ts
git commit -m "feat(audit): IndexedDB cache for city scan results"
```

---

## Task 4: Mapillary image service

**Files:**
- Create: `src/services/mapillary.ts`
- Test: `tests/mapillary.test.ts` (new)

**Step 1: Implement Mapillary image lookup**

```typescript
const MAPILLARY_TOKEN = import.meta.env.VITE_MAPILLARY_TOKEN ?? ''
const MAPILLARY_API = 'https://graph.mapillary.com'

export interface MapillaryImage {
  id: string
  thumbUrl: string
  lat: number
  lng: number
}

export async function getStreetImage(lat: number, lng: number): Promise<MapillaryImage | null> {
  if (!MAPILLARY_TOKEN) return null

  const delta = 0.0005  // ~50m radius
  const bbox = `${lng - delta},${lat - delta},${lng + delta},${lat + delta}`
  const url = `${MAPILLARY_API}/images?bbox=${bbox}&limit=1&fields=id,thumb_1024_url,computed_geometry&access_token=${MAPILLARY_TOKEN}`

  try {
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json() as { data: Array<{ id: string; thumb_1024_url: string; computed_geometry: { coordinates: [number, number] } }> }
    const img = data.data[0]
    if (!img) return null
    return {
      id: img.id,
      thumbUrl: img.thumb_1024_url,
      lat: img.computed_geometry.coordinates[1],
      lng: img.computed_geometry.coordinates[0],
    }
  } catch {
    return null
  }
}
```

**Step 2: Add VITE_MAPILLARY_TOKEN to .env**

```
VITE_MAPILLARY_TOKEN=<user will provide>
```

**Step 3: Write tests (mock fetch)**

```typescript
// tests/mapillary.test.ts
describe('getStreetImage', () => {
  it('returns null when no token configured', ...)
  it('returns image data on success', ...)
  it('returns null on API error', ...)
})
```

**Step 4: Commit**

```bash
bun test
git add src/services/mapillary.ts tests/mapillary.test.ts
git commit -m "feat(audit): Mapillary street-level image service"
```

---

## Task 5: Audit panel — scaffold and routing

**Files:**
- Create: `src/components/AuditPanel.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`

**Step 1: Create AuditPanel shell component**

```typescript
// src/components/AuditPanel.tsx
import { useState } from 'react'
import { CITY_PRESETS } from '../services/audit'
import type { CityScan } from '../services/audit'

export default function AuditPanel({ onClose }: { onClose: () => void }) {
  const [scan, setScan] = useState<CityScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [selectedCity, setSelectedCity] = useState(CITY_PRESETS[0].name)

  return (
    <div className="audit-overlay">
      <div className="audit-header">
        <h2>Classification Audit</h2>
        <button className="audit-close" onClick={onClose}>✕</button>
      </div>
      <div className="audit-controls">
        <select value={selectedCity} onChange={(e) => setSelectedCity(e.target.value)}>
          {CITY_PRESETS.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
        <button onClick={() => { /* TODO: wire scan */ }} disabled={scanning}>
          {scanning ? `Scanning… ${Math.round(progress * 100)}%` : 'Scan'}
        </button>
        {scan && <span className="audit-meta">Last: {new Date(scan.scannedAt).toLocaleString()} · {scan.totalWays} ways · {scan.groups.length} groups</span>}
      </div>
      <div className="audit-groups">
        {scan?.groups.map((g, i) => (
          <div key={i} className="audit-group-card">
            <div className="audit-group-header">
              <span className="audit-group-sig">{g.signature || '(no cycling tags)'}</span>
              <span className="audit-group-count">{g.wayCount} ways</span>
            </div>
            <div className="audit-group-classifications">
              {Object.entries(g.classification).map(([mode, cls]) => (
                <span key={mode} className={`audit-cls ${cls ? 'audit-cls-known' : 'audit-cls-null'}`}>
                  {mode}: {cls ?? 'Unclassified'}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
```

**Step 2: Add gear icon and audit state to App.tsx**

Add state: `const [auditOpen, setAuditOpen] = useState(false)`

Add gear button near the bike layer toggle:
```tsx
<button className="audit-gear-btn" onClick={() => setAuditOpen(true)} title="Classification audit">⚙️</button>
```

Conditionally render:
```tsx
{auditOpen && <AuditPanel onClose={() => setAuditOpen(false)} />}
```

**Step 3: Add CSS for audit panel**

Full-page overlay with scrollable content. Add to App.css:

```css
/* ── Audit panel ─────────────────────────────── */
.audit-overlay {
  position: fixed;
  inset: 0;
  z-index: 900;
  background: #fff;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.audit-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid #e5e7eb;
}
.audit-header h2 { font-size: 18px; font-weight: 700; }
.audit-close { background: none; border: none; font-size: 20px; color: #9ca3af; padding: 4px; }
.audit-controls {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  border-bottom: 1px solid #f3f4f6;
  flex-wrap: wrap;
}
.audit-controls select {
  padding: 8px 10px;
  border: 1.5px solid #e5e7eb;
  border-radius: 8px;
  font-size: 14px;
}
.audit-controls button {
  padding: 8px 16px;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
}
.audit-controls button:disabled { opacity: 0.6; }
.audit-meta { font-size: 12px; color: #6b7280; }
.audit-groups {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
}
.audit-group-card {
  border: 1px solid #e5e7eb;
  border-radius: 10px;
  padding: 10px 14px;
  margin-bottom: 8px;
  cursor: pointer;
  transition: border-color .15s;
}
.audit-group-card:hover { border-color: #93c5fd; }
.audit-group-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
}
.audit-group-sig { font-size: 13px; font-weight: 600; color: #111827; font-family: monospace; }
.audit-group-count { font-size: 12px; color: #6b7280; }
.audit-group-classifications {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.audit-cls {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
}
.audit-cls-known { background: #d1fae5; color: #065f46; }
.audit-cls-null { background: #fef3c7; color: #92400e; }

.audit-gear-btn {
  background: rgba(255,255,255,.96);
  border: 1.5px solid #d1d5db;
  border-radius: 50%;
  width: 36px;
  height: 36px;
  font-size: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 8px rgba(0,0,0,.12);
  transition: all .15s;
}
.audit-gear-btn:hover { border-color: #93c5fd; }
```

**Step 4: Commit**

```bash
bunx tsc --noEmit && bun test
git add src/components/AuditPanel.tsx src/App.tsx src/App.css
git commit -m "feat(audit): scaffold audit panel with city selector and group list"
```

---

## Task 6: Wire scan execution + IndexedDB caching

**Files:**
- Modify: `src/components/AuditPanel.tsx`

**Step 1: Wire the scan button to scanCity + cache**

Import `scanCity` from audit service, `saveScan`/`loadScan` from auditCache. On mount, try to load cached scan. On scan button click, run scanCity with progress callback, save result to IndexedDB.

**Step 2: Add filter controls**

Add filter state: `filter` ('all' | 'unclassified' | 'classified'), `travelMode` ('toddler' | 'trailer' | 'training'), `search` text.

Filter the groups list based on these before rendering.

**Step 3: Commit**

```bash
bunx tsc --noEmit
git add src/components/AuditPanel.tsx
git commit -m "feat(audit): wire scan execution, caching, and group filtering"
```

---

## Task 7: Expandable group cards with mini-map

**Files:**
- Create: `src/components/AuditGroupDetail.tsx`
- Modify: `src/components/AuditPanel.tsx`
- Modify: `src/App.css`

**Step 1: Create AuditGroupDetail component**

Shows when a group card is expanded. Contains:
- A small Leaflet map (200px tall) with pins for the 5 sample ways
- Full tag table for each sample
- Placeholder for Mapillary images (wired in next task)
- Review action buttons: Confirm, Override dropdown, Flag

Use `MapContainer` from react-leaflet with a small fixed size.

**Step 2: Add expand/collapse to group cards in AuditPanel**

Track `expandedGroup` index in state. Click toggles. Render `<AuditGroupDetail>` when expanded.

**Step 3: Add CSS for detail view**

Mini-map container, tag table, action buttons.

**Step 4: Commit**

```bash
bunx tsc --noEmit
git add src/components/AuditGroupDetail.tsx src/components/AuditPanel.tsx src/App.css
git commit -m "feat(audit): expandable group cards with mini-map and sample details"
```

---

## Task 8: Mapillary image integration

**Files:**
- Modify: `src/components/AuditGroupDetail.tsx`
- Modify: `src/App.css`

**Step 1: Lazy-load Mapillary images when group expands**

On expand, call `getStreetImage(lat, lng)` for each of the 5 samples. Show thumbnails in a horizontal row below the mini-map. Show loading skeleton while fetching.

**Step 2: Add click-to-expand on thumbnails**

Clicking a thumbnail opens it larger (modal or inline expand).

**Step 3: Add CSS for image gallery**

Thumbnail row, loading skeleton, expanded view.

**Step 4: Commit**

```bash
bunx tsc --noEmit
git add src/components/AuditGroupDetail.tsx src/App.css
git commit -m "feat(audit): lazy-load Mapillary street-level images per sample"
```

---

## Task 9: Classification override — write rules to KV

**Files:**
- Create: `src/services/rules.ts`
- Modify: `src/components/AuditGroupDetail.tsx`
- Modify: `src/components/AuditPanel.tsx`

**Step 1: Create rules service**

```typescript
// src/services/rules.ts
export interface ClassificationRule {
  match: Record<string, string>
  classification: string
  travelModes: Record<string, 'preferred' | 'other'>
}

export interface RegionRules {
  rules: ClassificationRule[]
  legendItems: Array<{ name: string; icon: string; description: string }>
}

export async function fetchRules(region: string): Promise<RegionRules> {
  const resp = await fetch(`/api/rules/${encodeURIComponent(region)}`)
  return resp.json()
}

export async function saveRules(region: string, rules: RegionRules): Promise<void> {
  await fetch(`/api/rules/${encodeURIComponent(region)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rules),
  })
}
```

**Step 2: Wire override dropdown in AuditGroupDetail**

When reviewer selects a classification from dropdown:
1. Build a rule from the group's tag signature
2. Add to region rules via `saveRules()`
3. Mark group as reviewed in local state

**Step 3: Add "Add legend item" inline form**

At the top of the override dropdown, add an option "+ New item…" that shows an inline form (name + icon emoji). New items are added to the region's legendItems and become available in the dropdown.

**Step 4: Commit**

```bash
bunx tsc --noEmit
git add src/services/rules.ts src/components/AuditGroupDetail.tsx src/components/AuditPanel.tsx
git commit -m "feat(audit): classification overrides stored in Cloudflare KV"
```

---

## Task 10: Apply server-side rules in the classifier

**Files:**
- Modify: `src/services/overpass.ts` (classifyOsmTagsToItem)
- Modify: `src/utils/classify.ts` (classifyEdgeToItem)
- Modify: `src/App.tsx` (fetch rules on load)
- Test: `tests/classify.test.ts`

**Step 1: Fetch region rules on app load**

In App.tsx, add an effect that fetches rules for the current viewport region and stores them in state. Pass rules down to components that need classification.

**Step 2: Modify classifyOsmTagsToItem to check rules first**

Before the hardcoded classification logic, check if any server-side rule matches the way's tags. If so, return that rule's classification. Rules take priority over hardcoded logic.

```typescript
export function classifyOsmTagsToItem(
  tags: Record<string, string>,
  profileKey: string,
  regionRules?: ClassificationRule[]
): string | null {
  // Check server-side rules first
  if (regionRules) {
    for (const rule of regionRules) {
      if (Object.entries(rule.match).every(([k, v]) => tags[k] === v)) {
        return rule.classification
      }
    }
  }
  // Existing hardcoded logic...
}
```

**Step 3: Write tests for rule matching**

```typescript
describe('classifyOsmTagsToItem with rules', () => {
  it('rule match overrides hardcoded classification', ...)
  it('falls through to hardcoded when no rule matches', ...)
  it('first matching rule wins (priority order)', ...)
})
```

**Step 4: Commit**

```bash
bun test
git add src/services/overpass.ts src/utils/classify.ts src/App.tsx tests/classify.test.ts
git commit -m "feat(audit): apply server-side classification rules in classifier"
```

---

## Task 11: Rules and Legend Items tabs

**Files:**
- Create: `src/components/AuditRulesTab.tsx`
- Create: `src/components/AuditLegendTab.tsx`
- Modify: `src/components/AuditPanel.tsx`
- Modify: `src/App.css`

**Step 1: Add tab navigation to AuditPanel**

Three tabs: Groups (default), Rules, Legend Items. Use simple state toggle.

**Step 2: Create AuditRulesTab**

Lists all rules for the selected region. Each rule shows: match conditions, classification, travel mode preferences. Editable inline. Drag-to-reorder (or up/down buttons). Delete button.

**Step 3: Create AuditLegendTab**

Lists all legend items (built-in + custom). Custom items are editable (name, icon). Add/remove custom items.

**Step 4: Commit**

```bash
bunx tsc --noEmit
git add src/components/AuditRulesTab.tsx src/components/AuditLegendTab.tsx src/components/AuditPanel.tsx src/App.css
git commit -m "feat(audit): rules and legend items management tabs"
```

---

## Task 12: Final integration, testing, and deploy

**Files:**
- Modify: `.github/workflows/deploy.yml` (add VITE_MAPILLARY_TOKEN secret)
- Modify: `docs/product/decisions.md`

**Step 1: Add VITE_MAPILLARY_TOKEN to deploy workflow env**

```yaml
env:
  VITE_SENTRY_DSN: ${{ secrets.VITE_SENTRY_DSN }}
  SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
  VITE_MAPILLARY_TOKEN: ${{ secrets.VITE_MAPILLARY_TOKEN }}
```

**Step 2: End-to-end manual test**

1. Open app → click gear icon → audit panel opens
2. Select Berlin → click Scan → progress bar fills → groups appear
3. Expand a group → mini-map + Mapillary photos load
4. Override a classification → confirm rule saved
5. Close audit → verify overlay reflects the new rule
6. Refresh page → verify rule persists (KV)

**Step 3: Log decision**

Add to `docs/product/decisions.md`:
- Classification rules in Cloudflare KV with per-region overrides
- Mapillary integration for visual verification
- Audit tool accessible via gear icon (admin-only by obscurity)

**Step 4: Build and commit**

```bash
bun test && bun run build
git add -A
git commit -m "feat(audit): final integration — deploy config, docs, verification"
```

**Step 5: Push, PR, deploy**

```bash
git push -u origin fix/overlay-initial-load
gh pr create --title "feat: classification audit tool with per-region rules" --body "..."
# Wait for CI, merge, deploy
```
