import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import {
  fetchBikeInfraForTile, getVisibleTiles, isTileCached, getCachedTile, tileKey,
  classifyOsmTagsToItem, isOverlayHiddenSurface, isRoughSurface, isOverlayCrossing,
} from '../services/overpass'
import { getDisplayPathLevel, getOverlayMaxGradientPct } from '../utils/classify'
import { prefetchElevation, overlayGradientPct, hasFineElevationAt } from '../services/elevation'
import { computeMoatIsolation, inheritStubVerdicts, smallFragmentIds } from '../services/overlayReachability'
import { classifyEdge, PATH_LEVEL_LABELS } from '../utils/lts'
import type { PathLevel } from '../utils/lts'
import { colorForLevel, weightMultiplierForLevel } from './SimpleLegend'
import { useAdminSettings } from '../services/adminSettings'
import { resolveStreetImagery } from '../services/streetImagery'
import { useMapEngine } from '../services/mapEngine/context'
import type { MapEngine, PolylineHandle, PopupHandle, PathLayerHandle, PathLayerFeature } from '../services/mapEngine'
import type { ClassificationRule } from '../services/rules'
import { isEnrichedWay, type OsmWay } from '../utils/types'
import { simplifyPath } from '../utils/simplifyPath'
import {
  selectFetchTiles, overviewStyle, MAX_FETCH_TILES, MAX_OVERVIEW_TILES,
  OVERVIEW_MAX_ZOOM, OVERVIEW_TILE_DEGREES, type Tile,
} from '../utils/overlayZoom'
import {
  fetchOverviewTile, getVisibleOverviewCells, getCachedOverviewCell,
  overviewCellKey, overviewCellForTile, isOverviewCellKey,
} from '../services/overviewTiles'

// Hit-area weight for the transparent tap-target polylines. Sized for
// fingertips on mobile. The visible coloured polyline still paints on
// top, so the user sees no visual change.
const HIT_POLYLINE_WEIGHT = 24

// Zoom threshold for showing cobble markers. Below this zoom the
// markers would crowd the city-overview map; above it, the rough-
// surface indicator becomes useful (the user is close enough to care
// which side street is paved smoothly vs. cobbled).
const COBBLE_MARKER_MIN_ZOOM = 16
// Floating-fragment floor: painted components shorter than this (total
// length) are hidden from the overview map below FRAGMENT_SHOW_MIN_ZOOM.
export const FRAGMENT_MIN_LEN_M = 100
export const FRAGMENT_SHOW_MIN_ZOOM = 15

// ── Visibility verdicts ─────────────────────────────────────────────────────
//
// Two code paths compute a way's overlay verdict, dispatched per way by
// overlayWayVerdict below:
//
//  * ENRICHED ways (baked fields present — see isEnrichedWay in types.ts):
//    pure arithmetic over the baked numbers. No elevation lookups, no
//    union-find, no moat pass, no stub inheritance — the verdict ships
//    with the geometry, which is the entire point of the enriched-tiles
//    pipeline (docs/product/plans/enriched-tiles-plan.md).
//  * RAW Overpass ways: the existing runtime path (gradient cache + idle
//    moat pass + stub inheritance + fragment union-find), unchanged. It is
//    kept until enriched coverage is global, then deleted.
//
// Mixed viewports run both, each strictly over its own partition.

export type OverlayVerdict = 'shown' | 'hidden' | 'unknown'

export interface EnrichedGateOptions {
  /** Mode's overlay gradient ceiling (%) — getOverlayMaxGradientPct. */
  maxGradientPct: number
  /** Admin steep-approach push budget (m). The baked accessGradientPct is a
   *  strict (budget-0) minimax and carries no bottleneck-length info, so a
   *  positive budget cannot be applied per approach way like the runtime
   *  moat does. Any budget > 0 therefore disables the baked access gate
   *  entirely — fail-soft toward SHOWN, and monotone in the budget (raising
   *  it only ever shows more), matching the runtime knob's direction.
   *  Default budget is 0, where baked and runtime semantics agree. */
  steepApproachPushM: number
  /** True below FRAGMENT_SHOW_MIN_ZOOM — the overview zooms where
   *  sub-FRAGMENT_MIN_LEN_M components are suppressed. */
  fragmentFloorActive: boolean
}

/**
 * Pure-arithmetic verdict for an enriched way. Never 'unknown': a null
 * baked field means the bake couldn't grade it (DEM void) and fail-softs
 * to shown — there is no "terrain still loading" state to wait on, so
 * enriched ways can never paint-then-vanish and never need stub
 * inheritance (the bake gave sub-noise-floor stubs their component's
 * context by construction).
 */
export function enrichedWayVerdict(way: OsmWay, opts: EnrichedGateOptions): 'shown' | 'hidden' {
  if (way.gradientPct != null && way.gradientPct > opts.maxGradientPct) return 'hidden'
  if (
    way.accessGradientPct != null &&
    way.accessGradientPct > opts.maxGradientPct &&
    opts.steepApproachPushM <= 0
  ) return 'hidden'
  if (
    opts.fragmentFloorActive &&
    way.componentPaintedLenM != null &&
    way.componentPaintedLenM < FRAGMENT_MIN_LEN_M
  ) return 'hidden'
  return 'shown'
}

export interface RuntimeGateInputs {
  /** The runtime per-way gradient accessor (cached overlayGradientPct). */
  gradientPct: (way: OsmWay) => number | null
  /** Result of the idle-scheduled computeMoatIsolation pass. */
  moatIsolated: Set<string | number>
}

/**
 * Per-way verdict dispatcher. Enriched ways take the arithmetic gate and
 * MUST NOT touch the runtime inputs (no gradientPct call, no moat lookup);
 * raw ways take the pre-existing runtime path unchanged.
 */
