/**
 * Demo entry point — full Tron app with WASM terminal (no backend).
 * Renders the same App as main.tsx, but installs the WASM bridge
 * instead of the WebSocket bridge for terminal I/O.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { installWasmBridge } from "./services/wasm-bridge";
import { setMode } from "./services/mode";
import "./index.css";
import App from "./App.tsx";

// Install WASM bridge before any React rendering
installWasmBridge();
setMode("demo");

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
