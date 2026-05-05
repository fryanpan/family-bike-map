import * as Sentry from '@sentry/react'
import { APP_VERSION } from './version'

export function initSentry() {
  // Production-only. Without this gate, dev sessions ship `@vite/client`
  // HMR errors, hot-reload oddities, and stale-state bugs into the live
  // Sentry project. Sentry is a prod-observability tool — local
  // diagnostics belong in the browser console.
  if (!import.meta.env.PROD) return
  const dsn = import.meta.env.VITE_SENTRY_DSN
  if (!dsn) return

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,  // 'production' or 'development'
    release: APP_VERSION,               // matches the sentryVitePlugin release for source-map mapping

    // Privacy: don't send IP, cookies, headers, or user-scope data
    // Sentry would otherwise auto-collect. Standardized fleet-wide
    // 2026-05-05 — see docs/product/decisions.md.
    sendDefaultPii: false,

    // 100 % performance tracing for personal projects (per fleet
    // standard 2026-05-05). Captures Core Web Vitals (LCP / CLS / INP)
    // plus transaction spans on every page load. Errors are captured
    // independently regardless of this rate.
    tracesSampleRate: 1.0,

    // Browser tracing isn't in the v10 default integrations list — it
    // must be added explicitly. Without this, `tracesSampleRate > 0`
    // alone produces zero spans and Core Web Vitals don't show up.
    integrations: [Sentry.browserTracingIntegration()],

    // Sentry Logs — structured `Sentry.logger.info / warn / error` calls
    // forwarded to the project's Logs view. v10+ uses the top-level
    // `enableLogs` key (the older `_experiments.enableLogs` is
    // deprecated). Verified against @sentry/react@10.47 SDK types.
    enableLogs: true,

    // No session replay — neither on errors nor on sessions. The replay
    // SDK adds ~80 KB and we have no current need.
    replaysOnErrorSampleRate: 0,
    replaysSessionSampleRate: 0,
  })
}

export { Sentry }
