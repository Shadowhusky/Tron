// Terminal snapshots (SerializeAddon output) share localStorage's ~5M-char
// origin quota with the layout, so they stay bounded per pane, are pruned once
// their session is gone, and are the first thing evicted under quota pressure.

const PREFIX = "tron:termSnapshot:";

/** Per-snapshot ceiling; scrollback is trimmed until the serialization fits. */
export const MAX_SNAPSHOT_CHARS = 256 * 1024;
const SCROLLBACK_STEPS = [1000, 300, 0];

export const termSnapshotKey = (sessionId: string) => `${PREFIX}${sessionId}`;

/** Serialize with as much scrollback as fits the budget; null if even the bare screen doesn't. */
export function serializeWithinBudget(
  serialize: (scrollback: number) => string,
  maxChars = MAX_SNAPSHOT_CHARS,
): string | null {
  for (const scrollback of SCROLLBACK_STEPS) {
    const out = serialize(scrollback);
    if (out.length <= maxChars) return out;
  }
  return null;
}

/** Remove every snapshot whose session isn't in `keep` (all of them when omitted). */
export function pruneTermSnapshots(storage: Storage, keep?: ReadonlySet<string>): number {
  const stale: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(PREFIX) && !keep?.has(key.slice(PREFIX.length))) stale.push(key);
  }
  for (const key of stale) storage.removeItem(key);
  return stale.length;
}

/**
 * setItem for data that matters more than snapshots: when the write fails,
 * evict all snapshots (they regenerate within seconds) and retry once.
 */
export function setItemEvictingSnapshots(storage: Storage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch { /* quota — fall through to eviction */ }
  try {
    if (pruneTermSnapshots(storage) === 0) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