export function overlayWayVerdict(
  way: OsmWay,
  opts: EnrichedGateOptions & RuntimeGateInputs,
): OverlayVerdict {
  if (isEnrichedWay(way)) return enrichedWayVerdict(way, opts)
  // Runtime path — identical logic to the pre-enrichment gate: local
  // gradient ceiling + global moat verdict; null gradient = unknown.
  const gradientPct = opts.gradientPct(way)
  if (opts.moatIsolated.has(way.osmId) || (gradientPct != null && gradientPct > opts.maxGradientPct)) {
    return 'hidden'
  }
  return gradientPct == null ? 'unknown' : 'shown'
}

// ── Tooltip HTML helpers (unchanged) ──────────────────────────────────────

function getDebugTags(tags: Record<string, string>): string[] {
  const parts: string[] = []
  if (tags.highway)                   parts.push(`highway=${tags.highway}`)
  if (tags.bicycle_road === 'yes')    parts.push('bicycle_road=yes')
  if (tags.cycleway)                  parts.push(`cycleway=${tags.cycleway}`)
  if (tags['cycleway:right'])         parts.push(`cycleway:right=${tags['cycleway:right']}`)
  if (tags['cycleway:left'])          parts.push(`cycleway:left=${tags['cycleway:left']}`)
  if (tags['cycleway:both'])          parts.push(`cycleway:both=${tags['cycleway:both']}`)
  if (tags['cycleway:separation'])    parts.push(`separation=${tags['cycleway:separation']}`)
  if (tags['cycleway:right:separation']) parts.push(`separation=${tags['cycleway:right:separation']}`)
  if (tags['cycleway:buffer'])        parts.push('buffer=yes')
  if (tags.surface)                   parts.push(`surface=${tags.surface}`)
  return parts
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function buildTooltipHtml(
  itemName: string | null,
  tags: Record<string, string>,
  isPreferred: boolean,
  imageUrl?: string | null,
  imageCredit?: string | null,
): string {
  const debugTags = getDebugTags(tags)
  const name = tags.name ? ` — ${escapeHtml(tags.name)}` : ''
  const preferredLabel = isPreferred
    ? `<span style="color:#10b981;font-weight:600">Preferred</span>`
    : `<span style="color:#f97316;font-weight:600">Not preferred</span>`
  const tagsHtml = debugTags.map((t) => `<div>${escapeHtml(t)}</div>`).join('')
  // Mapillary images need an attribution caption; Street View carries its
  // own baked-in watermark, so a credit is passed only for the fallback.
  const creditHtml = imageUrl && imageCredit
    ? `<div style="font-size:10px;color:#6b7280;text-align:right;margin-top:2px">via ${escapeHtml(imageCredit)}</div>`
    : ''
  const imageHtml = imageUrl
    ? `<img src="${escapeHtml(imageUrl)}" alt="Street-level view" style="width:100%;border-radius:4px;margin-top:6px;display:block" loading="lazy" />${creditHtml}`
    : ''
  const { pathLevel } = classifyEdge(tags)
  const info = PATH_LEVEL_LABELS[pathLevel]
  const ltsHtml = `<div style="margin-top:6px;padding:5px 7px;background:#f3f4f6;border-radius:4px">
    <div style="font-size:11px"><b>LTS ${pathLevel}</b> · ${escapeHtml(info.short)}</div>
    <div style="font-size:11px;color:#4b5563;margin-top:2px">${escapeHtml(info.description)}</div>
  </div>`
  return `<div style="font-size:12px;line-height:1.5;width:240px">
    <div style="font-weight:700;white-space:normal;word-break:break-word">${itemName ?? 'Unknown'}${name}</div>
    <div style="margin-top:2px">${preferredLabel}</div>
    ${ltsHtml}
    ${tagsHtml ? `<div style="color:#6b7280;font-size:11px;margin-top:4px">${tagsHtml}</div>` : ''}
    ${imageHtml}
  </div>`
}

// ── Per-way classification (cacheable) ─────────────────────────────────────
//
// The candidate loop's classification is a PURE function of (tags, profileKey,
// regionRules). Tags never change for an osmId, so the outcome can be cached
// by osmId and reused across the many render re-runs a citywide load triggers
// (one per arriving tile). Without the cache the loop re-classifies every
// accumulated way on every tile arrival — O(n²) across the load (measured
// ~2.3 s cumulative main-thread for a 64-tile viewport; ~72 ms with the
// cache). isPreferred is deliberately NOT part of this outcome: it depends on
// preferredItemNames (the admin "show non-preferred" toggle), which can change
// without profileKey changing, so it's recomputed cheaply per render from the
// cached itemName.
type WayClassification =
  | { kind: 'skip' }                                         // control node / LTS4 / crossing
  | { kind: 'hiddenSurface'; rough: boolean }                // hidden surface (rough → cobble pass)
  | { kind: 'candidate'; itemName: string | null; pathLevel: PathLevel }

export function classifyOverlayWay(
  way: OsmWay,
  profileKey: string,
  regionRules?: ClassificationRule[],
): WayClassification {
  const { pathLevel: routingPathLevel } = classifyEdge(way.tags)
  // Motorway/trunk-class edges (LTS 4) are never browse-overlay candidates.
  if (routingPathLevel === '4') return { kind: 'skip' }
  // Crossing / traffic-island stubs are routing connectors but render as
  // disconnected confetti on the browse overlay — drop them.
  if (isOverlayCrossing(way.tags)) return { kind: 'skip' }
  if (isOverlayHiddenSurface(way.tags)) {
    return { kind: 'hiddenSurface', rough: isRoughSurface(way.tags) }
  }
  const itemName = classifyOsmTagsToItem(way.tags, profileKey, regionRules)
  const pathLevel = getDisplayPathLevel(itemName, profileKey, routingPathLevel)
  return { kind: 'candidate', itemName, pathLevel }
}

// ── Renderer ───────────────────────────────────────────────────────────────

interface RenderedWay {
  way: OsmWay
  /** Coordinates after per-zoom Douglas-Peucker decimation. Shared
   *  across all overlay passes (halo / hit / colour / stipple) so the
   *  simplification cost is paid once per render. */
  coords: [number, number][]
  pathLevel: PathLevel
  color: string
  weight: number
  opacity: number
  itemName: string | null
  isPreferred: boolean
  drawHalo: boolean
}

function OverlayRenderer({ engine, ways, profileKey, preferredItemNames, hasRoute, regionRules, loadedTileKeys }: {
  engine: MapEngine
  ways: OsmWay[]
  profileKey: string
  preferredItemNames: Set<string>
  hasRoute: boolean
  regionRules?: ClassificationRule[]
  /** Keys (overpass tileKey) of the OSM tiles currently loaded — feeds the
   *  moat filter's edge fail-soft so components at the boundary of coverage
   *  aren't hidden just because their access road isn't loaded yet. */
  loadedTileKeys: Set<string>
}) {
  const settings = useAdminSettings()
  const [zoom, setZoom] = useState<number>(() => engine.getZoom())
  // Partition: enriched ways (baked verdict inputs) never participate in
  // the runtime elevation/moat machinery below. When EVERY way is enriched
  // the runtime passes are skipped outright — zero elevation lookups, zero
  // union-find (measurable outcome 1 of the enriched-tiles plan). When no
  // way is enriched this array === ways contents and behaviour is
  // unchanged from the pre-enrichment overlay.
  const nonEnrichedWays = useMemo(() => ways.filter((w) => !isEnrichedWay(w)), [ways])
  // Bumped once the terrain-RGB tiles covering the loaded ways have been
  // fetched, so the render effect re-runs and the steepness gate can read
  // real elevations. Until then overlayGradientPct returns null and every
  // way shows (fail-soft) — steep ways simply pop out a beat later.
  const [elevReady, setElevReady] = useState(0)
  // Per-way gross gradient, cached by OSM id. Gradient depends only on
  // geometry + elevation, NOT on mode — so a mode switch or zoom that
  // re-runs the render effect reuses these instead of recomputing ~1600
  // lookups. NULL results are cached too, keyed by the elevReady generation
  // they were computed under — recomputing every unknown way on every
  // render was the #208 perf regression (the moat pass grades ALL fetched
  // ways, ~10× the painted set). A null entry from an older generation
  // recomputes once when new terrain lands; a `coarse` entry (z=10 data fed
  // it) recomputes once the z=12 tile over the way's midpoint arrives, so a
  // provisional over-ceiling reading can't keep a way hidden after fine
  // data that clears it.
  const gradientCache = useRef<Map<string | number, { pct: number | null; coarse: boolean; gen: number }>>(new Map())

  // Per-way classification cache (see classifyOverlayWay). Keyed by osmId;
  // cleared whenever the inputs that change the outcome (profileKey /
  // regionRules) change. Turns the candidate loop's per-tile-arrival cost
  // from O(n²) to O(n) across a citywide load.
  const classifyCache = useRef<Map<string | number, WayClassification>>(new Map())
  const classifyKeyRef = useRef<{ profileKey: string; regionRules?: ClassificationRule[] }>({ profileKey: '' })

  // Single gradient accessor shared by the moat effect and pass 0 below, so
  // both consumers see identical values and cache-refresh behaviour.
  const gradientFor = (way: OsmWay, elevGen: number): number | null => {
    const hit = gradientCache.current.get(way.osmId)
    if (hit) {
      if (hit.pct != null && !hit.coarse) return hit.pct
      if (hit.pct == null && hit.gen === elevGen) return null
      // Coarse non-null or stale null: recompute only if the situation
      // could have changed (fine data arrived / new elevation generation).
      const mid = way.coordinates[Math.floor(way.coordinates.length / 2)]
      const fineNow = mid != null && hasFineElevationAt(mid[0], mid[1])
      if (hit.pct != null && hit.coarse && !fineNow) return hit.pct
    }
    const mid = way.coordinates[Math.floor(way.coordinates.length / 2)]
    const fine = mid != null && hasFineElevationAt(mid[0], mid[1])
    const pct = overlayGradientPct(way.coordinates)
    gradientCache.current.set(way.osmId, { pct, coarse: !fine, gen: elevGen })
    return pct
  }

  // Zoom drives cobble-marker visibility. Subscribe via the engine's
  // event facade rather than the underlying Leaflet/Google APIs.
  useEffect(() => {
    const off = engine.on('zoomend', (ev) => {
      if (ev.type === 'zoomend') setZoom(ev.zoom)
    })
    return () => { off() }
  }, [engine])

  // Prefetch terrain-RGB tiles for the steepness gate. Bounded to the
  // VISIBLE viewport (engine.getBounds()), NOT the union of all loaded
  // ways: tileData accumulates across pans and a single OSM way with an
  // outlier node can span the bbox across a continent, which would make
  // prefetchElevation fire thousands of tile requests and stall the page.
  // The viewport is always small (≤ MAX_FETCH_TILES). Off-screen ways
  // fail soft (null gradient → shown) until the user pans to them.
  // Re-runs when ways change (i.e. a pan loaded new tiles). Tiles are
  // cached in-memory and shared with the router. Enriched ways carry their
  // gradient baked-in, so terrain is only fetched when at least one RAW way
  // needs runtime grading — a fully-enriched viewport does zero elevation
  // work here.
  useEffect(() => {
    if (nonEnrichedWays.length === 0) return
    const [sw, ne] = engine.getBounds()
    const bbox = { south: sw[0], west: sw[1], north: ne[0], east: ne[1] }
    if (![bbox.south, bbox.west, bbox.north, bbox.east].every(Number.isFinite)) return
    let cancelled = false
    void prefetchElevation(bbox)
      .then(() => { if (!cancelled) setElevReady((v) => v + 1) })
    return () => { cancelled = true }
  }, [nonEnrichedWays, engine])

  // Moat-isolated way ids: painted ways whose connected component is
  // reachable only via a too-steep climb (a "steep moat" — e.g. a flat
  // hilltop park loop). Display-only: the router still prices these ways
  // ascent-aware; see overlayReachability.ts. Recomputed only when the
  // inputs that can change connectivity change — NOT on zoom / hasRoute /
  // style re-renders. Every FETCHED way participates as a connector
  // (including ways the overlay never paints): the question is physical
  // access, not pleasantness. Untagged arterials are absent from the
  // Overpass query entirely, so the filter demands positive moat evidence
  // (a bordering too-steep way) before hiding — see the module header.
  // Computed OFF the tile-arrival hot path: the union-find + gradient pass
  // covers every fetched way, and running it synchronously inside render
  // (the #208 useMemo) janked the map on every tile load at metro zoom.
  // Idle-scheduled instead; until the result lands the set is empty, which
  // fail-softs to SHOWN — steep networks pop out a beat later, matching the
  // elevReady behaviour above.
  // Runs ONLY over non-enriched ways: enriched ways carry accessGradientPct
  // (the baked minimax replacement for the moat verdict) and never consult
  // this set. A fully-enriched viewport skips the pass entirely — no idle
  // work, no union-find. Mixed viewports lose the enriched ways as
  // connectors for the RAW ways' moat graph; that's fail-soft in the
  // showing direction (fewer connections can only be rescued by the
  // no-steep-border-evidence rule and the edge fail-soft, both of which
  // bias toward SHOWN), and mixed viewports only occur at the boundary of
  // enriched coverage where the edge fail-soft already applies.
  const [moatIsolated, setMoatIsolated] = useState<Set<string | number>>(() => new Set())
  useEffect(() => {
    if (nonEnrichedWays.length === 0) {
      setMoatIsolated((prev) => (prev.size === 0 ? prev : new Set()))
      return
    }
    let cancelled = false
    const run = () => {
      if (cancelled) return
      const result = computeMoatIsolation(nonEnrichedWays, {
        maxGradientPct: getOverlayMaxGradientPct(profileKey),
        pushBudgetM: settings.steepApproachPushM,
        // Same per-way gradient accessor as pass 0 below — the two
        // consumers share cache hits and refresh behaviour. elevReady is
        // the cache generation: when terrain lands, stale null gradients
        // recompute exactly once.
        gradientPct: (way) => gradientFor(way, elevReady),
        isTileLoaded: (row, col) => loadedTileKeys.has(tileKey(row, col)),
      })
      if (!cancelled) setMoatIsolated(result)
    }
    // Safari still lacks requestIdleCallback; fall back to a short timeout.
    const hasIdle = typeof window.requestIdleCallback === 'function'
    const handle = hasIdle
      ? window.requestIdleCallback(run, { timeout: 2000 })
      : window.setTimeout(run, 50)
    return () => {
      cancelled = true
      if (hasIdle) window.cancelIdleCallback(handle)
      else window.clearTimeout(handle)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonEnrichedWays, profileKey, settings.steepApproachPushM, elevReady, loadedTileKeys])

  useEffect(() => {
    const polylineHandles: PolylineHandle[] = []
    const pathLayerHandles: PathLayerHandle[] = []
    let openPopup: PopupHandle | null = null

    const BROWSING_WEIGHT = 4

    // Deterministic per-zoom render policy (pure function of zoom). Below the
    // overview cutoff we drop the halo + finger-tap layers and thin the
    // strokes — at city-overview zoom those are visual noise AND triple the
    // deck.gl work (three layers per way vs one). At z >= OVERVIEW_MAX_ZOOM
    // the style is the identity, so metro/street zooms paint exactly as
    // before this change.
    const ovStyle = overviewStyle(zoom)

    // Max gross gradient this mode tolerates on the browse overlay. Steeper
    // shown ways (e.g. 20% `highway=path` hiking trails) are hidden.
    const maxGradientPct = getOverlayMaxGradientPct(profileKey)

    // Invalidate the classification cache when the inputs that change a way's
    // itemName/pathLevel change. Tags are immutable per osmId, so nothing else
    // can alter the cached outcome.
    if (
      classifyKeyRef.current.profileKey !== profileKey ||
      classifyKeyRef.current.regionRules !== regionRules
    ) {
      classifyCache.current.clear()
      classifyKeyRef.current = { profileKey, regionRules }
    }

    // Pass 0a — classify + gate each painted candidate. Verdicts:
    //   hidden  — the way's own gradient exceeds the ceiling, or the moat
    //             filter / baked access gradient isolated it, or (enriched)
    //             its baked component length is under the fragment floor
    //   unknown — RAW ways only — gradient null: terrain not loaded yet,
    //             or the way is below the noise floor (too short to grade)
    //   shown   — graded and within the ceiling
    // Enriched ways get their verdict from pure arithmetic over the baked
    // fields (enrichedWayVerdict) and are never 'unknown'. Unknown RAW ways
    // are NOT painted immediately: a stub below the noise floor whose whole
    // graded context is hidden must inherit that verdict (pass 0b), or the
    // map fills with white-halo pill confetti wherever the gates shred a
    // hillside network — the #208→#209 revert artifact.
    interface Candidate {
      way: OsmWay
      verdict: OverlayVerdict
      itemName: string | null
      pathLevel: PathLevel
      /** True = arithmetic gate; false = runtime moat/stub/fragment path. */
      enriched: boolean
    }
    const gateOptions: EnrichedGateOptions & RuntimeGateInputs = {
      maxGradientPct,
      steepApproachPushM: settings.steepApproachPushM,
      fragmentFloorActive: zoom < FRAGMENT_SHOW_MIN_ZOOM,
      gradientPct: (w) => gradientFor(w, elevReady),
      moatIsolated,
    }
    const candidates: Candidate[] = []
    const roughWays: OsmWay[] = []
    for (const way of ways) {
      // Traffic-control pseudo-ways (single-coordinate signal/stop nodes in
      // the tile payload — see isControlNode) are router input, not paint.
      if (way.coordinates.length < 2) continue
      // Classification (classifyEdge + crossing/surface checks + item lookup)
      // is cached by osmId — see classifyOverlayWay. Only the parts that
      // depend on live gradient/moat state (overlayWayVerdict below) and
      // preferredItemNames (isPreferred) are recomputed each render.
      let cls = classifyCache.current.get(way.osmId)
      if (cls === undefined) {
        cls = classifyOverlayWay(way, profileKey, regionRules)
        classifyCache.current.set(way.osmId, cls)
      }
      if (cls.kind === 'skip') continue
      if (cls.kind === 'hiddenSurface') {
        // Surface IS rough — keep it for the cobble-marker pass.
        if (cls.rough) roughWays.push(way)
        continue
      }
      const { itemName, pathLevel } = cls
      const isPreferred = itemName !== null && preferredItemNames.has(itemName)
      // Overlay shows ONLY items the active mode prefers. Items at a
      // preferred LEVEL but flagged non-preferred for this mode (e.g.
      // 'Protected bike lane on major road' for kid-confident — still
      // pathLevel '1a' but the legend opts the mode out) are hidden
      // here too. Non-preferred ways still render on the route polyline
      // (see useRoutePolylines in Map.tsx) so users see every segment
      // along their actual route regardless of overlay visibility.
      if (!isPreferred) continue
      // Visibility gate — dispatched per way: enriched ways use the baked
      // arithmetic gate (own gradient + minimax access + component fragment
      // floor); RAW ways use the runtime local-gradient + moat path. All
      // display-only.
      const verdict = overlayWayVerdict(way, gateOptions)
      candidates.push({ way, verdict, itemName, pathLevel, enriched: isEnrichedWay(way) })
    }

    // Pass 0b — stub verdict inheritance, RAW ways only: an ungradable way
    // (below the noise floor) whose entire graded painted adjacency is
    // hidden inherits 'hidden'; touching any shown way, or having no graded
    // context at all, keeps it shown. See inheritStubVerdicts in
    // overlayReachability.ts. Enriched ways never participate — their
    // verdict is definite (never 'unknown') and the bake already gave
    // sub-noise-floor stubs their component's context.
    const runtimeCandidates = candidates.filter((c) => !c.enriched)
    const verdictByOsmId = new Map<string | number, Candidate['verdict']>()
    for (const c of runtimeCandidates) verdictByOsmId.set(c.way.osmId, c.verdict)
    const stubHidden = inheritStubVerdicts(
      runtimeCandidates.map((c) => c.way),
      (way) => verdictByOsmId.get(way.osmId) ?? 'unknown',
    )

    // Pass 0c — style the survivors.
    // Pass 0b2 — floating-fragment floor, RAW ways only. Surviving painted
    // components whose total length is under FRAGMENT_MIN_LEN_M read as
    // noise at overview zooms ("floating short segments" — Bryan,
    // 2026-07-03): real routing connectors, but not advertisable
    // infrastructure. Hidden below FRAGMENT_SHOW_MIN_ZOOM only;
    // street-detail zooms show everything. Display-only. Enriched ways are
    // already fragment-gated arithmetically via componentPaintedLenM inside
    // enrichedWayVerdict (the baked field sees the whole region's
    // component, not just the loaded viewport), so they skip this
    // viewport-local union-find.
    const survivors = candidates.filter(
      (c) => c.verdict !== 'hidden' && !(c.verdict === 'unknown' && stubHidden.has(c.way.osmId)),
    )
    const runtimeSurvivors = survivors.filter((c) => !c.enriched)
    const smallFragments = zoom < FRAGMENT_SHOW_MIN_ZOOM
      ? smallFragmentIds(runtimeSurvivors.map((c) => c.way), FRAGMENT_MIN_LEN_M)
      : new Set<string | number>()

    const toRender: RenderedWay[] = []
    for (const { way, itemName, pathLevel } of survivors) {
      if (smallFragments.has(way.osmId)) continue
      const color = colorForLevel(pathLevel, settings.tiers)
      const isBikeInfraTier = pathLevel === '1a' || pathLevel === '1b' || pathLevel === '2a'
      const browsingWeight = BROWSING_WEIGHT * weightMultiplierForLevel(pathLevel, settings.tiers)
      const weightScaled = hasRoute && isBikeInfraTier
        ? browsingWeight * 0.8
        : hasRoute
          ? browsingWeight * 0.75
          : browsingWeight
      const weight = Math.max(2, Math.round(weightScaled * ovStyle.strokeScale))
      const opacity = hasRoute && isBikeInfraTier
        ? settings.overlayOpacityBrowsing * 0.8
        : hasRoute
          ? settings.overlayOpacityWithRoute
          : settings.overlayOpacityBrowsing
      // Halos are dropped at overview zoom (ovStyle.drawHalo=false) — see
      // overlayZoom.ts. Above the cutoff this is exactly isBikeInfraTier.
      const drawHalo = isBikeInfraTier && ovStyle.drawHalo
      // Decimate the geometry once per render. All overlay passes
      // (halo, hit-area, colour, plus the stipple pass for rough
      // ways) share this simplified path so the GPU vertex count
      // collapses at low zoom. At z >= 16 simplifyPath returns the
      // input unchanged so taps still hit precise geometry.
      const coords = simplifyPath(way.coordinates, zoom)
      toRender.push({ way, coords, pathLevel, color, weight, opacity, itemName, isPreferred: true, drawHalo })
    }

    // Index toRender by way.id so the click handler can dispatch from
    // the deck.gl PathLayer's onClick — feature.id is echoed back to us.
    const wayIndex = new Map<string | number, RenderedWay>()
    for (const r of toRender) wayIndex.set(r.way.osmId, r)

    // Resolve street-level imagery for an already-open popup and fill it in.
    // Street View where Google has coverage, else Mapillary, else nothing —
    // so coverage gaps don't show a gray "no imagery" tile. Async (a free
    // metadata coverage check runs first), so we re-check the popup is still
    // the active one before updating: the user may have clicked away.
    const fillPopupImagery = (
      handle: PopupHandle,
      mid: [number, number],
      render: (imgUrl: string | null, credit: string | null) => string,
    ) => {
      void resolveStreetImagery(mid[0], mid[1]).then((r) => {
        if (openPopup !== handle) return
        engine.updatePopup(handle, render(r.url ?? null, r.credit ?? null))
      })
    }

    const openSegmentPopup = (r: RenderedWay) => {
      if (openPopup) engine.closePopup(openPopup)
      const mid = r.way.coordinates[Math.floor(r.way.coordinates.length / 2)]
      const handle = engine.openPopup(
        mid,
        buildTooltipHtml(r.itemName, r.way.tags, r.isPreferred, null),
        {
          maxWidth: 260,
          className: 'bike-segment-popup',
          onClose: () => { if (openPopup === handle) openPopup = null },
        },
      )
      openPopup = handle
      fillPopupImagery(handle, mid, (imgUrl, credit) =>
        buildTooltipHtml(r.itemName, r.way.tags, r.isPreferred, imgUrl, credit))
    }

    // Pass 1 — halos. Done first (lowest z-order) so a later coloured
    // polyline isn't overpainted by a neighbour's halo at shared
    // junction nodes. Drawn in a single bulk PathLayer for perf.
    const haloFeatures: PathLayerFeature[] = []
    for (const r of toRender) {
      if (!r.drawHalo) continue
      haloFeatures.push({
        id: 'halo:' + r.way.osmId,
        coordinates: r.coords,
        color: '#ffffff',
        width: r.weight + settings.overlayHaloExtra,
        opacity: r.opacity,
      })
    }
    if (haloFeatures.length > 0) {
      pathLayerHandles.push(engine.addPathLayer(haloFeatures))
    }

    // Pass 2a — invisible wide hit-area layer for finger taps. Sits
    // above halos but below the visible colour, with full hit width
    // (HIT_POLYLINE_WEIGHT). deck.gl picks at rendered geometry, so
    // we need this dedicated layer for forgiving mobile taps. Skipped at
    // overview zoom (ovStyle.interactive=false): a 24px tap target spans
    // kilometres there so per-segment picking is meaningless, and dropping
    // the layer removes a full deck.gl PathLayer + its picking cost.
    if (ovStyle.interactive) {
      const hitFeatures: PathLayerFeature[] = toRender.map((r) => ({
        id: r.way.osmId,
        coordinates: r.coords,
        color: '#000000',
        width: HIT_POLYLINE_WEIGHT,
        opacity: 0,
        meta: r,
      }))
      if (hitFeatures.length > 0) {
        pathLayerHandles.push(engine.addPathLayer(hitFeatures, {
          onClick: (id) => {
            const r = wayIndex.get(id)
            if (r) openSegmentPopup(r)
          },
        }))
      }
    }

    // Pass 2b — visible coloured polylines (top z-order of pass 2).
    const colorFeatures: PathLayerFeature[] = toRender.map((r) => ({
      id: 'color:' + r.way.osmId,
      coordinates: r.coords,
      color: r.color,
      width: r.weight,
      opacity: r.opacity,
    }))
    if (colorFeatures.length > 0) {
      pathLayerHandles.push(engine.addPathLayer(colorFeatures))
    }

    // Pass 3 — rough-surface stipple overlay. A fine grey dashed
    // polyline drawn along the way's geometry signals "rough / bumpy"
    // without the visual noise of an emoji marker. The stipple texture
    // reads at-a-glance as a different surface; it's quiet at city
    // overview zooms, distinct at street-detail zooms. Gated on zoom
    // so the overview map stays clean. (Replaced the prior 🪨 emoji
    // marker per Joanna's UX feedback 2026-04-30 — the icons read as
    // arbitrary visual noise; a textured overlay matches the
    // navigational meaning much better.)
    if (zoom >= COBBLE_MARKER_MIN_ZOOM) {
      for (const way of roughWays) {
        if (way.coordinates.length < 2) continue
        const onClick = () => {
          if (openPopup) engine.closePopup(openPopup)
          const mid = way.coordinates[Math.floor(way.coordinates.length / 2)]
          const popupHandle = engine.openPopup(
            mid,
            buildTooltipHtml('Rough surface', way.tags, false, null),
            {
              maxWidth: 260,
              className: 'bike-segment-popup',
              onClose: () => { if (openPopup === popupHandle) openPopup = null },
            },
          )
          openPopup = popupHandle
          fillPopupImagery(popupHandle, mid, (imgUrl, credit) =>
            buildTooltipHtml('Rough surface', way.tags, false, imgUrl, credit))
        }
        polylineHandles.push(engine.addPolyline(
          way.coordinates,
          {
            color: '#6b7280',          // grey-500
            weight: 5,
            opacity: 0.85,
            // Fine stipple — short dash + short gap reads as "wavy /
            // textured surface", distinct from the longer dash we use
            // for alternate routes (10 6).
            dashArray: '1 4',
            useCanvasRenderer: true,
          },
          { onClick },
        ))
      }
    }

    return () => {
      for (const h of polylineHandles) engine.removePolyline(h)
      for (const h of pathLayerHandles) engine.removePathLayer(h)
      if (openPopup) engine.closePopup(openPopup)
    }
  }, [engine, ways, profileKey, preferredItemNames, hasRoute, regionRules, settings, zoom, elevReady, moatIsolated])

  return null
}

// ── Tile loader ───────────────────────────────────────────────────────────

interface ControllerProps {
  enabled: boolean
  profileKey: string
  preferredItemNames: Set<string>
  hasRoute: boolean
  onStatusChange: (status: string) => void
  regionRules?: ClassificationRule[]
}

function OverlayController({ enabled, profileKey, preferredItemNames, hasRoute, onStatusChange, regionRules }: ControllerProps) {
  const engine = useMapEngine()
  // Ways by tile key. Keys are level-namespaced: `row:col` (0.1° detail tiles,
  // tileKey) and `ov:row:col` (1.0° overview cells, overviewCellKey). Both
  // levels can be resident at once (a zoom-out after browsing at street zoom
  // leaves detail tiles cached) — activeKeys, not this map, decides what paints.
  const [tileData, setTileData] = useState<Map<string, OsmWay[]>>(new Map())
  // The tile keys the CURRENT viewport+zoom selected. Painting is scoped to
  // these, so (a) the two levels never double-plot the same geometry, and
  // (b) paint stays a pure function of (viewport, zoom) — leftovers from
  // earlier navigation don't leak onto the map.
  const [activeKeys, setActiveKeys] = useState<string[]>([])

  const loadingTilesRef = useRef<Set<string>>(new Set())
  const loadedTilesRef  = useRef<Set<string>>(new Set())
  const generationRef   = useRef(0)

  /** Fetch the 0.1° detail tiles (today's path, unchanged) into tileData. */
  const loadDetailTiles = useCallback(async (
    tiles: Tile[],
    generation: number,
  ): Promise<{ anyError: boolean }> => {
    const toLoad = tiles.filter((t) => {
      const k = tileKey(t.row, t.col)
      return !loadedTilesRef.current.has(k) && !loadingTilesRef.current.has(k)
    })
    if (toLoad.length === 0) return { anyError: false }

    for (const t of toLoad) loadingTilesRef.current.add(tileKey(t.row, t.col))
    let anyError = false
    await Promise.all(toLoad.map(async (t) => {
      const k = tileKey(t.row, t.col)
      try {
        const ways = await fetchBikeInfraForTile(t.row, t.col)
        if (generationRef.current !== generation) return
        loadedTilesRef.current.add(k)
        setTileData((prev) => { const next = new Map(prev); next.set(k, ways); return next })
      } catch (err) {
        console.warn(`[BikeMapOverlay] Tile ${t.row}:${t.col} failed:`, err)
        anyError = true
      } finally {
        loadingTilesRef.current.delete(k)
      }
    }))
    return { anyError }
  }, [])

  const loadVisibleTiles = useCallback(async () => {
    if (!engine || !enabled) return
    const [sw, ne] = engine.getBounds()
    const bounds = {
      getSouth: () => sw[0], getNorth: () => ne[0],
      getWest:  () => sw[1], getEast:  () => ne[1],
    }
    const center: [number, number] = [(sw[0] + ne[0]) / 2, (sw[1] + ne[1]) / 2]
    const zoom = engine.getZoom()
    const generation = generationRef.current
    onStatusChange('loading')

    // ── Overview level (z < OVERVIEW_MAX_ZOOM) ────────────────────────────
    // Baked 1.0° cells: the bike-infra network at simplified geometry. A cell
    // that isn't baked (Berlin) answers 404 → fetchOverviewTile returns null
    // → we fall back to the 0.1° path FOR THAT CELL ONLY. When no cell is
    // baked (all of Berlin) that fallback selects exactly the tiles today's
    // code selects, so an un-baked region is unchanged at every zoom.
    if (zoom < OVERVIEW_MAX_ZOOM) {
      const cells = selectFetchTiles(
        getVisibleOverviewCells(bounds), center, MAX_OVERVIEW_TILES, OVERVIEW_TILE_DEGREES,
      )
      // Paint what's already cached immediately; the rest lands as it arrives.
      setActiveKeys(cells.map((c) => overviewCellKey(c.row, c.col)))

      const results = await Promise.all(cells.map(async (c) => ({
        cell: c,
        ways: await fetchOverviewTile(c.row, c.col),
      })))
      if (generationRef.current !== generation) return

      const baked = results.filter((r) => r.ways != null)
      if (baked.length > 0) {
        setTileData((prev) => {
          const next = new Map(prev)
          for (const r of baked) {
            const k = overviewCellKey(r.cell.row, r.cell.col)
            next.set(k, r.ways!)
            loadedTilesRef.current.add(k)
          }
          return next
        })
      }

      const unbaked = results.filter((r) => r.ways == null).map((r) => r.cell)
      let anyError = false
      let detailKeys: string[] = []
      if (unbaked.length > 0) {
        // 0.1° fallback, restricted to the un-baked cells and selected with
        // the SAME deterministic nearest-to-centre rule as the detail path.
        const unbakedKeys = new Set(unbaked.map((c) => overviewCellKey(c.row, c.col)))
        const inUnbaked = getVisibleTiles(bounds).filter((t) => {
          const parent = overviewCellForTile(t.row, t.col)
          return unbakedKeys.has(overviewCellKey(parent.row, parent.col))
        })
        const tiles = selectFetchTiles(inUnbaked, center, MAX_FETCH_TILES)
        detailKeys = tiles.map((t) => tileKey(t.row, t.col))
        setActiveKeys([
          ...baked.map((r) => overviewCellKey(r.cell.row, r.cell.col)),
          ...detailKeys,
        ])
        const res = await loadDetailTiles(tiles, generation)
        anyError = res.anyError
      }

      if (generationRef.current !== generation) return
      const hasAnyVisibleData =
        baked.length > 0 || detailKeys.some((k) => loadedTilesRef.current.has(k))
      if (anyError && !hasAnyVisibleData) onStatusChange('error')
      else                                onStatusChange('ok')
      return
    }

    // ── Detail level (z >= OVERVIEW_MAX_ZOOM) — unchanged ─────────────────
    // Fetch every visible tile up to a deterministic budget. When the
    // viewport spans more than MAX_FETCH_TILES, selectFetchTiles keeps the
    // budget-nearest-to-centre subset — a PURE function of (viewport), so a
    // zoomed-out user fetches (and paints) the same tiles a zoomed-in user
    // would for the identical viewport.
    const tiles = selectFetchTiles(getVisibleTiles(bounds), center, MAX_FETCH_TILES)
    setActiveKeys(tiles.map((t) => tileKey(t.row, t.col)))
    const { anyError } = await loadDetailTiles(tiles, generation)

    if (generationRef.current !== generation) return
    const hasAnyVisibleData = tiles.some((t) =>
      loadedTilesRef.current.has(tileKey(t.row, t.col)) || isTileCached(t.row, t.col)
    )
    if (anyError && !hasAnyVisibleData) onStatusChange('error')
    else                                onStatusChange('ok')
  }, [enabled, engine, onStatusChange, loadDetailTiles])

  // Subscribe to map move/zoom/resize via the engine event API.
  useEffect(() => {
    if (!engine) return
    const debounce = (ms: number, fn: () => void) => {
      let t: ReturnType<typeof setTimeout> | null = null
      return () => {
        if (t) clearTimeout(t)
        t = setTimeout(fn, ms)
      }
    }
    const onMove   = debounce(400, loadVisibleTiles)
    const onZoom   = debounce(400, loadVisibleTiles)
    const onResize = debounce(200, loadVisibleTiles)
    const offMove   = engine.on('moveend', onMove)
    const offZoom   = engine.on('zoomend', onZoom)
    const offResize = engine.on('resize',  onResize)
    return () => { offMove(); offZoom(); offResize() }
  }, [engine, loadVisibleTiles])

  // Initial mount: prime from in-memory cache, then load missing tiles.
  useEffect(() => {
    if (!engine) return
    if (enabled) {
      generationRef.current++
      loadingTilesRef.current = new Set()
      loadedTilesRef.current = new Set()
      engine.invalidateSize()
      const raf = requestAnimationFrame(() => {
        engine.invalidateSize()
        const [sw, ne] = engine.getBounds()
        const bounds = {
          getSouth: () => sw[0], getNorth: () => ne[0],
          getWest:  () => sw[1], getEast:  () => ne[1],
        }
        // Prime from cache using the SAME deterministic subset (and the same
        // level) the fetch path uses, so the initial paint matches what
        // loadVisibleTiles will load.
        const center: [number, number] = [(sw[0] + ne[0]) / 2, (sw[1] + ne[1]) / 2]
        const zoom = engine.getZoom()
        const preloaded = new Map<string, OsmWay[]>()
        if (zoom < OVERVIEW_MAX_ZOOM) {
          const cells = selectFetchTiles(
            getVisibleOverviewCells(bounds), center, MAX_OVERVIEW_TILES, OVERVIEW_TILE_DEGREES,
          )
          for (const c of cells) {
            const cached = getCachedOverviewCell(c.row, c.col)
            if (cached) {
              const k = overviewCellKey(c.row, c.col)
              preloaded.set(k, cached)
              loadedTilesRef.current.add(k)
            }
          }
          setActiveKeys(cells.map((c) => overviewCellKey(c.row, c.col)))
        } else {
          const tiles = selectFetchTiles(getVisibleTiles(bounds), center, MAX_FETCH_TILES)
          for (const t of tiles) {
            const cached = getCachedTile(t.row, t.col)
            if (cached) {
              const k = tileKey(t.row, t.col)
              preloaded.set(k, cached)
              loadedTilesRef.current.add(k)
            }
          }
          setActiveKeys(tiles.map((t) => tileKey(t.row, t.col)))
        }
        setTileData(preloaded)
        loadVisibleTiles()
      })
      return () => { cancelAnimationFrame(raf) }
    } else {
      generationRef.current++
      loadingTilesRef.current = new Set()
      loadedTilesRef.current = new Set()
      setTileData(new Map())
      setActiveKeys([])
      onStatusChange('idle')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, engine])

  // Painted set = the ways of the tiles the CURRENT viewport+zoom selected.
  // Scoping to activeKeys (rather than every tile ever loaded) is what keeps
  // the two levels from double-plotting the same geometry after a zoom
  // crossing, and keeps paint a pure function of (viewport, zoom).
  const allWays = useMemo<OsmWay[]>(() => {
    const result: OsmWay[] = []
    for (const k of activeKeys) {
      const ways = tileData.get(k)
      if (ways) for (const w of ways) result.push(w)
    }
    return result
  }, [tileData, activeKeys])

  // The moat filter's edge fail-soft needs to know which 0.1° OSM tiles are
  // loaded. Overview cells are excluded: their ways are all enriched (baked
  // verdicts), so they never consult this set — and their keys aren't on the
  // 0.1° grid the moat pass indexes by.
  const loadedTileKeys = useMemo(
    () => new Set(activeKeys.filter((k) => !isOverviewCellKey(k) && tileData.has(k))),
    [tileData, activeKeys],
  )

  if (!engine || !enabled || allWays.length === 0) return null
  return (
    <OverlayRenderer
      engine={engine}
      ways={allWays}
      profileKey={profileKey}
      preferredItemNames={preferredItemNames}
      hasRoute={hasRoute}
      regionRules={regionRules}
      loadedTileKeys={loadedTileKeys}
    />
  )
}

// ── Public component (unchanged shape) ────────────────────────────────────

interface Props {
  enabled: boolean
  profileKey: string
  preferredItemNames: Set<string>
  hasRoute: boolean
  onStatusChange: (status: string) => void
  regionRules?: ClassificationRule[]
}

export default function BikeMapOverlay(props: Props) {
  return <OverlayController {...props} />
}
