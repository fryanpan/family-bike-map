import React from 'react'
import ReactDOM from 'react-dom/client'
import * as Sentry from '@sentry/react'
import { initSentry } from './sentry'
import { initUserback } from './userback'
import 'leaflet/dist/leaflet.css'
import './App.css'
import App from './App'

initSentry()
initUserback()
registerServiceWorker()

/**
 * Register the offline-first service worker (`/sw.js`).
 *
 * Drives the sub-second second-load goal: the SW caches the app shell
 * (HTML / JS / CSS) cache-first and the map tiles stale-while-revalidate.
 * After the first successful load, repeat visits paint from cache
 * without waiting on network.
 *
 * Skipped on dev (Vite serves `/sw.js` only from the production build,
 * and HMR + SW interact badly). The `serviceWorker` API is also
 * missing on insecure origins, so this no-ops there.
 */
function registerServiceWorker(): void {
  if (typeof navigator === 'undefined') return
  if (!('serviceWorker' in navigator)) return
  if (import.meta.env.DEV) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      // Non-fatal — the app works without it, just slower on
      // repeat visits. Surface in Sentry so a broken SW deploy
      // doesn't silently kill the cache strategy.
      console.warn('[sw] register failed:', err)
      Sentry.captureException(err, { extra: { stage: 'sw-register' } })
    })
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<p style={{ padding: 24 }}>Something went wrong. Please reload the page.</p>}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>,
)
