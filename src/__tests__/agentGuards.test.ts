import { describe, it, expect } from "vitest";
import {
  isTerminalTool,
  hashContent,
  buildActionKey,
  buildCoarseKey,
  coarseArgsOf,
  maxConsecutiveFor,
  coarseThresholdFor,
  isConsecutiveRepeat,
  isAlternatingRepeat,
  isSemanticRepeat,
  detectRepetition,
} from "../services/ai/agent/guards";

const key = (a: Record<string, any>) => buildActionKey(a);
const exec = (command: string) => ({ tool: "execute_command", command });

describe("isTerminalTool", () => {
  it("exempts final_answer and ask_question from loop detection (log fd5977963a)", () => {
    // Blocking a final_answer while telling the model to use final_answer
    // is a deadlock by construction.
    expect(isTerminalTool("final_answer")).toBe(true);
    expect(isTerminalTool("ask_question")).toBe(true);
    expect(isTerminalTool("execute_command")).toBe(false);
    expect(isTerminalTool("read_terminal")).toBe(false);
  });
});

describe("hashContent", () => {
  it("passes through short strings unchanged", () => {
    expect(hashContent("abc")).toBe("abc");
    expect(hashContent("x".repeat(64))).toBe("x".repeat(64));
  });

  it("collapses long strings to a bounded length#hash fingerprint", () => {
    const out = hashContent("y".repeat(5000))!;
    expect(out).toMatch(/^5000#-?\d+$/);
    expect(out.length).toBeLessThan(32);
  });

  it("gives different fingerprints to different long payloads", () => {
    expect(hashContent("a".repeat(200))).not.toBe(hashContent("b".repeat(200)));
  });

  it("passes through empty and undefined", () => {
    expect(hashContent("")).toBe("");
    expect(hashContent(undefined)).toBeUndefined();
  });
});

describe("buildActionKey", () => {
  it("distinguishes different commands and matches identical ones", () => {
    expect(key(exec("ls"))).toBe(key(exec("ls")));
    expect(key(exec("ls"))).not.toBe(key(exec("pwd")));
  });

  it("distinguishes two different edits to the SAME file", () => {
    // Recording only the path let models re-edit one file forever.
    const a = { tool: "edit_file", path: "/a.ts", search: "foo", replace: "bar" };
    const b = { tool: "edit_file", path: "/a.ts", search: "baz", replace: "qux" };
    expect(key(a)).not.toBe(key(b));
  });

  it("matches an identical re-emitted edit", () => {
    const e = { tool: "edit_file", path: "/a.ts", search: "foo", replace: "bar" };
    expect(key(e)).toBe(key({ ...e }));
  });

  it("varies with EACH payload field independently", () => {
    // One case per field, holding the others fixed — otherwise dropping a
    // single field from the key goes unnoticed because a sibling still differs.
    const base = {
      tool: "edit_file", path: "/a.ts", command: "c", text: "t",
      query: "q", url: "u", search: "s", replace: "r", content: "n",
    };
    for (const field of ["tool", "path", "command", "text", "query", "url", "search", "replace", "content"]) {
      expect(key(base), field).not.toBe(key({ ...base, [field]: "CHANGED" }));
    }
  });

  it("stays bounded for very large write payloads", () => {
    expect(key({ tool: "write_file", path: "/a.ts", content: "z".repeat(100_000) }).length)
      .toBeLessThan(200);
  });

  it("separates web searches with different queries", () => {
    expect(key({ tool: "web_search", query: "a" })).not.toBe(key({ tool: "web_search", query: "b" }));
  });
});

describe("buildCoarseKey / coarseArgsOf", () => {
  it("groups a command by its first 50 characters", () => {
    expect(buildCoarseKey(exec("echo " + "x".repeat(100))))
      .toBe(buildCoarseKey(exec("echo " + "x".repeat(100) + " extra")));
  });

  it("separates genuinely different edits to one file", () => {
    const a = { tool: "edit_file", path: "/a.ts", search: "alpha", replace: "one" };
    const b = { tool: "edit_file", path: "/a.ts", search: "beta", replace: "two" };
    expect(buildCoarseKey(a)).not.toBe(buildCoarseKey(b));
  });

  it("collides for reword-only reattempts of the same edit", () => {
    const a = { tool: "edit_file", path: "/a.ts", search: "alpha", replace: "one" };
    expect(buildCoarseKey(a)).toBe(buildCoarseKey({ ...a }));
  });

  it("picks the first available argument for coarse grouping", () => {
    expect(coarseArgsOf(exec("ls"))).toBe("ls");
    expect(coarseArgsOf({ tool: "web_search", query: "q" })).toBe("q");
    expect(coarseArgsOf({ tool: "read_file", path: "/p" })).toBe("/p");
    expect(coarseArgsOf({ tool: "web_fetch", url: "u" })).toBe("u");
    expect(coarseArgsOf({ tool: "read_terminal", lines: 5 })).toBe("");
  });
});

describe("tolerances", () => {
  it("gives repeating tools a higher consecutive tolerance", () => {
    expect(maxConsecutiveFor("send_text")).toBe(5);
    expect(maxConsecutiveFor("read_terminal")).toBe(5);
    expect(maxConsecutiveFor("execute_command")).toBe(2);
    expect(maxConsecutiveFor("edit_file")).toBe(2);
  });

  it("gives repeating tools a higher semantic threshold", () => {
    expect(coarseThresholdFor("read_terminal")).toBe(8);
    expect(coarseThresholdFor("send_text")).toBe(8);
    expect(coarseThresholdFor("execute_command")).toBe(5);
  });
});

describe("isConsecutiveRepeat", () => {
  it("flags the second identical exec but not the first", () => {
    const k = key(exec("ls"));
    expect(isConsecutiveRepeat([k], k, 2)).toBe(false);
    expect(isConsecutiveRepeat([k, k], k, 2)).toBe(true);
  });

  it("does not flag when the run is broken by another action", () => {
    const a = key(exec("ls")), b = key(exec("pwd"));
    expect(isConsecutiveRepeat([a, b], a, 2)).toBe(false);
  });

  it("tolerates four repeats of send_text and flags the fifth", () => {
    const k = key({ tool: "send_text", text: "\r" });
    expect(isConsecutiveRepeat([k, k, k, k], k, 5)).toBe(false);
    expect(isConsecutiveRepeat([k, k, k, k, k], k, 5)).toBe(true);
  });

  it("never flags a null key", () => {
    expect(isConsecutiveRepeat(["a", "a"], null, 2)).toBe(false);
  });
});

describe("isAlternatingRepeat", () => {
  it("flags a full A-B-A-B-A-B ping-pong", () => {
    expect(isAlternatingRepeat(["a", "b", "a", "b", "a", "b"])).toBe(true);
  });

  it("needs six entries", () => {
    expect(isAlternatingRepeat(["a", "b", "a", "b"])).toBe(false);
  });

  it("ignores a window that merely ends in an alternation", () => {
    expect(isAlternatingRepeat(["x", "y", "z", "b", "a", "b"])).toBe(false);
  });

  it("does not flag six distinct actions", () => {
    expect(isAlternatingRepeat(["a", "b", "c", "d", "e", "f"])).toBe(false);
  });
});

describe("isSemanticRepeat", () => {
  it("flags five coarse matches for an ordinary tool", () => {
    const k = "execute_command:probe";
    expect(isSemanticRepeat(Array(4).fill(k), k, "execute_command")).toBe(false);
    expect(isSemanticRepeat(Array(5).fill(k), k, "execute_command")).toBe(true);
  });

  it("requires eight for a legitimately repeating tool", () => {
    const k = "read_terminal:";
    expect(isSemanticRepeat(Array(7).fill(k), k, "read_terminal")).toBe(false);
    expect(isSemanticRepeat(Array(8).fill(k), k, "read_terminal")).toBe(true);
  });
});

describe("detectRepetition", () => {
  const base = {
    action: exec("ls"),
    actionKey: key(exec("ls")),
    recentActions: [] as string[],
    recentCoarseKeys: [] as string[],
    coarseKey: "execute_command:ls",
    coarseTotal: 1,
  };

  it("is quiet for a novel action", () => {
    expect(detectRepetition(base).suspicious).toBe(false);
  });

  it("reports the consecutive signal", () => {
    const k = base.actionKey;
    const s = detectRepetition({ ...base, recentActions: [k, k] });
    expect(s.consecutive).toBe(true);
    expect(s.suspicious).toBe(true);
  });

  it("reports the hard cumulative cap independently of the arbiter", () => {
    const s = detectRepetition({ ...base, coarseTotal: 12 });
    expect(s.hardRepetition).toBe(true);
    expect(s.suspicious).toBe(true);
  });

  it("never hard-caps tools that legitimately repeat", () => {
    const s = detectRepetition({
      ...base,
      action: { tool: "read_terminal", lines: 50 },
      coarseTotal: 99,
      coarseKey: "read_terminal:",
    });
    expect(s.hardRepetition).toBe(false);
  });
});
