import { describe, it, expect } from "vitest";
import { selectTabByIndex, filterTabs } from "../utils/tabSwitcher";
import type { Tab } from "../types";

// Test helper: make a minimal Tab with just the fields the switcher cares about.
function mk(id: string, title: string): Tab {
  return {
    id,
    title,
    root: { type: "leaf", sessionId: `s-${id}` },
    activeSessionId: `s-${id}`,
  };
}

// =============================================================================
// selectTabByIndex
// =============================================================================
describe("selectTabByIndex", () => {
  const tabs = [mk("a", "alpha"), mk("b", "beta"), mk("c", "gamma")];

  it("returns tab at 1-indexed position for digits 1..9", () => {
    expect(selectTabByIndex(tabs, 1)?.id).toBe("a");
    expect(selectTabByIndex(tabs, 2)?.id).toBe("b");
    expect(selectTabByIndex(tabs, 3)?.id).toBe("c");
  });

  it("returns null when index > tabs.length", () => {
    expect(selectTabByIndex(tabs, 5)).toBeNull();
    expect(selectTabByIndex(tabs, 9)).toBeNull();
  });

  it("digit 0 jumps to the LAST tab (matches browser convention)", () => {
    expect(selectTabByIndex(tabs, 0)?.id).toBe("c");
    expect(selectTabByIndex([mk("x", "x"), mk("y", "y")], 0)?.id).toBe("y");
  });

  it("returns null on empty tab list", () => {
    expect(selectTabByIndex([], 1)).toBeNull();
    expect(selectTabByIndex([], 0)).toBeNull();
  });

  it("rejects out-of-range indices", () => {
    expect(selectTabByIndex(tabs, -1)).toBeNull();
    expect(selectTabByIndex(tabs, 10)).toBeNull();
  });
});

// =============================================================================
// filterTabs — fast, simple substring + prefix/word-start scoring
// =============================================================================
describe("filterTabs", () => {
  const tabs = [
    mk("1", "Docker Build"),
    mk("2", "Docker Compose"),
    mk("3", "Node Server"),
    mk("4", "Python Tests"),
    mk("5", "Git Rebase"),
    mk("6", "docs-site"),
  ];

  it("returns all tabs in original order when query is empty", () => {
    const out = filterTabs(tabs, "");
    expect(out.map((t) => t.id)).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("returns all tabs when query is whitespace only", () => {
    const out = filterTabs(tabs, "   ");
    expect(out.length).toBe(tabs.length);
  });

  it("is case-insensitive", () => {
    const out = filterTabs(tabs, "DOCKER");
    expect(out.map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("matches substrings", () => {
    const out = filterTabs(tabs, "ompo");
    expect(out.map((t) => t.id)).toEqual(["2"]);
  });

  it("ranks prefix match above non-prefix", () => {
    // "do" prefix-matches "Docker Build", "Docker Compose", "docs-site";
    // all three share score 3, so shorter titles win the tiebreaker and
    // equal lengths preserve original order.
    //   docs-site (9) < Docker Build (12) < Docker Compose (14)
    const out = filterTabs(tabs, "do");
    expect(out.map((t) => t.id)).toEqual(["6", "1", "2"]);
  });

  it("ranks word-start match above arbitrary substring match", () => {
    const mixed = [
      mk("a", "background sync"), // "g" appears mid-token
      mk("b", "git stash"),       // "g" at word start
    ];
    const out = filterTabs(mixed, "g");
    expect(out[0].id).toBe("b");
  });

  it("filters out non-matches", () => {
    const out = filterTabs(tabs, "xyz");
    expect(out).toEqual([]);
  });

  it("preserves original order for ties at same score AND same length", () => {
    // Two titles of equal length with the same substring score should stay
    // in input order. "Docker Build" and "Python Tests" both have length 12,
    // both match 'e' mid-word → both score 1.
    const set = [mk("1", "Docker Build"), mk("2", "Python Tests")];
    const out = filterTabs(set, "e");
    expect(out.map((t) => t.id)).toEqual(["1", "2"]);
  });

  it("handles multi-char queries against word boundaries", () => {
    const out = filterTabs(tabs, "git");
    expect(out[0].id).toBe("5"); // "Git Rebase" word-start
  });

  it("treats hyphens and dots as word boundaries for word-start ranking", () => {
    const set = [
      mk("a", "my-tab"),     // "t" at word start after hyphen
      mk("b", "cater"),      // "t" mid-word
    ];
    const out = filterTabs(set, "t");
    expect(out[0].id).toBe("a");
  });
});
