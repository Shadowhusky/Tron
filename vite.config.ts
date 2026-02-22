import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const isDemo = !!process.env.VITE_DEMO

/** In demo mode, rewrite `/` → `/demo.html` so the dev server serves the demo entry. */
function demoRedirectPlugin(): Plugin {
  return {
    name: 'demo-redirect',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/' || req.url === '/index.html') {
          req.url = '/demo.html'
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(isDemo ? [demoRedirectPlugin()] : [])],
  base: './', // Important: use relative paths for Electron
  build: isDemo
    ? {
        outDir: 'dist-demo',
        rollupOptions: {
          input: { demo: 'demo.html' },
        },
      }
    : {
        outDir: 'dist-react', // Build React app to dist-react to avoid conflict with Electron main
      },
  esbuild: {
    drop: mode === 'production' ? ['console', 'debugger'] : [],
  },
  // Exclude @wasmer/sdk from pre-bundling so its internal
  // new URL("wasmer_js_bg.wasm", import.meta.url) resolves correctly in dev
  optimizeDeps: isDemo
    ? { exclude: ['@wasmer/sdk'] }
    : undefined,
  server: {
    port: isDemo ? 5175 : (Number(process.env.PORT) || 5173),
    strictPort: true,
    headers: isDemo
      ? {
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'credentialless',
        }
      : undefined,
  },
}))
