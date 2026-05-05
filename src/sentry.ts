import * as Sentry from '@sentry/react'
import { APP_VERSION } from './version'

export function initSentry() {
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
    // 10 % performance tracing — captures Core Web Vitals (LCP / CLS /
    // INP) and request spans without flooding the project quota. Errors
    // are 100 % captured separately; this only affects performance txns.
    tracesSampleRate: 0.1,
    // No session replay — neither on errors nor on sessions. The replay
    // SDK adds ~80 KB and we have no current need.
    replaysOnErrorSampleRate: 0,
    replaysSessionSampleRate: 0,
  })
}

export { Sentry }
