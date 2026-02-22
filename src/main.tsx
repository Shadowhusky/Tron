import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { initWebSocketBridge, modeReady } from './services/ws-bridge'
import './index.css'
import App from './App.tsx'

const queryClient = new QueryClient()

// In web mode (no Electron), install WebSocket shim and wait for mode
// detection before rendering so LayoutContext knows the deployment mode.
initWebSocketBridge()

async function boot() {
  // In Electron mode, initWebSocketBridge is a no-op and modeReady
  // never resolves — so we race with a short timeout.
  if ((window as any).electron) {
    // Electron — render immediately
  } else {
    // Web — wait for server mode message or demo fallback
    await modeReady;
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  )
}

boot()
