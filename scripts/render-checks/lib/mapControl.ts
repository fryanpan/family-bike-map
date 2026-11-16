// Drive the app to a specific map viewport.
//
// URL-first, with a programmatic fallback: as of 2026-07-11 the app does
// NOT read lat/lng/zoom from the URL (only ?travelMode= and ?mobile= are
// wired — see App.tsx getInitialState / the URL-sync effect). A sibling
// PR (feat/shareable-url-state) is expected to add full URL view state.
// setView() below tries the URL first and VERIFIES it actually landed by
// reading the map's real center/zoom back out afterward; if it didn't
// (today, always), it falls back to driving the MapEngine directly via
// window.__mapEngine (see the render-check hook in src/components/Map.tsx)
// — no code change needed here once the URL param lands, since the
// verification step will just start succeeding on the URL path.

import type { Page } from 'playwright'

export interface ViewState {
  lat: number
  lng: number
  zoom: number
}

/**
 * Best-effort "let the network settle" wait. Playwright's strict
 * `waitUntil: 'networkidle'` throws on timeout, which is too fragile for
 * this app in practice — Sentry/Plausible beacons and the overlay's own
 * tile-fetch cascade at wide zooms can keep SOME request in flight past
 * the 500ms-idle window Playwright wants, well past a reasonable check
 * budget. Callers that need actual paint-settle time layer an explicit
 * `page.waitForTimeout(...)` on top (see always-visible.ts / time-
 * stability.ts) rather than depending on this to mean "fully done."
 */
export async function waitForNetworkSettled(page: Page, timeoutMs = 15000): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {
    console.warn(`[render-checks] networkidle wait timed out after ${timeoutMs}ms — continuing anyway`)
  })
}

/**
 * Wait until the app's own tile-loading indicator
 * (`.tile-loading-boxes`, src/components/TileLoadingBoxes.tsx) reports no
 * tiles queued or in flight — a much more reliable "the overlay has
 * actually finished painting" signal than a fixed timeout or
 * `networkidle`. A cold cache (every render-check run: wrangler dev spins
 * up fresh local R2/D1/cache state, see README.md) can take several
 * seconds per Overpass tile fetch, and a too-short fixed wait undercounts
 * painted pixels non-deterministically — caught during harness
 * calibration when the SAME viewport read 360, 1396, then 3152 painted px
 * across three runs with only a 5-6s fixed wait.
 *
 * `TileLoadingBoxes` renders `null` (no `.tile-loading-boxes` element at
 * all) once `status.active` is false, so "element absent" is the signal,
 * not "element empty."
 */
export async function waitForTilesSettled(page: Page, timeoutMs = 15000): Promise<void> {
  // Two-phase: `waitForSelector(..., {state: 'hidden'})` resolves
  // IMMEDIATELY (as a no-op) if the element was never attached at all —
  // which is exactly what happens when tiles finish loading fast enough
  // that the indicator never mounts before this function starts polling.
  // Phase 1 gives loading a short window to actually start (so phase 2's
  // "wait for it to clear" has something real to wait on); if it never
  // shows up, there's nothing in flight and we're done.
  const appeared = await page.waitForSelector('.tile-loading-boxes', { state: 'attached', timeout: 3000 })
    .then(() => true)
    .catch(() => false)
  if (appeared) {
    // Best-effort, not a hard gate: calibration (2026-07-11, cold
    // wrangler-dev cache) found the painted-pixel count stabilizes
    // within ~10s in every case tested, but `.tile-loading-boxes` itself
    // can stay attached indefinitely — a single slow/retrying tile keeps
    // `status.active` true even after every OTHER tile has resolved and
    // painted. Waiting for a hard zero here would make every check as
    // slow as the single worst tile, for no accuracy gain over the
    // ~10s convergence window already observed. 15s covers that window
    // with margin; the timeout firing is expected background noise, not
    // a sign of a stuck check.
    await page.waitForSelector('.tile-loading-boxes', { state: 'hidden', timeout: timeoutMs }).catch(() => {
      console.warn(`[render-checks] tile-loading indicator still active after ${timeoutMs}ms — continuing anyway (expected; see waitForTilesSettled comment)`)
    })
  }
  // One extra beat: the overlay's classify/gate/simplify pass (React state
  // update -> re-render) trails the tile fetch completing by a tick.
  await page.waitForTimeout(500)
}

const VIEW_TOLERANCE = { latLng: 0.01, zoom: 0.5 }

/** Sets window.__RENDER_CHECK__ before any app script runs, so the Map.tsx
 *  hook exposes window.__mapEngine once mounted. Call once per page. */
export async function armRenderCheckHook(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __RENDER_CHECK__: boolean }).__RENDER_CHECK__ = true
    // Dismiss the IntroCard (src/components/IntroCard.tsx) before it can
    // mount. It renders as a centered card on desktop and a near-fullscreen
    // bottom sheet on mobile, sitting INSIDE the [data-testid="map-canvas"]
    // container that screenshotMapCanvas crops to — so leaving it up means
    // every check measures only the paint peeking out around it. At phone
    // width that is almost the whole map: a Mission viewport read 13 painted
    // px of the 2a tier with the card up and 17,898 with it dismissed.
    try { localStorage.setItem('bike-route-intro-dismissed', '1') } catch { /* storage blocked */ }
  })
}

