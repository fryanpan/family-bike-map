import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'

export default defineConfig({
  plugins: [
    react(),
    // Uploads source maps to Sentry on production builds so stack traces resolve
    // to real file/line numbers. Requires SENTRY_AUTH_TOKEN env var (CI secret).
    // No-ops silently if the token is absent (local dev, preview builds).
    sentryVitePlugin({
      org: 'fryanpan',
      project: 'bike-map',
      telemetry: false,
    }),
  ],
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
