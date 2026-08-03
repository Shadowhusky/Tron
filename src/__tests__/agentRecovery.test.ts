import { describe, it, expect } from "vitest";
import { detectResumableAgent, buildResumeCommand, extractResumeFragments } from "../utils/agentRecovery";
import { detectAgentBrand, hasLiveAgentFrame } from "../utils/externalAgentStatus";

// Restored-history fixtures: what the persisted PTY tail looks like after an
// app restart, depending on what was running at quit.

const CLAUDE_IDLE_FRAME = [
  "✻ Welcome to Claude Code v2.1.216",
  "",
  "● I've finished refactoring the parser module.",
  "",
  "────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────",
  "⏵⏵ bypass permissions on (shift+tab to cycle)",
].join("\n");

const CLAUDE_WORKING = [
  "✻ Welcome to Claude Code v2.1.216",
  "",
  "● Reading src/index.ts…",
  "✻ Cogitating… (5s · ↑ 2.3k tokens · esc to interrupt)",
].join("\n");

const CODEX_IDLE = [
  ">_ OpenAI Codex (v0.45.0)",
  "",
  "• I updated the failing test as requested.",
  "",
  "› ",
  "⏎ send   ⌃T transcript   ⌃C quit",
].join("\n");

const SHELL_AFTER_CLAUDE_EXIT = [
  "✻ Welcome to Claude Code v2.1.216",
  "● Done. Anything else?",
  "⏵⏵ bypass permissions on (shift+tab to cycle)",
  "",
  "richard@mac tron % ",
].join("\n");

const SHELL_AFTER_CLAUDE_EXIT_STARSHIP = [
  "✻ Welcome to Claude Code v2.1.216",
  "● Done. Anything else?",
  "⏵⏵ bypass permissions on (shift+tab to cycle)",
  "",
  "❯",
].join("\n");

const PLAIN_SHELL = [
  "richard@mac tron % ls",
  "src package.json",
  "richard@mac tron % ",
].join("\n");

describe("detectAgentBrand", () => {
  it("identifies each brand from its banner", () => {
    expect(detectAgentBrand("✻ Welcome to Claude Code v2.1.0")).toBe("claude");
    expect(detectAgentBrand(">_ OpenAI Codex (v0.45.0)")).toBe("codex");
    expect(detectAgentBrand("aider v0.86.1")).toBe("aider");
    expect(detectAgentBrand("cursor agent v1.0")).toBe("cursor");
    expect(detectAgentBrand("just a shell $ ls")).toBeNull();
  });
});

describe("hasLiveAgentFrame", () => {
  it("sees Claude's idle input frame and working spinner", () => {
    expect(hasLiveAgentFrame(CLAUDE_IDLE_FRAME, "claude")).toBe(true);
    expect(hasLiveAgentFrame("✻ Cogitating… (5s · esc to interrupt)", "claude")).toBe(true);
  });
  it("sees Codex's composer prompt", () => {
    expect(hasLiveAgentFrame(CODEX_IDLE, "codex")).toBe(true);
  });
  it("rejects plain shell output", () => {
    expect(hasLiveAgentFrame(PLAIN_SHELL, "claude")).toBe(false);
    expect(hasLiveAgentFrame(PLAIN_SHELL, "codex")).toBe(false);
  });
});

describe("detectResumableAgent", () => {
  it("resumes Claude when its idle frame is the tail", () => {
    expect(detectResumableAgent(CLAUDE_IDLE_FRAME)).toBe("claude");
  });

  it("resumes Claude when it was mid-task (spinner)", () => {
    expect(detectResumableAgent(CLAUDE_WORKING)).toBe("claude");
  });

  it("resumes Codex at its composer", () => {
    expect(detectResumableAgent(CODEX_IDLE)).toBe("codex");
  });

  it("does NOT resume when the CLI exited back to a shell prompt", () => {
    expect(detectResumableAgent(SHELL_AFTER_CLAUDE_EXIT)).toBeNull();
  });

  it("does NOT resume when a starship-style ❯ prompt ends the tail", () => {
    expect(detectResumableAgent(SHELL_AFTER_CLAUDE_EXIT_STARSHIP)).toBeNull();
  });

  it("ignores plain shell history and empty input", () => {
    expect(detectResumableAgent(PLAIN_SHELL)).toBeNull();
    expect(detectResumableAgent("")).toBeNull();
  });

  it("ignores agent banners buried in scrollback above a busy process", () => {
    const tail = [
      "✻ Welcome to Claude Code v2.1.216",
      ...Array.from({ length: 40 }, (_, i) => `compiling module ${i}…`),
    ].join("\n");
    expect(detectResumableAgent(tail)).toBeNull();
  });

});

describe("buildResumeCommand", () => {
  const id = "52366788-906a-41f8-b1cc-6871fb57ec9b";

  it("builds exact-id resume commands for claude and codex only", () => {
    expect(buildResumeCommand("claude", id)).toBe(`claude --resume ${id}`);
    expect(buildResumeCommand("codex", id)).toBe(`codex resume ${id}`);
    expect(buildResumeCommand("aider", id)).toBeNull();
    expect(buildResumeCommand("cursor", id)).toBeNull();
  });

  it("rejects non-uuid session ids (typed into a shell)", () => {
    expect(buildResumeCommand("claude", "")).toBeNull();
    expect(buildResumeCommand("claude", "abc")).toBeNull();
    expect(buildResumeCommand("claude", "$(rm -rf ~)")).toBeNull();
    expect(buildResumeCommand("claude", `${id}; echo pwned`)).toBeNull();
  });
});

describe("extractResumeFragments", () => {
  it("keeps distinctive transcript lines, drops TUI chrome and dupes", () => {
    const tail = [
      "✻ Welcome to Claude Code v2.1.216",
      "● I've finished refactoring the parser module for you.",
      "The new tokenizer handles nested template literals correctly.",
      "The new tokenizer handles nested template literals correctly.",
      "────────────────────────────────────────────",
      "❯ ",
      "⏵⏵ bypass permissions on (shift+tab to cycle)",
      "ok", // too short
    ].join("\n");
    const frags = extractResumeFragments(tail);
    expect(frags).toContain("I've finished refactoring the parser module for you.");
    expect(frags).toContain("The new tokenizer handles nested template literals correctly.");
    expect(frags.filter((f) => f.includes("tokenizer")).length).toBe(1);
    expect(frags.some((f) => /[❯⏵─]/.test(f))).toBe(false);
    expect(frags.some((f) => f === "ok")).toBe(false);
  });

  it("caps at 12 fragments from the end of the tail", () => {
    const tail = Array.from({ length: 30 }, (_, i) => `distinctive transcript sentence number ${i} here`).join("\n");
    const frags = extractResumeFragments(tail);
    expect(frags.length).toBe(12);
    expect(frags[11]).toContain("number 29");
  });
});
