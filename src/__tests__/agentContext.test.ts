import { describe, it, expect } from "vitest";
import {
  OLDER_AGENT_CHARS,
  OLDER_USER_CHARS,
  buildOlderConversation,
  summarizeOlderInteraction,
} from "../utils/agentContext";

// The exact task from log ddb57d1bbd (195 chars).
const REAL_TASK =
  "Create a tui (terminal ui) program that shows the allocation of current machine's storage" +
  "(what files/folder take how many storage space etc..), be easy to use, clean ui, lightwieght, lightnign fast";

describe("summarizeOlderInteraction", () => {
  it("keeps a real user task intact instead of clipping it mid-word", () => {
    const out = summarizeOlderInteraction("user", REAL_TASK);
    expect(out).toBe(`User: ${REAL_TASK}`);
    expect(out).not.toContain("…");
    // The old 80-char clip lost everything after "current machine'".
    expect(out).toContain("lightnign fast");
    expect(out).toContain("clean ui");
  });

  it("still bounds a runaway user message", () => {
    const huge = "x".repeat(5000);
    const out = summarizeOlderInteraction("user", huge);
    expect(out.length).toBeLessThanOrEqual("User: ".length + OLDER_USER_CHARS + 1);
    expect(out.endsWith("…")).toBe(true);
  });

  it("keeps agent turns short — they are already summaries", () => {
    const long = "y".repeat(400);
    const out = summarizeOlderInteraction("agent", long);
    expect(out.length).toBeLessThanOrEqual("Agent: ".length + OLDER_AGENT_CHARS + 1);
    expect(out.startsWith("Agent: ")).toBe(true);
  });

  it("gives the user's instruction more budget than the agent's reply", () => {
    expect(OLDER_USER_CHARS).toBeGreaterThan(OLDER_AGENT_CHARS);
  });

  it("handles empty and whitespace content without producing junk", () => {
    expect(summarizeOlderInteraction("user", "")).toBe("User: ");
    expect(summarizeOlderInteraction("agent", "   \n ")).toBe("Agent: ");
  });
});

describe("buildOlderConversation", () => {
  const convo = [
    { role: "user", content: REAL_TASK },
    { role: "agent", content: "Checked the toolchain; cargo is not installed." },
    { role: "user", content: "continue" },
  ];

  it("carries the whole conversation verbatim when the budget allows", () => {
    const out = buildOlderConversation(convo, 10_000);
    expect(out).toContain(REAL_TASK); // the WHOLE task, not a clipped prefix
    expect(out).toContain("Agent: Checked the toolchain");
    expect(out).toContain("User: continue");
    expect(out).not.toContain("…");
  });

  it("keeps the newest turns when the budget is tight", () => {
    const out = buildOlderConversation(convo, 60);
    expect(out).toContain("continue");
    // The oldest turn is the first to be dropped.
    expect(out.length).toBeLessThanOrEqual(60 + 40);
  });

  it("never exceeds the budget by more than one clipped turn", () => {
    const long = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? "agent" : "user",
      content: `turn ${i} ` + "z".repeat(500),
    }));
    const budget = 2_000;
    const out = buildOlderConversation(long, budget);
    expect(out.length).toBeLessThanOrEqual(budget + OLDER_USER_CHARS + 20);
  });

  it("skips blank turns instead of emitting empty labels", () => {
    const out = buildOlderConversation(
      [{ role: "user", content: "   " }, { role: "user", content: "real" }],
      1_000,
    );
    expect(out).toBe("User: real");
  });

  it("returns an empty string for an empty conversation", () => {
    expect(buildOlderConversation([], 1_000)).toBe("");
  });
});
