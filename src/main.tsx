import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { initWebSocketBridge } from './services/ws-bridge'
import './index.css'
import App from './App.tsx'

const queryClient = new QueryClient()

// In web mode (no Electron), install WebSocket shim before rendering
initWebSocketBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
