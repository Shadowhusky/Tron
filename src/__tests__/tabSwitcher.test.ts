import { describe, it, expect } from "vitest";
import {
  selectTabByIndex,
  filterTabs,
  getTabContext,
} from "../utils/tabSwitcher";
import type { Tab, TerminalSession } from "../types";

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

// =============================================================================
// getTabContext — gathers searchable text from a tab's sessions (split-aware)
// =============================================================================

function mkSession(id: string, fields: Partial<TerminalSession> = {}): TerminalSession {
  return {
    id,
    title: fields.title ?? "Terminal",
    cwd: fields.cwd,
    interactions: fields.interactions,
  } as TerminalSession;
}

describe("getTabContext", () => {
  it("returns empty string for an empty layout", () => {
    const tab: Tab = {
      id: "x",
      title: "Empty",
      root: { type: "leaf", sessionId: "missing" },
      activeSessionId: "missing",
    };
    const sessions = new Map<string, TerminalSession>();
    expect(getTabContext(tab, sessions, () => null)).toBe("");
  });

  it("includes session cwd, non-default title, and recent interactions", () => {
    const tab: Tab = {
      id: "t",
      title: "Tab",
      root: { type: "leaf", sessionId: "s1" },
      activeSessionId: "s1",
    };
    const sessions = new Map<string, TerminalSession>([
      [
        "s1",
        mkSession("s1", {
          title: "user@host",
          cwd: "/Users/me/projects/falcon",
          interactions: [
            { role: "user", content: "deploy the staging branch", timestamp: 1 },
            { role: "agent", content: "Deployed via terraform apply.", timestamp: 2 },
          ],
        }),
      ],
    ]);
    const ctx = getTabContext(tab, sessions, () => null);
    expect(ctx).toContain("user@host");
    expect(ctx).toContain("/Users/me/projects/falcon");
    expect(ctx).toContain("deploy the staging branch");
    expect(ctx).toContain("terraform apply");
  });

  it("skips the default 'Terminal' title to avoid noise", () => {
    const tab: Tab = {
      id: "t",
      title: "Tab",
      root: { type: "leaf", sessionId: "s1" },
      activeSessionId: "s1",
    };
    const sessions = new Map<string, TerminalSession>([
      ["s1", mkSession("s1", { title: "Terminal", cwd: "/tmp" })],
    ]);
    const ctx = getTabContext(tab, sessions, () => null);
    expect(ctx).not.toMatch(/\bTerminal\b/);
    expect(ctx).toContain("/tmp");
  });

  it("includes terminal scrollback via the reader", () => {
    const tab: Tab = {
      id: "t",
      title: "Tab",
      root: { type: "leaf", sessionId: "s1" },
      activeSessionId: "s1",
    };
    const sessions = new Map<string, TerminalSession>([["s1", mkSession("s1")]]);
    const reader = (sid: string) => (sid === "s1" ? "$ git rebase -i HEAD~3\nSuccessfully rebased" : null);
    const ctx = getTabContext(tab, sessions, reader);
    expect(ctx).toContain("git rebase");
    expect(ctx).toContain("Successfully rebased");
  });

  it("walks split-pane trees and concatenates context from every leaf", () => {
    const tab: Tab = {
      id: "t",
      title: "Split",
      root: {
        type: "split",
        direction: "horizontal",
        sizes: [50, 50],
        children: [
          { type: "leaf", sessionId: "s1" },
          {
            type: "split",
            direction: "vertical",
            sizes: [50, 50],
            children: [
              { type: "leaf", sessionId: "s2" },
              { type: "leaf", sessionId: "s3" },
            ],
          },
        ],
      },
      activeSessionId: "s1",
    };
    const sessions = new Map<string, TerminalSession>([
      ["s1", mkSession("s1", { cwd: "/a/repo" })],
      ["s2", mkSession("s2", { cwd: "/b/server" })],
      ["s3", mkSession("s3", { cwd: "/c/docs" })],
    ]);
    const reader = (sid: string) => `scroll-${sid}`;
    const ctx = getTabContext(tab, sessions, reader);
    expect(ctx).toContain("/a/repo");
    expect(ctx).toContain("/b/server");
    expect(ctx).toContain("/c/docs");
    expect(ctx).toContain("scroll-s1");
    expect(ctx).toContain("scroll-s2");
    expect(ctx).toContain("scroll-s3");
  });

  it("ignores non-terminal leaf nodes (settings/browser/editor) without crashing", () => {
    const tab: Tab = {
      id: "t",
      title: "Mixed",
      root: {
        type: "split",
        direction: "horizontal",
        sizes: [50, 50],
        children: [
          { type: "leaf", sessionId: "settings", contentType: "settings" },
          { type: "leaf", sessionId: "s1" },
        ],
      },
      activeSessionId: "s1",
    };
    const sessions = new Map<string, TerminalSession>([
      ["s1", mkSession("s1", { cwd: "/only-this" })],
    ]);
    const ctx = getTabContext(tab, sessions, () => null);
    expect(ctx).toContain("/only-this");
  });

  it("caps interactions to a recent window (no unbounded growth)", () => {
    const tab: Tab = {
      id: "t",
      title: "Loud",
      root: { type: "leaf", sessionId: "s1" },
      activeSessionId: "s1",
    };
    const interactions = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: `msg-${i}`,
      timestamp: i,
    }));
    const sessions = new Map<string, TerminalSession>([
      ["s1", mkSession("s1", { interactions })],
    ]);
    const ctx = getTabContext(tab, sessions, () => null);
    // First few should be dropped, last few should be present.
    expect(ctx).not.toContain("msg-0");
    expect(ctx).toContain("msg-49");
  });
});

