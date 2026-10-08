import { IPC } from "../constants/ipc";
import { isElectronApp } from "../utils/platform";
import type { PortForward, PortForwardSpec } from "../types";

// Generic invoke on purpose: remote-bridge routes it by sessionId to the server
// that owns the SSH session.
function invoke<T>(channel: string, data: unknown): Promise<T> {
  const ipc = window.electron?.ipcRenderer;
  if (!ipc?.invoke) return Promise.reject(new Error("IPC unavailable"));
  return ipc.invoke(channel, data) as Promise<T>;
}

export function addPortForward(sessionId: string, spec: PortForwardSpec, persist = false): Promise<PortForward> {
  return invoke(IPC.SSH_FORWARD_ADD, { sessionId, persist, ...spec });
}

export function removePortForward(sessionId: string, id: string): Promise<boolean> {
  return invoke(IPC.SSH_FORWARD_REMOVE, { sessionId, id });
}

export function listPortForwards(sessionId: string): Promise<PortForward[]> {
  return invoke(IPC.SSH_FORWARD_LIST, sessionId);
}

/** A local listener for remote host:port — the backend reuses an existing one. */
export function ensureLocalForward(sessionId: string, remotePort: number, remoteHost: string): Promise<PortForward> {
  return addPortForward(sessionId, { type: "local", remoteHost, remotePort });
}

export function openUrlExternally(url: string): void {
  if (isElectronApp() && window.electron?.ipcRenderer) {
    window.electron.ipcRenderer.invoke("shell.openExternal", url)?.catch(() => {});
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
