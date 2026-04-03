import * as Sentry from '@sentry/react'

export function initSentry() {
  const dsn = import.meta.env.VITE_SENTRY_DSN
  if (!dsn) return

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE,  // 'production' or 'development'
    // Error capture only — no performance tracing or session replay
    tracesSampleRate: 0,
  })
}

export { Sentry }
