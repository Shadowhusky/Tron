import { describe, it, expect } from "vitest";
import {
  agentNameFromTitle,
  resolveAgentLabel,
  formatElapsed,
  layoutSessionOrder,
  agentTransition,
} from "../utils/agentStatusDisplay";
import type { Tab } from "../types";

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

describe("agentTransition", () => {
  const idle = { active: false, permission: false };
  const working = { active: true, permission: false };
  const asking = { active: true, permission: true };

  it("reports a finished turn after real work", () => {
    expect(agentTransition(working, idle, 12_000)).toBe("finished");
  });

  it("ignores blips shorter than the minimum working time", () => {
    expect(agentTransition(working, idle, 2_000)).toBeNull();
  });

  it("reports a new approval request immediately", () => {
    expect(agentTransition(working, asking, 500)).toBe("needs-approval");
    expect(agentTransition(idle, asking, 0)).toBe("needs-approval");
  });

  it("stays quiet while nothing meaningful changes", () => {
    expect(agentTransition(asking, asking, 30_000)).toBeNull();
    expect(agentTransition(working, working, 30_000)).toBeNull();
    expect(agentTransition(idle, working, 0)).toBeNull();
  });

  it("does not report a finish when the approval prompt is answered", () => {
    expect(agentTransition(asking, working, 20_000)).toBeNull();
  });
});
