import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { initWebSocketBridge, modeReady } from './services/ws-bridge'
import { installRemoteRouting } from './services/remote-bridge'
import './index.css'
import App from './App.tsx'

const queryClient = new QueryClient()

// Electron preload exposes the API as frozen "_electronBridge" (contextBridge).
// Copy it to a writable "window.electron" so remote-bridge.ts can swap
// ipcRenderer with a routing wrapper for remote server connections.
if ((window as any)._electronBridge && !(window as any).electron) {
  const bridge = (window as any)._electronBridge;
  const ipcCopy: any = {};
  for (const key of Object.keys(bridge.ipcRenderer)) {
    const val = bridge.ipcRenderer[key];
    ipcCopy[key] = typeof val === 'function' ? val.bind(bridge.ipcRenderer) : val;
  }
  (window as any).electron = { ipcRenderer: ipcCopy };
}

// In web mode (no Electron), install WebSocket shim and wait for mode
// detection before rendering so LayoutContext knows the deployment mode.
initWebSocketBridge()

// Install remote IPC routing — wraps ipcRenderer to transparently route
// remote session calls through their remote server's WebSocket.
installRemoteRouting()

async function boot() {
  // In Electron mode, initWebSocketBridge is a no-op and modeReady
  // never resolves — so we race with a short timeout.
  if ((window as any).electron) {
    // Electron — remove loader immediately (fast local IPC, no WS wait)
    const loader = document.getElementById('tron-loader');
    if (loader) {
      loader.classList.add('fade-out');
      setTimeout(() => loader.remove(), 300);
    }
  } else {
    // Web — wait for server mode message, but don't block forever if server is down.
    // After 5s timeout, render anyway so the user sees their tabs with a retry overlay.
    await Promise.race([
      modeReady,
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);
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
