import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  base: './', // Important: use relative paths for Electron
  build: {
    outDir: 'dist-react', // Build React app to dist-react to avoid conflict with Electron main
  },
  esbuild: {
    drop: mode === 'production' ? ['console', 'debugger'] : [],
  },
  server: {
    host: process.env.VITE_HOST || undefined,
    port: 5173,
    strictPort: true,
  },
}))
