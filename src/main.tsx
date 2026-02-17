import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initWebSocketBridge } from './services/ws-bridge'
import './index.css'
import App from './App.tsx'

// In web mode (no Electron), install WebSocket shim before rendering
initWebSocketBridge()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
