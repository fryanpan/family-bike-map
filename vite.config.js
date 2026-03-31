import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api/valhalla': {
        target: 'https://valhalla1.openstreetmap.de',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/valhalla/, ''),
      },
      '/api/nominatim': {
        target: 'https://nominatim.openstreetmap.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nominatim/, ''),
        headers: {
          'User-Agent': 'BerlinBikeRouteFinder/0.1 (github.com/fryanpan/bike-route-finder)',
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
  },
})
