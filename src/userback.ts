// Userback widget — user-initiated feedback (bug reports + screenshots).
// Loaded async from the Userback CDN so it doesn't block app boot and
// adds no weight to the main bundle. Host gating happens in the
// Userback dashboard's allowed-domains list (single source of truth);
// no parallel hostname allowlist in the client code.

import { APP_VERSION } from './version'

declare global {
  interface Window {
    Userback?: {
      access_token?: string
      on_load?: () => void
      custom_data?: Record<string, unknown>
      [k: string]: unknown
    }
  }
}

export function initUserback() {
  const token = import.meta.env.VITE_USERBACK_TOKEN
  if (!token) return
  if (typeof window === 'undefined') return
  if (window.Userback) return

  // custom_data attaches to every feedback submission, so every bug
  // report arrives pre-tagged with the exact release that produced it.
  window.Userback = {
    access_token: token,
    custom_data: { app_version: APP_VERSION },
  }

  const s = document.createElement('script')
  s.async = true
  s.src = 'https://static.userback.io/widget/v1.js'
  document.head.appendChild(s)
}
