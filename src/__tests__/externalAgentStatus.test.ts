import { describe, it, expect } from "vitest";
import {
  detectExternalAgentSignal,
  parseSpinnerLine,
} from "../utils/externalAgentStatus";

// =============================================================================
// parseSpinnerLine — extracts working/tool/elapsed/tokens from Claude Code's
// canonical spinner line:
//   ✻ Cogitating… (5s · ↑ 2.3k tokens · esc to interrupt)
// =============================================================================

describe("parseSpinnerLine", () => {
  it("recognises the canonical spinner with all fields", () => {
    const out = parseSpinnerLine(
      "✻ Cogitating… (5s · ↑ 2.3k tokens · esc to interrupt)",
    );
    expect(out).not.toBeNull();
    expect(out!.working).toBe(true);
    expect(out!.elapsedSeconds).toBe(5);
    expect(out!.tokens).toBe(2300);
  });

  it("recognises any of Claude Code's spinner glyphs", () => {
    for (const g of ["·", "✢", "✳", "✶", "✻", "✽", "*"]) {
      const out = parseSpinnerLine(`${g} Crafting… (12s · esc to interrupt)`);
      expect(out, `glyph ${g}`).not.toBeNull();
      expect(out!.working).toBe(true);
    }
  });

  it("requires the (esc to interrupt) marker to flag working", () => {
    // No esc-to-interrupt = Claude is idle (the spinner is gone)
    const out = parseSpinnerLine("✻ Some leftover line");
    expect(out).toBeNull();
  });

  it("parses k-suffixed token counts", () => {
    expect(
      parseSpinnerLine("✻ Brewing… (3s · ↑ 12.5k tokens · esc to interrupt)")!
        .tokens,
    ).toBe(12500);
    expect(
      parseSpinnerLine("✻ Brewing… (3s · ↑ 800 tokens · esc to interrupt)")!
        .tokens,
    ).toBe(800);
  });

  it("parses long elapsed (m / h prefixes are returned as seconds)", () => {
    expect(
      parseSpinnerLine("✻ Brewing… (1m20s · esc to interrupt)")!.elapsedSeconds,
    ).toBe(80);
  });

  it("returns null on a plain output line", () => {
    expect(parseSpinnerLine("⏺ Read")).toBeNull();
    expect(parseSpinnerLine("hello world")).toBeNull();
    expect(parseSpinnerLine("")).toBeNull();
  });

  it("ignores lines that contain a glyph but lack both the verb and the marker", () => {
    expect(parseSpinnerLine("✻ note: thinking is enabled")).toBeNull();
  });
});

// =============================================================================
// detectExternalAgentSignal — combined detector that runs on each terminal
// data chunk and returns a coherent status snapshot.
// =============================================================================

describe("detectExternalAgentSignal", () => {
  it("flags working=true on spinner line", () => {
    const out = detectExternalAgentSignal(
      "✻ Cogitating… (5s · ↑ 2.3k tokens · esc to interrupt)",
    );
    expect(out.working).toBe(true);
    expect(out.tool).toBe("thinking");
    expect(out.tokens).toBe(2300);
  });

  it("identifies a Claude Code tool call line via the ⏺ marker", () => {
    const out = detectExternalAgentSignal("⏺ Read(/path/to/file.ts)");
    expect(out.tool).toBe("read_file");
    // Tool calls don't include the spinner — caller decides 'working' from
    // surrounding context, but the chunk itself isn't enough.
    expect(out.working).toBeUndefined();
  });

  it("recognises Claude Code permission prompts", () => {
    const out = detectExternalAgentSignal("Allow Bash(rm -rf /tmp/foo)?");
    expect(out.permission).toBe(true);
  });

  it("treats the input prompt box as an idle marker", () => {
    // Claude Code's idle state shows a prompt box — these glyphs are unique
    // to the input frame and never appear during work.
    const out = detectExternalAgentSignal(
      "╭───────────────────╮\n│ > _              │\n╰───────────────────╯",
    );
    expect(out.idle).toBe(true);
  });

  it("returns nothing definitive on plain text", () => {
    const out = detectExternalAgentSignal("hello world");
    expect(out.tool).toBeUndefined();
    expect(out.permission).toBeFalsy();
    expect(out.working).toBeUndefined();
    expect(out.idle).toBeFalsy();
  });

  it("recognises gerund tool form (⏺ Reading 3 files…)", () => {
    expect(detectExternalAgentSignal("⏺ Reading 3 files…").tool).toBe(
      "read_file",
    );
    expect(detectExternalAgentSignal("⏺ Editing 2 files…").tool).toBe(
      "edit_file",
    );
    expect(detectExternalAgentSignal("⏺ Running…").tool).toBe(
      "execute_command",
    );
  });

  it("strips ANSI before pattern matching", () => {
    const ansi = "\x1b[36m✻\x1b[0m Brewing… (4s · esc to interrupt)";
    const out = detectExternalAgentSignal(ansi);
    expect(out.working).toBe(true);
  });

  it("flags agentPresent on the Claude Code welcome banner", () => {
    const out = detectExternalAgentSignal("✻ Welcome to Claude Code");
    expect(out.agentPresent).toBe(true);
    // No working / tool / idle yet — just presence
    expect(out.working).toBeUndefined();
    expect(out.tool).toBeUndefined();
  });

  it("flags agentPresent on cwd: path in Claude Code's startup", () => {
    const out = detectExternalAgentSignal(" cwd: /Users/me/projects/foo");
    expect(out.agentPresent).toBe(true);
  });

  it("flags agentPresent on a model id like sonnet-4-6", () => {
    const out = detectExternalAgentSignal("Using sonnet-4-6 (1M context)");
    expect(out.agentPresent).toBe(true);
  });

  it("does NOT flag agentPresent on plain prose mentioning 'claude'", () => {
    // The word 'claude' alone shouldn't false-positive — needs a stronger signal
    const out = detectExternalAgentSignal("hello claude how are you");
    expect(out.agentPresent).toBeUndefined();
  });

  it("treats the idle prompt frame as both idle and agentPresent", () => {
    const out = detectExternalAgentSignal(
      "╭───────────────────╮\n│ > _              │\n╰───────────────────╯",
    );
    expect(out.idle).toBe(true);
    expect(out.agentPresent).toBe(true);
  });

  it("a working spinner also implies agentPresent", () => {
    const out = detectExternalAgentSignal(
      "✻ Crafting… (3s · esc to interrupt)",
    );
    expect(out.working).toBe(true);
    expect(out.agentPresent).toBe(true);
  });
});
