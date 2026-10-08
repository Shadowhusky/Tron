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

export function rewriteToForward(url: string, localPort: number): string {
  const u = new URL(url);
  u.hostname = "localhost";
  u.port = String(localPort);
  return u.toString();
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
  if (f.type === "dynamic") return `SOCKS5 localhost:${f.localPort}`;
  if (f.type === "remote") return `remote ${f.remoteHost}:${f.remotePort} → localhost:${f.localPort}`;
  return `localhost:${f.localPort} → ${f.remoteHost}:${f.remotePort}`;
}
