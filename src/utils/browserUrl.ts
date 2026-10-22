// Address-bar input → URL for the in-app browser pane.

const END = "(?=[:/?#]|$)";
// Local, LAN and mDNS hosts: dev servers there almost never speak https.
const LOCAL_HOST_RE = new RegExp(
  `^(localhost|0\\.0\\.0\\.0|\\[::1\\]|127(\\.\\d{1,3}){3}|10(\\.\\d{1,3}){3}|192\\.168(\\.\\d{1,3}){2}|172\\.(1[6-9]|2\\d|3[01])(\\.\\d{1,3}){2}|[\\w-]+\\.local)${END}`,
  "i",
);
const IP_RE = new RegExp(`^\\d{1,3}(\\.\\d{1,3}){3}${END}`);
const HOST_PORT_RE = /^[\w-]+(\.[\w-]+)*:\d{1,5}(?=[/?#]|$)/;
const DOMAIN_RE = new RegExp(`^([a-z0-9-]+\\.)+[a-z]{2,}${END}`, "i");
const LOOPBACK_URL_RE = /^http:\/\/(localhost|127(\.\d{1,3}){3}|\[::1\])(?=[:/?#]|$)/i;

/**
 * `autoScheme` marks a scheme Tron chose — the pane may then retry over http
 * when an https guess fails.
 */
export function normalizeBrowserInput(input: string): { url: string; autoScheme: boolean } {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) return { url: s, autoScheme: false };
  if (LOCAL_HOST_RE.test(s) || IP_RE.test(s) || HOST_PORT_RE.test(s)) return { url: `http://${s}`, autoScheme: true };
  if (DOMAIN_RE.test(s)) return { url: `https://${s}`, autoScheme: true };
  return { url: `https://www.google.com/search?q=${encodeURIComponent(s)}`, autoScheme: false };
}

/** An https page can't frame http content (loopback is exempt — browsers trust it). */
export function isMixedContentBlocked(pageProtocol: string, url: string): boolean {
  return pageProtocol === "https:" && /^http:\/\//i.test(url) && !LOOPBACK_URL_RE.test(url);
}

export function httpFallback(url: string): string | null {
  return /^https:\/\//i.test(url) ? `http://${url.slice("https://".length)}` : null;
}
