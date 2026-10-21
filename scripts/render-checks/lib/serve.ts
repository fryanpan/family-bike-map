// Serves the app locally for the render-check harness.
//
// PRIMARY path: `bun run build` then `wrangler dev`. wrangler.toml's
// [assets] block points at ./dist with SPA fallback, so a single wrangler
// process serves the built app AND the live Worker /api/* routes
// (Overpass proxy, enriched tiles) on one port — the closest local
// approximation to production topology, and the only local option where
// the bike-infra overlay actually has real data to paint. `vite preview`
// alone can't do this (no /api proxy in preview mode), so this
// deliberately diverges from a literal "vite preview" reading of the
// render-checks brief in favour of a server that can actually paint the
// overlay under test — see README.md.
//
// FALLBACK path (build fails on an environment-only issue, e.g. missing
// SENTRY_AUTH_TOKEN for sourcemap upload): `vite dev` + a separate
// `wrangler dev --port 8791`, proxied via vite.config.ts's existing
// server.proxy — the exact pattern documented there for local dev.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(import.meta.dir, '../../..')

export interface ServedApp {
  /** Base URL the harness should navigate Playwright to. */
  url: string
  /** Which path was used — surfaced in check output for debuggability. */
  mode: 'wrangler-dev' | 'vite-dev'
  /** Tears down every process this started. Always call in a finally. */
  stop: () => Promise<void>
}

function runToCompletion(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd: REPO_ROOT, env })
    let output = ''
    proc.stdout?.on('data', (d) => { output += d.toString() })
    proc.stderr?.on('data', (d) => { output += d.toString() })
    proc.on('close', (code) => resolve({ ok: code === 0, output }))
    proc.on('error', (err) => resolve({ ok: false, output: String(err) }))
  })
}

// Distinctive string from index.html's <title> — used to verify the thing
// answering on our chosen port is actually this app, not some unrelated
// long-running local service that happened to grab the same port (this
// machine runs several always-on background tools across a range of
// localhost ports — see README.md's "port collisions" note).
const APP_MARKER = 'Family Bike Map'

/** Poll a URL until it responds AND the body looks like our app, or time out. */
async function waitForServer(url: string, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      const text = await res.text()
      if (text.includes(APP_MARKER)) return
      lastErr = new Error(
        `got an HTTP response from ${url} but it doesn't look like family-bike-map ` +
        `(missing "${APP_MARKER}") — another local service may already be bound to this ` +
        `port. First 200 chars of body: ${JSON.stringify(text.slice(0, 200))}`,
      )
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`server at ${url} did not become ready within ${timeoutMs}ms: ${String(lastErr)}`)
}

function killTree(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.killed) { resolve(); return }
    proc.once('exit', () => resolve())
    proc.kill('SIGTERM')
    // Belt-and-suspenders: wrangler/vite sometimes ignore SIGTERM while a
    // dev-mode file watcher is active.
    setTimeout(() => { if (proc.exitCode === null) proc.kill('SIGKILL') }, 3000)
  })
}

async function serveViaWranglerDev(port: number): Promise<ServedApp> {
  const proc = spawn('bunx', ['wrangler', 'dev', '--port', String(port)], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const url = `http://localhost:${port}`
  await waitForServer(url)
  return {
    url,
    mode: 'wrangler-dev',
    stop: () => killTree(proc),
  }
}

async function serveViaViteDevFallback(vitePort: number, workerPort: number): Promise<ServedApp> {
  const workerProc = spawn('bunx', ['wrangler', 'dev', '--port', String(workerPort)], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await waitForServer(`http://localhost:${workerPort}`)

  const viteProc = spawn('bunx', ['vite', '--port', String(vitePort), '--strictPort'], {
    cwd: REPO_ROOT,
    // vite.config.ts's server.proxy already routes /api -> localhost:8791;
    // only override the port if the caller asked for a non-default one.
    // Same engine-forcing overrides as the build path — see HERMETIC_BUILD_ENV.
    env: HERMETIC_BUILD_ENV,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const url = `http://localhost:${vitePort}`
  await waitForServer(url)

  return {
    url,
    mode: 'vite-dev',
    stop: async () => {
      await killTree(viteProc)
      await killTree(workerProc)
    },
  }
}

/**
 * Env overrides applied to the harness's build so the app resolves to the
 * Leaflet/OSM-Carto engine — the ONE engine lib/pixels.ts is calibrated
 * against.
 *
 * pixels.ts assumed "CI/local render-check runs never set those secrets."
 * That is false on a dev machine with a local `.env`: Vite bakes
 * VITE_GOOGLE_MAPS_KEY into the bundle, resolveEngine picks Google, and
 * Google Maps then refuses to initialize on http://localhost (the key is
 * referer-locked to the prod domain) with RefererNotAllowedMapError. The
 * result is not a loud failure — it is a map that never renders at all,
 * stuck at center [0,0] zoom 0, while every check happily "passes" by
 * measuring ~154 px of static app chrome inside the map container.
 * Setting these empty makes the harness hermetic w.r.t. whatever `.env`
 * the developer happens to have. Discovered 2026-08-22.
 */
const HERMETIC_BUILD_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  VITE_GOOGLE_MAPS_KEY: '',
  VITE_MAPTILER_KEY: '',
}

/**
 * Build + serve the app for the render-check harness. Tries the wrangler-
 * dev path first (full API + static assets on one port); falls back to
 * vite dev + a separate wrangler worker if the build fails on an
 * environment-only issue (missing Sentry token, etc — same class of
 * failure the top-level agent instructions call out for `bun run build`).
 */
export async function serveApp(opts: { port?: number; workerPort?: number } = {}): Promise<ServedApp> {
  // NOT 8787 — wrangler's own conventional default, but also where this
  // machine's live-feedback plugin server runs persistently in the
  // background (see README.md "port collisions"). waitForServer's content
  // check catches a collision either way, but picking an uncommon port
  // avoids tripping over it in the first place.
  const port = opts.port ?? 8793
  // 8791 matches vite.config.ts's hardcoded `server.proxy['/api']` target —
  // do not change without updating that file too.
  const workerPort = opts.workerPort ?? 8791

  const distIndex = join(REPO_ROOT, 'dist', 'index.html')
  const build = await runToCompletion('bun', ['run', 'build'], HERMETIC_BUILD_ENV)
  if (build.ok && existsSync(distIndex)) {
    console.log('[render-checks/serve] build OK -> wrangler dev (dist/ + live /api on one port)')
    return serveViaWranglerDev(port)
  }

  console.warn('[render-checks/serve] `bun run build` failed (or produced no dist/) — falling back to vite dev.')
  console.warn('[render-checks/serve] build output (last 2000 chars):')
  console.warn(build.output.slice(-2000))
  return serveViaViteDevFallback(port, workerPort)
}
