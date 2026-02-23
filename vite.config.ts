import { defineConfig, type Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const isDemo = !!process.env.VITE_DEMO

/** Read the full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

/** Stream a proxied AI API response back to the client. */
async function handleAiProxy(req: IncomingMessage, res: ServerResponse) {
  try {
    const { url, method, headers, body } = JSON.parse(await readBody(req))
    const apiRes = await fetch(url, {
      method: method || 'POST',
      headers,
      body: method === 'GET' ? undefined : body,
    })

    // Forward status + content-type, add CORS header
    const ct = apiRes.headers.get('content-type') || 'application/json'
    res.writeHead(apiRes.status, {
      'Content-Type': ct,
      'Access-Control-Allow-Origin': '*',
    })

    if (!apiRes.body) {
      const text = await apiRes.text()
      res.end(text)
      return
    }

    // Stream the response
    const reader = (apiRes.body as ReadableStream<Uint8Array>).getReader()
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
      res.end()
    }
    pump().catch(() => res.end())
  } catch (err: any) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    }
    res.end(JSON.stringify({ error: err.message }))
  }
}

/** In demo mode, rewrite `/` → `/demo.html` and add AI CORS proxy. */
function demoRedirectPlugin(): Plugin {
  return {
    name: 'demo-redirect',
    configureServer(server) {
      // AI proxy — must be registered before Vite's own middleware
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/api/ai-proxy') return next()

        // CORS preflight
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          })
          return res.end()
        }

        if (req.method === 'POST') {
          handleAiProxy(req, res as ServerResponse)
          return
        }

        res.writeHead(405)
        res.end('Method Not Allowed')
      })

      // Demo HTML redirect
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
