const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 60_000;

/** Wait before the next automatic attempt after `failures` consecutive failures (5s, 10s, 20s … 60s). */
export function reconnectDelay(failures: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, failures - 1));
}

/**
 * Failures retrying can't fix. These are never auto-retried: repeatedly
 * failing SSH auth gets the client IP banned by fail2ban-style guards.
 */
export function isPermanentConnectError(message: string): boolean {
  return /authenticat|permission denied|profile not found|no saved password|passphrase|unauthorized|forbidden|\b40[13]\b/i.test(message);
}

/** Strip Electron's "Error invoking remote method 'x': Error: " wrapper for display. */
export function cleanConnectError(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^(Error:\s*)+/, "");
}
