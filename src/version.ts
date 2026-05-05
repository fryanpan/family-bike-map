/**
 * App version — injected at build time.
 *
 * Formats:
 *   - Released:  "0.1.<deploy-run-number>"  (GitHub Actions Deploy workflow)
 *   - Dev build: "0.1.0-dev-<git-short-sha>[-dirty]"  (local / non-main)
 *
 * Single source of truth for the UI, Sentry releases, and Userback
 * custom_data. Benchmark folders also embed the short version string
 * so a result can be traced back to the exact bundle that produced it.
 *
 * Set by vite.config.ts via `define` so this file never bundles a
 * process.env reference — the version literal is substituted at build
 * time.
 */

declare const __APP_VERSION__: string

export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.1.0-dev-unknown'