async function readCurrentView(page: Page): Promise<ViewState | null> {
  return page.evaluate(() => {
    const eng = (window as unknown as {
      __mapEngine?: { getCenter(): [number, number]; getZoom(): number }
    }).__mapEngine
    if (!eng) return null
    const [lat, lng] = eng.getCenter()
    return { lat, lng, zoom: eng.getZoom() }
  })
}

/** Drive window.__mapEngine.setView directly. Exported so other checks
 *  (perf-budget.ts) that need a raw "jump the map" interaction, without
 *  the URL-first navigation ceremony of gotoView, can reuse it. */
export async function setEngineView(page: Page, view: ViewState): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __mapEngine?: unknown }).__mapEngine != null, { timeout: 15000 })
  await page.evaluate((v: ViewState) => {
    const eng = (window as unknown as { __mapEngine: { setView(c: [number, number], z?: number): void } }).__mapEngine
    eng.setView([v.lat, v.lng], v.zoom)
  }, view)
}

function closeEnough(a: ViewState, b: ViewState): boolean {
  return (
    Math.abs(a.lat - b.lat) <= VIEW_TOLERANCE.latLng &&
    Math.abs(a.lng - b.lng) <= VIEW_TOLERANCE.latLng &&
    Math.abs(a.zoom - b.zoom) <= VIEW_TOLERANCE.zoom
  )
}

function urlFor(baseUrl: string, view: ViewState, extraParams: Record<string, string> = {}): string {
  const url = new URL(baseUrl)
  url.searchParams.set('lat', view.lat.toFixed(6))
  url.searchParams.set('lng', view.lng.toFixed(6))
  url.searchParams.set('zoom', String(view.zoom))
  for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v)
  return url.toString()
}

/**
 * Navigate to `baseUrl` and land on `view`. Tries putting lat/lng/zoom in
 * the URL (the shape a future shareable-URL-state feature is expected to
 * read); if the map doesn't actually land there, falls back to calling
 * MapEngine.setView directly via window.__mapEngine. Waits for
 * networkidle both ways so overlay tiles have had a chance to fetch.
 */
export async function gotoView(page: Page, baseUrl: string, view: ViewState, extraParams: Record<string, string> = {}): Promise<{ viaUrl: boolean }> {
  await armRenderCheckHook(page)
  await page.goto(urlFor(baseUrl, view, extraParams), { waitUntil: 'load' })
  await waitForNetworkSettled(page)

  const landed = await readCurrentView(page)
  if (landed && closeEnough(landed, view)) return { viaUrl: true }

  // Fallback: URL state isn't wired yet (or didn't land close enough) —
  // drive the engine directly.
  await setEngineView(page, view)
  // Let tiles for the new viewport load.
  await waitForNetworkSettled(page)

  // Verify the fallback ACTUALLY landed. Without this the function
  // returned success unconditionally, so a map that never initialized
  // (see HERMETIC_BUILD_ENV in serve.ts — Google Maps 403s on localhost
  // and leaves the engine at center [0,0] zoom 0) sailed through every
  // check, which then measured static app chrome instead of overlay
  // paint and reported an identical painted-pixel count at every zoom.
  // A viewport the harness could not reach is a broken run, not a pass.
  const settled = await readCurrentView(page)
  if (!settled) {
    throw new Error('[render-checks] map engine never exposed a view — the map did not initialize')
  }
  if (!closeEnough(settled, view)) {
    throw new Error(
      `[render-checks] map failed to reach the requested viewport: asked for ` +
      `(${view.lat}, ${view.lng}) z${view.zoom}, engine reports ` +
      `(${settled.lat}, ${settled.lng}) z${settled.zoom}. ` +
      `A degenerate (0, 0) z0 reading means the map never initialized — check the browser console ` +
      `for RefererNotAllowedMapError (a local .env map key leaking into the harness build).`,
    )
  }
  return { viaUrl: false }
}

/** Navigate to `baseUrl` with no explicit view (whatever the app's default
 *  landing viewport is) and wait for it to settle. */
export async function gotoDefault(page: Page, baseUrl: string, extraParams: Record<string, string> = {}): Promise<void> {
  await armRenderCheckHook(page)
  const url = new URL(baseUrl)
  for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v)
  await page.goto(url.toString(), { waitUntil: 'load' })
  await waitForNetworkSettled(page)
}

/** Pan/zoom away from the current view and back to it programmatically —
 *  the "load elsewhere, zoom in, pan, zoom back out" leg of the
 *  DETERMINISM check. Always uses the MapEngine directly (there's no URL
 *  equivalent of "visit a sequence of intermediate viewports"). */
export async function panAwayAndReturn(page: Page, target: ViewState): Promise<void> {
  const steps: ViewState[] = [
    { lat: target.lat + 0.15, lng: target.lng + 0.15, zoom: Math.max(3, target.zoom - 5) },
    { lat: target.lat - 0.08, lng: target.lng + 0.05, zoom: target.zoom + 2 },
    { lat: target.lat, lng: target.lng, zoom: target.zoom },
  ]
  for (const step of steps) {
    await setEngineView(page, step)
    await page.waitForTimeout(400) // let each intermediate viewport's tiles start loading before the next jump
  }
  await waitForNetworkSettled(page)
}
