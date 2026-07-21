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

  it("ignores text that contains a glyph but lacks the esc-to-interrupt marker", () => {
    expect(parseSpinnerLine("✻ note: thinking is enabled")).toBeNull();
    expect(parseSpinnerLine("✻ Welcome to Claude Code v1.0")).toBeNull();
  });

  it("matches when the spinner suffix wraps onto its own line (narrow terminal)", () => {
    // Claude Code renders the spinner as a flex-row with three Ink Box
    // children; on narrow terminals the suffix wraps and 'esc to interrupt'
    // ends up on a separate line from the glyph + verb.
    const wrapped = "✻ Cogitating…\n(5s · ↑ 2.3k tokens · esc to interrupt)";
    const out = parseSpinnerLine(wrapped);
    expect(out).not.toBeNull();
    expect(out!.working).toBe(true);
    expect(out!.elapsedSeconds).toBe(5);
    expect(out!.tokens).toBe(2300);
  });

  it("tolerates 'esc' and 'to interrupt' on different lines", () => {
    const split = "(5s · esc\n   to interrupt)";
    expect(parseSpinnerLine(split)).not.toBeNull();
  });

  it("recognises the spinner WITHOUT a glyph (only the suffix arrived)", () => {
    // When the screen scan only captures the bottom of a wrapped spinner,
    // the glyph + verb are off-screen but the suffix line is enough since
    // 'esc to interrupt' is unique to Claude Code.
    expect(
      parseSpinnerLine("(7s · esc to interrupt)"),
    ).not.toBeNull();
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

  it("recognises Claude Code's current permission dialog frame", () => {
    const out = detectExternalAgentSignal(
      [
        "╭─ Run command ─────────────────────────────╮",
        "│ npm test                                  │",
        "│ Do you want to proceed?                   │",
        "│ ❯ 1. Yes                                  │",
        "│   2. Yes, and don't ask again for npm:*   │",
        "│   3. No                                   │",
        "╰───────────────────────────────────────────╯",
        "Esc to cancel · Tab to amend",
      ].join("\n"),
    );
    expect(out.permission).toBe(true);
    expect(out.agentPresent).toBe(true);
  });

  it("recognises Codex-style approval prompts", () => {
    const out = detectExternalAgentSignal(
      "OpenAI Codex\nAllow command `npm test`? [y/N]",
    );
    expect(out.permission).toBe(true);
    expect(out.agentPresent).toBe(true);
  });

  it("does not treat permission-denied output as an approval prompt", () => {
    const out = detectExternalAgentSignal("mkdir: permission denied");
    expect(out.permission).toBeFalsy();
  });

  it("does not bootstrap agent status from a bare yes/no shell prompt", () => {
    const out = detectExternalAgentSignal("Overwrite file? [y/N]");
    expect(out.permission).toBeFalsy();
    expect(out.agentPresent).toBeUndefined();
  });

  it("allows terse approval prompts once the session is already an agent", () => {
    const out = detectExternalAgentSignal("Overwrite changes? [y/N]", {
      allowTersePermission: true,
    });
    expect(out.permission).toBe(true);
    expect(out.agentPresent).toBe(true);
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

  it("flags agentPresent on 'Welcome to Claude Code v1.x'", () => {
    // Verbatim from src/components/LogoV2/WelcomeV2.tsx
    const out = detectExternalAgentSignal("Welcome to Claude Code v1.0.42");
    expect(out.agentPresent).toBe(true);
  });

  it("flags agentPresent on the condensed logo line ('claude-3-5-sonnet · …')", () => {
    // Verbatim shape from src/components/LogoV2/CondensedLogo.tsx
    const out = detectExternalAgentSignal("Claude Code v1.0.42\nclaude-3-5-sonnet · billing");
    expect(out.agentPresent).toBe(true);
  });

  it("flags agentPresent on cwd: path in Claude Code's startup", () => {
    const out = detectExternalAgentSignal(" cwd: /Users/me/projects/foo");
    expect(out.agentPresent).toBe(true);
  });

  it("flags agentPresent on a model id like sonnet-4-6", () => {
    const out = detectExternalAgentSignal("Using sonnet-4-6 (1M context)");
    expect(out.agentPresent).toBe(true);
  });

  it("flags agentPresent on an OpenAI Codex banner", () => {
    const out = detectExternalAgentSignal("OpenAI Codex CLI");
    expect(out.agentPresent).toBe(true);
  });

  it("does NOT flag agentPresent on plain prose mentioning codex", () => {
    const out = detectExternalAgentSignal("see the ancient codex entry");
    expect(out.agentPresent).toBeUndefined();
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

// =============================================================================
// Permission staleness — root-cause regression guards.
//
// Bug: after a Claude Code permission prompt is approved, the answered
// "Do you want to proceed? … Yes … No" box lingers in scrollback. The detector
// scanned the whole buffer, so it kept reporting permission=true and the
// status dot stayed latched yellow ("needs approval") even though Claude had
// resumed working. Fixes: (1) the working spinner and a permission prompt are
// mutually exclusive — Claude hides the spinner while awaiting approval, so a
// live spinner means it is NOT waiting; (2) permission is a live bottom-of-
// screen UI state, so only the bottom region is scanned, not scrollback.
// =============================================================================

describe("permission staleness (root-cause regression guards)", () => {
  it("does NOT report permission when the working spinner is present (approval resumed work)", () => {
    const frame = [
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
      "⏺ Bash(npm test)",
      "  ⎿ running…",
      "✻ Running… (3s · ↑ 1.2k tokens · esc to interrupt)",
    ].join("\n");
    const out = detectExternalAgentSignal(frame);
    expect(out.working).toBe(true);
    expect(out.permission).toBeFalsy();
  });

  it("does NOT report permission from an answered prompt scrolled out of the live region", () => {
    const lines = ["Do you want to proceed?", "❯ 1. Yes", "  2. No"];
    for (let i = 0; i < 25; i++) lines.push(`output line ${i}`);
    const out = detectExternalAgentSignal(lines.join("\n"));
    expect(out.permission).toBeFalsy();
  });

  it("still reports a live permission prompt at the bottom of the screen", () => {
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) lines.push(`scrollback line ${i}`);
    lines.push(
      "╭─ Run command ───────────╮",
      "│ npm test                │",
      "│ Do you want to proceed? │",
      "│ ❯ 1. Yes                │",
      "│   2. No                 │",
      "╰──────────────────────────╯",
    );
    const out = detectExternalAgentSignal(lines.join("\n"));
    expect(out.permission).toBe(true);
  });

  it("still reports a terse live prompt at the bottom for a known agent session", () => {
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) lines.push(`scrollback line ${i}`);
    lines.push("Apply this patch? [y/N]");
    const out = detectExternalAgentSignal(lines.join("\n"), {
      allowTersePermission: true,
    });
    expect(out.permission).toBe(true);
  });
});

// ── Claude Code ≥2.1 (verified against a live 2.1.216 PTY capture) ─────────
describe("Claude Code 2.1+ UI (no 'esc to interrupt')", () => {
  it("detects the gerund spinner as working", () => {
    const sig = detectExternalAgentSignal("✢ Contemplating… ");
    expect(sig.working).toBe(true);
    expect(sig.agentPresent).toBe(true);
  });

  it("does NOT treat the past-tense completion line as working", () => {
    const sig = detectExternalAgentSignal("✻ Crunched for 2s");
    expect(sig.working).toBeUndefined();
  });

  it("detects the ❯ prompt frame with footer as idle", () => {
    const frame = [
      "────────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────────",
      "⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    const sig = detectExternalAgentSignal(frame);
    expect(sig.idle).toBe(true);
    expect(sig.agentPresent).toBe(true);
  });

  it("does NOT read a permission select (❯ 1. Yes) as idle", () => {
    const frame = [
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No",
      "Esc to cancel",
    ].join("\n");
    const sig = detectExternalAgentSignal(frame);
    expect(sig.idle).toBeUndefined();
    expect(sig.permission).toBe(true);
  });

  it("treats ⎿ Interrupted as idle", () => {
    const sig = detectExternalAgentSignal("⎿  Interrupted · What should Claude do instead?");
    expect(sig.idle).toBe(true);
  });

  it("working overrides the idle frame in the same buffer", () => {
    const frame = [
      "✻ Simmering…",
      "────────────────────────────────",
      "❯ ",
      "⏵⏵ bypass permissions on (shift+tab to cycle)",
    ].join("\n");
    const sig = detectExternalAgentSignal(frame);
    expect(sig.working).toBe(true);
    expect(sig.idle).toBeUndefined();
  });

  it("recognizes the new footer as an agent marker", () => {
    const sig = detectExternalAgentSignal("Fable5 │ 5h ◔ 16% │ ses $0.35\n⏵⏵ bypass permissions on (shift+tab to cycle)");
    expect(sig.agentPresent).toBe(true);
  });
});

// ── Codex CLI ≥0.14x ───────────────────────────────────────────────────────
describe("Codex CLI status detection", () => {
  it("detects Working state when a codex marker is present", () => {
    const sig = detectExternalAgentSignal("OpenAI Codex v0.144\n• Working");
    expect(sig.working).toBe(true);
  });

  it("ignores bare 'Working' with no agent marker (generic shell output)", () => {
    const sig = detectExternalAgentSignal("Working\non something");
    expect(sig.working).toBeUndefined();
  });

  it("detects Working via option flag when session is known-agent", () => {
    const sig = detectExternalAgentSignal("▌ Thinking", { allowTersePermission: true });
    expect(sig.working).toBe(true);
  });

  it("detects the › composer as idle for a known codex session", () => {
    const sig = detectExternalAgentSignal("chatgpt.com/codex\n› ", {});
    expect(sig.idle).toBe(true);
  });
});
