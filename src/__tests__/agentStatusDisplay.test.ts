import { describe, it, expect } from "vitest";
import {
  isAgentTitle,
  titleActivity,
  agentNameFromTitle,
  resolveAgentLabel,
  formatElapsed,
  layoutSessionOrder,
  stepAgentWatch,
  type AgentWatch,
} from "../utils/agentStatusDisplay";
import type { Tab } from "../types";

describe("isAgentTitle", () => {
  it("accepts Claude Code's inline titles by their status glyph", () => {
    // Claude Code renders inline (no alternate screen) — verified against 2.1.294:
    // "✳ Claude Code" → "◐ Git rebase" / "◑ Git rebase" while working → "✳ Git rebase".
    expect(isAgentTitle("✳ Claude Code", false)).toBe(true);
    expect(isAgentTitle("✳ Fix login bug", false)).toBe(true);
    expect(isAgentTitle("◐ Git rebase", false)).toBe(true);
    expect(isAgentTitle("◓ Git rebase", false)).toBe(true);
    expect(isAgentTitle("⠂ Fix login bug", false)).toBe(true);
  });

  it("accepts any title set inside the alternate screen (full-screen TUIs like Codex)", () => {
    expect(isAgentTitle("tron · refactor parser", true)).toBe(true);
  });

  it("rejects shell titles in the normal screen", () => {
    expect(isAgentTitle("richardliao@Mac: ~/proj", false)).toBe(false);
    expect(isAgentTitle("npm run dev", false)).toBe(false);
    expect(isAgentTitle("~/proj", false)).toBe(false);
  });
});

describe("titleActivity", () => {
  it("reads Claude Code's working spinner and idle glyph", () => {
    expect(titleActivity("◐ Git rebase")).toBe("working");
    expect(titleActivity("◑ Git rebase")).toBe("working");
    expect(titleActivity("✳ Git rebase")).toBe("idle");
  });

  it("reads Codex's braille spinner as working", () => {
    expect(titleActivity("⠋ tron")).toBe("working");
  });

  it("has no opinion on plain titles", () => {
    expect(titleActivity("tron")).toBeNull();
    expect(titleActivity("")).toBeNull();
  });
});

describe("agentNameFromTitle", () => {
  it("strips Claude Code's status glyph prefix", () => {
    expect(agentNameFromTitle("✳ Fix login bug")).toBe("Fix login bug");
  });

  it("strips spinner glyphs (braille and star frames)", () => {
    expect(agentNameFromTitle("⠂ Refactor agent loop")).toBe("Refactor agent loop");
    expect(agentNameFromTitle("✶ Refactor agent loop")).toBe("Refactor agent loop");
    expect(agentNameFromTitle("· Refactor agent loop")).toBe("Refactor agent loop");
  });

  it("rejects the generic product names", () => {
    expect(agentNameFromTitle("✳ Claude Code")).toBeNull();
    expect(agentNameFromTitle("claude")).toBeNull();
    expect(agentNameFromTitle("Codex")).toBeNull();
    expect(agentNameFromTitle("OpenAI Codex")).toBeNull();
  });

  it("rejects empty and glyph-only titles", () => {
    expect(agentNameFromTitle("")).toBeNull();
    expect(agentNameFromTitle("   ")).toBeNull();
    expect(agentNameFromTitle("✳")).toBeNull();
  });

  it("collapses internal whitespace", () => {
    expect(agentNameFromTitle("✳  Fix   the\tparser ")).toBe("Fix the parser");
  });

  it("keeps titles that start with a digit or non-latin letter", () => {
    expect(agentNameFromTitle("2fa rollout")).toBe("2fa rollout");
    expect(agentNameFromTitle("✳ 修复登录")).toBe("修复登录");
  });
});

