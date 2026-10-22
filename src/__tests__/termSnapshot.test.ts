import { describe, it, expect } from "vitest";
import {
  MAX_SNAPSHOT_CHARS,
  pruneTermSnapshots,
  serializeWithinBudget,
  setItemEvictingSnapshots,
  termSnapshotKey,
} from "../utils/termSnapshot";

/** Minimal Storage with a char quota (keys + values), throwing like Chromium. */
function quotaStorage(quota: number): Storage {
  const data = new Map<string, string>();
  const used = () => [...data].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return {
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      const prev = data.get(k);
      if (used() - (prev === undefined ? 0 : k.length + prev.length) + k.length + v.length > quota) {
        throw new DOMException("exceeded the quota", "QuotaExceededError");
      }
      data.set(k, v);
    },
    removeItem: (k) => { data.delete(k); },
    clear: () => data.clear(),
  };
}

describe("serializeWithinBudget", () => {
  it("keeps the most scrollback that fits", () => {
    const calls: number[] = [];
    const out = serializeWithinBudget((sb) => {
      calls.push(sb);
      return "x".repeat(sb === 1000 ? 500 : 50);
    }, 100);
    expect(calls).toEqual([1000, 300]);
    expect(out).toHaveLength(50);
  });

  it("returns null when even the bare screen is over budget", () => {
    expect(serializeWithinBudget(() => "x".repeat(MAX_SNAPSHOT_CHARS + 1))).toBeNull();
  });
});

describe("pruneTermSnapshots", () => {
  it("removes snapshots of sessions that are gone, leaving other keys alone", () => {
    const s = quotaStorage(10_000);
    s.setItem(termSnapshotKey("live"), "a");
    s.setItem(termSnapshotKey("closed-1"), "b");
    s.setItem(termSnapshotKey("closed-2"), "c");
    s.setItem("tron_layout_v1", "{}");
    expect(pruneTermSnapshots(s, new Set(["live"]))).toBe(2);
    expect(s.getItem(termSnapshotKey("live"))).toBe("a");
    expect(s.getItem("tron_layout_v1")).toBe("{}");
    expect(s.length).toBe(2);
  });

  it("removes every snapshot when no keep-set is given", () => {
    const s = quotaStorage(10_000);
    s.setItem(termSnapshotKey("a"), "1");
    s.setItem(termSnapshotKey("b"), "2");
    expect(pruneTermSnapshots(s)).toBe(2);
    expect(s.length).toBe(0);
  });
});

describe("setItemEvictingSnapshots", () => {
  it("evicts snapshots to make room for the layout", () => {
    const s = quotaStorage(200);
    s.setItem(termSnapshotKey("old"), "x".repeat(120));
    expect(setItemEvictingSnapshots(s, "tron_layout_v1", "y".repeat(100))).toBe(true);
    expect(s.getItem("tron_layout_v1")).toHaveLength(100);
    expect(s.getItem(termSnapshotKey("old"))).toBeNull();
  });

  it("reports failure when the value can't fit even without snapshots", () => {
    const s = quotaStorage(50);
    expect(setItemEvictingSnapshots(s, "tron_layout_v1", "y".repeat(100))).toBe(false);
  });

  it("writes without touching snapshots when there is room", () => {
    const s = quotaStorage(1_000);
    s.setItem(termSnapshotKey("live"), "x");
    expect(setItemEvictingSnapshots(s, "tron_layout_v1", "{}")).toBe(true);
    expect(s.getItem(termSnapshotKey("live"))).toBe("x");
  });
});
