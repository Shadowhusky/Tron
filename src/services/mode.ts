/**
 * Deployment mode and access restriction singletons.
 *
 * Mode (TRON_MODE):
 * - "local"   — full local PTY + SSH (self-hosted, Electron)
 * - "gateway" — cloud/hosted deployment (node-pty optional)
 * - "demo"    — no server, mock terminal (website showcase)
 *
 * SSH-only (TRON_SSH_ONLY):
 * - Separate toggle that restricts access to SSH sessions only.
 * - Blocks local terminal creation, file ops, server shell access.
 * - Gateway mode defaults to sshOnly=true, but can be overridden.
 */

export type TronMode = "local" | "gateway" | "demo";

let _mode: TronMode = "local";
let _sshOnly = false;

export function getMode(): TronMode {
  return _mode;
}

export function setMode(m: TronMode) {
  _mode = m;
}

export function setSshOnly(v: boolean) {
  _sshOnly = v;
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

/** Whether local terminal access is restricted (SSH connections only). */
export function isSshOnly() {
  return _sshOnly;
}