describe("resolveAgentLabel", () => {
  it("prefers the CLI's terminal title", () => {
    expect(
      resolveAgentLabel({ cliTitle: "✳ Fix login bug", brand: "claude", cwd: "/x/tron", tabTitle: "Tab" }),
    ).toBe("Fix login bug");
  });

  it("falls back to brand + folder when the CLI hasn't named the session", () => {
    expect(
      resolveAgentLabel({ cliTitle: "✳ Claude Code", brand: "claude", cwd: "/Users/me/tron", tabTitle: "Tab" }),
    ).toBe("claude · tron");
  });

  it("handles Windows cwd paths", () => {
    expect(resolveAgentLabel({ brand: "codex", cwd: "C:\\code\\api", tabTitle: "Tab" })).toBe("codex · api");
  });

  it("falls back to the tab title without a brand", () => {
    expect(resolveAgentLabel({ cwd: "/x/tron", tabTitle: "Deploy fix" })).toBe("Deploy fix");
  });

  it("uses the brand alone when there is no cwd", () => {
    expect(resolveAgentLabel({ brand: "claude", tabTitle: "Tab" })).toBe("claude");
  });

  it("ends at Terminal when nothing is known", () => {
    expect(resolveAgentLabel({})).toBe("Terminal");
  });
});

describe("formatElapsed", () => {
  it("never exceeds four characters", () => {
    for (const s of [0, 9, 10, 59, 60, 61, 599, 3599, 3600, 3661, 35_999, 36_000, 359_999]) {
      expect(formatElapsed(s).length).toBeLessThanOrEqual(4);
    }
  });

  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(42)).toBe("42s");
    expect(formatElapsed(125)).toBe("2m");
    expect(formatElapsed(3600 + 5 * 60)).toBe("1h05");
    expect(formatElapsed(12 * 3600)).toBe("12h");
  });
});

describe("layoutSessionOrder", () => {
  const leaf = (sessionId: string) => ({ type: "leaf" as const, sessionId });
  const tabs: Tab[] = [
    {
      id: "t1",
      title: "one",
      activeSessionId: "b",
      root: {
        type: "split",
        direction: "horizontal",
        sizes: [50, 50],
        children: [leaf("a"), { type: "split", direction: "vertical", sizes: [50, 50], children: [leaf("b"), leaf("c")] }],
      },
    },
    { id: "t2", title: "two", activeSessionId: "d", root: leaf("d") },
  ];

  it("lists sessions by tab, then pane position", () => {
    expect(layoutSessionOrder(tabs)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("stepAgentWatch", () => {
  const working = { active: true, permission: false };
  const idle = { active: false, permission: false };
  const asking = { active: true, permission: true };

  /** Feed (state, at-ms) samples; collect emitted events with their time. */
  const run = (samples: Array<[{ active: boolean; permission: boolean }, number]>) => {
    let watch: AgentWatch | undefined;
    const events: Array<[string, number]> = [];
    for (const [state, at] of samples) {
      const r = stepAgentWatch(watch, state, at);
      watch = r.watch;
      if (r.event) events.push([r.event, at]);
    }
    return events;
  };

  it("reports a finished turn once the agent has stayed idle for the settle time", () => {
    expect(run([[working, 0], [working, 12_000], [idle, 12_500], [idle, 14_000], [idle, 15_600], [idle, 30_000]]))
      .toEqual([["finished", 15_600]]);
  });

  it("treats a short pause mid-turn as the same turn", () => {
    expect(run([[working, 0], [idle, 6_000], [idle, 7_500], [working, 8_000], [idle, 20_000], [idle, 23_100]]))
      .toEqual([["finished", 23_100]]);
  });

  it("ignores blips shorter than the minimum working time", () => {
    expect(run([[working, 0], [idle, 2_000], [idle, 6_000]])).toEqual([]);
  });

  it("reports an approval request immediately and only once", () => {
    expect(run([[working, 0], [asking, 500], [asking, 5_000], [working, 6_000]])).toEqual([["needs-approval", 500]]);
  });

  it("stays quiet while idle from the start", () => {
    expect(run([[idle, 0], [idle, 60_000]])).toEqual([]);
  });
});
