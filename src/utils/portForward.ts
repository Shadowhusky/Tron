import type { PortForward } from "../types";

const LOOPBACK_HOSTS = new Map<string, string>([
  ["localhost", "localhost"],
  ["127.0.0.1", "127.0.0.1"],
  ["0.0.0.0", "localhost"],
  ["[::1]", "::1"],
  ["::1", "::1"],
]);

/** A URL that points at the remote machine's own loopback, and where the tunnel should connect. */
export function parseLoopbackUrl(url: string): { port: number; forwardHost: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const forwardHost = LOOPBACK_HOSTS.get(u.hostname);
  if (!forwardHost) return null;
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return { port, forwardHost };
}

// Listeners bind IPv4 loopback only. "localhost" can resolve to ::1 first and
// reach some other local server on the same port, so always say 127.0.0.1.
const LISTEN_HOST = "127.0.0.1";

export function rewriteToForward(url: string, localPort: number): string {
  const u = new URL(url);
  u.hostname = LISTEN_HOST;
  u.port = String(localPort);
  return u.toString();
}

/** What to open or copy for a forward's local end. */
export function forwardLocalAddress(f: PortForward): string {
  return f.type === "dynamic" ? `${LISTEN_HOST}:${f.localPort}` : `http://${LISTEN_HOST}:${f.localPort}`;
}

/**
 * Forwards always bind the backend's loopback. That's the user's machine in
 * the desktop app, but in web mode it's the server — only reachable when the
 * browser runs on that same machine.
 */
export function forwardOpensLocally(opts: {
  isElectron: boolean;
  locationHostname: string;
  sessionRemote: boolean;
}): boolean {
  if (opts.sessionRemote) return false;
  if (opts.isElectron) return true;
  return LOOPBACK_HOSTS.has(opts.locationHostname) && opts.locationHostname !== "0.0.0.0";
}

export function describeForward(f: PortForward): string {
  if (f.type === "dynamic") return `SOCKS5 ${LISTEN_HOST}:${f.localPort}`;
  if (f.type === "remote") return `remote ${f.remoteHost}:${f.remotePort} → ${LISTEN_HOST}:${f.localPort}`;
  return `${LISTEN_HOST}:${f.localPort} → ${f.remoteHost}:${f.remotePort}`;
}
