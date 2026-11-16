import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Resolve the app version at build time.
 *   CI (Deploy workflow):  VITE_APP_VERSION=0.1.<github.run_number>
 *   Local / dev build:     0.1.0-dev-<git short sha>[-dirty]
 * Falls back to 0.1.0-dev-unknown if git isn't available (e.g. a
 * stripped CI worktree without fetch-depth).
 */
function resolveAppVersion(): string {
  if (process.env.VITE_APP_VERSION) return process.env.VITE_APP_VERSION
  try {
    const sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const dirty = execSync('git status --porcelain', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0
    return `0.1.0-dev-${sha}${dirty ? '-dirty' : ''}`
  } catch {
    return '0.1.0-dev-unknown'
  }
}
const APP_VERSION = resolveAppVersion()

/**
 * Port the local Worker (`wrangler dev`) listens on, which `/api/*` is proxied
 * to. Defaults to 8791; the render-check harness sets WORKER_PORT when it has
 * to pick a different one.
 */
const DEFAULT_WORKER_PORT = 8791
const WORKER_PORT = Number(process.env.WORKER_PORT) || DEFAULT_WORKER_PORT
console.log(`[vite] APP_VERSION = ${APP_VERSION}`)

/**
 * Emit /version.json at the site root so any tool can cheaply ask
 * "what's the deployed version?" without downloading the main bundle.
 * Benchmark scripts use this to prefix local-generated folders with
 * the *live prod* version instead of a dev sha (less confusing).
 */
function emitVersionJson(): Plugin {
  return {
    name: 'emit-version-json',
    apply: 'build',
    closeBundle() {
      const outFile = join(process.cwd(), 'dist', 'version.json')
      writeFileSync(outFile, JSON.stringify({ version: APP_VERSION }, null, 2) + '\n')
      console.log(`[vite] wrote ${outFile}`)
    },
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [
    react(),
    emitVersionJson(),
    // Uploads source maps to Sentry on production builds so stack traces resolve
    // to real file/line numbers. Requires SENTRY_AUTH_TOKEN env var (CI secret).
    // No-ops silently if the token is absent (local dev, preview builds).
    // `release` ties each uploaded source map to the exact APP_VERSION.
    sentryVitePlugin({
      org: 'fryanpan',
      project: 'bike-map',
      telemetry: false,
      release: { name: APP_VERSION },
    }),
  ],
  // Vite HMR serves the app; /api/* is proxied to the local wrangler dev so
  // Worker routes (feedback, mapillary, overpass) still work.
  // Run both: `bunx wrangler dev --port 8791` + `bunx vite`.
  // WORKER_PORT overrides the target: the render-check harness can be asked
  // to run its wrangler on a different port, and before this was configurable
  // the proxy still pointed at 8791 and silently served /api from whatever
  // else was listening there.
  server: {
    host: true, // listen on 0.0.0.0 so Tailscale / LAN hosts can reach it
    port: 5173,
    // Allow Tailscale + .local names to hit the dev server. Vite 5 blocks
    // anything not explicitly listed by default.
    allowedHosts: [
      '.ts.net',       // Tailscale magic DNS (tailXXXX.ts.net)
      '.local',        // mDNS / Bonjour hostnames
      'localhost',
      '127.0.0.1',
    ],
    proxy: {
      '/api': `http://localhost:${WORKER_PORT}`,
    },
  },
  build: {
    sourcemap: true,
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/leaflet') || id.includes('node_modules/react-leaflet')) {
            return 'vendor-leaflet'
          }
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react'
          }
        },
      },
    },
  },
})
