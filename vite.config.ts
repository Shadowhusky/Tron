/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  test: {
    // Unit tests only — e2e/ is Playwright's, and .claude/worktrees holds
    // stale checkouts whose specs must not leak into vitest's glob.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
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