// =============================================================================
// filterTabs with context fallback
// =============================================================================

describe("filterTabs (context-aware)", () => {
  const tabs = [
    mk("1", "Tab One"),
    mk("2", "Tab Two"),
    mk("3", "Tab Three"),
    mk("4", "Untitled"),
  ];

  it("ignores context map when title also matches (title still wins)", () => {
    const contextMap = new Map<string, string>([
      ["1", "kafka producer logs"],
      ["2", "kafka tab two stuff"], // title also matches "Two"
    ]);
    const out = filterTabs(tabs, "Two", { contextMap });
    expect(out[0].id).toBe("2");
  });

  it("matches by context when title does not match", () => {
    const contextMap = new Map<string, string>([
      ["1", "$ kubectl get pods\npod-1 Running"],
      ["2", "/Users/me/notes"],
      ["3", ""],
      ["4", "deploy prod release v1.2.37"],
    ]);
    const out = filterTabs(tabs, "kubectl", { contextMap });
    expect(out.map((t) => t.id)).toEqual(["1"]);
    expect(filterTabs(tabs, "release", { contextMap }).map((t) => t.id)).toEqual([
      "4",
    ]);
  });

  it("ranks any title match above any context match", () => {
    const contextMap = new Map<string, string>([
      ["1", "deploy"],
      ["2", "deploy deploy deploy"], // strong context match
    ]);
    const tabsLocal = [mk("1", "deploy plan"), mk("2", "Tab Two")];
    const out = filterTabs(tabsLocal, "deploy", { contextMap });
    expect(out[0].id).toBe("1"); // title wins despite weaker context match
  });

  it("preserves original tab order when only context-matching ties", () => {
    const contextMap = new Map<string, string>([
      ["1", "git rebase -i HEAD~5"],
      ["2", ""],
      ["3", "git rebase main"],
      ["4", "git rebase --abort"],
    ]);
    const out = filterTabs(tabs, "rebase", { contextMap });
    expect(out.map((t) => t.id)).toEqual(["1", "3", "4"]);
  });

  it("is case-insensitive in context match", () => {
    const contextMap = new Map<string, string>([
      ["1", "Stripe API key rotation"],
    ]);
    const out = filterTabs(tabs, "STRIPE", { contextMap });
    expect(out.map((t) => t.id)).toEqual(["1"]);
  });

  it("returns empty when neither title nor context matches", () => {
    const contextMap = new Map<string, string>([["1", "nothing relevant here"]]);
    expect(filterTabs(tabs, "zzz", { contextMap })).toEqual([]);
  });

  it("falls back to title-only behaviour when no context map is provided", () => {
    expect(filterTabs(tabs, "Two").map((t) => t.id)).toEqual(["2"]);
  });
});
