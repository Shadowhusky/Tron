/**
 * Deployment mode singleton.
 * - "local"   — full local PTY + SSH (self-hosted, Electron)
 * - "gateway" — SSH-only relay (cloud/hosted)
 * - "demo"    — no server, mock terminal (website showcase)
 */

export type TronMode = "local" | "gateway" | "demo";

let _mode: TronMode = "local";

export function getMode(): TronMode {
  return _mode;
}

export function setMode(m: TronMode) {
  _mode = m;
}

export function isGatewayMode() {
  return _mode === "gateway";
}

export function isDemoMode() {
  return _mode === "demo";
}

export function isLocalMode() {
  return _mode === "local";
}
