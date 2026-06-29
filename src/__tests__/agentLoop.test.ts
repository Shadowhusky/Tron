import { describe, it, expect } from "vitest";
import {
  cumulativeRepetitionCap,
  isHardRepetitionLoop,
  isFirstCapCross,
  isNovelAction,
  isUselessFetchResult,
  MIN_USEFUL_FETCH_CHARS,
  parseBracketToolCall,
} from "../utils/agentLoop";

const TOOLS = new Set([
  "execute_command", "run_in_terminal", "read_terminal",
  "final_answer", "ask_question", "write_file", "read_file",
]);
const isTool = (n: string) => TOOLS.has(n);

describe("agentLoop cumulative repetition cap", () => {
  it("caps general probe tools at 12", () => {
    expect(cumulativeRepetitionCap("execute_command")).toBe(12);
    expect(cumulativeRepetitionCap("web_search")).toBe(12);
    expect(cumulativeRepetitionCap("read_file")).toBe(12);
    expect(cumulativeRepetitionCap("edit_file")).toBe(12);
  });

  it("never caps read_terminal / send_text (legitimate repetition)", () => {
    expect(cumulativeRepetitionCap("read_terminal")).toBe(Infinity);
    expect(cumulativeRepetitionCap("send_text")).toBe(Infinity);
    expect(isHardRepetitionLoop(999, "read_terminal")).toBe(false);
    expect(isHardRepetitionLoop(999, "send_text")).toBe(false);
  });

  it("flags a hard loop once the shape repeats to/past the cap", () => {
    expect(isHardRepetitionLoop(11, "execute_command")).toBe(false);
    expect(isHardRepetitionLoop(12, "execute_command")).toBe(true);
    expect(isHardRepetitionLoop(50, "execute_command")).toBe(true);
  });

  it("fires the cap-cross signal exactly once (at the cap, not after)", () => {
    expect(isFirstCapCross(11, "execute_command")).toBe(false);
    expect(isFirstCapCross(12, "execute_command")).toBe(true);
    expect(isFirstCapCross(13, "execute_command")).toBe(false);
    expect(isFirstCapCross(12, "read_terminal")).toBe(false); // never caps
  });

  it("treats only the first occurrence of a shape as novel progress", () => {
    expect(isNovelAction(1)).toBe(true);
    expect(isNovelAction(2)).toBe(false);
    expect(isNovelAction(12)).toBe(false);
  });
});

describe("isUselessFetchResult (dead anti-scrape / JS-only pages)", () => {
  it("flags empty and whitespace-only results", () => {
    expect(isUselessFetchResult("")).toBe(true);
    expect(isUselessFetchResult("   \n\t  ")).toBe(true);
    expect(isUselessFetchResult(null)).toBe(true);
    expect(isUselessFetchResult(undefined)).toBe(true);
  });

  it("flags the tiny JS-shell stubs seen in the logged loop (0 and 27 chars)", () => {
    // moomoo/futunn returned ~27-char stubs; cfi returned 0.
    expect(isUselessFetchResult("Please enable JavaScript")).toBe(true); // 24 chars
    expect(isUselessFetchResult("x".repeat(MIN_USEFUL_FETCH_CHARS - 1))).toBe(true);
  });

  it("does NOT flag legitimate terse pages at/above the threshold", () => {
    // A real terse quote line is usable and must not be banned.
    expect(isUselessFetchResult("HCFA Zhejiang 38.65 CNY +1.2% P/E 25 mktcap 12B")).toBe(false);
    expect(isUselessFetchResult("y".repeat(MIN_USEFUL_FETCH_CHARS))).toBe(false);
  });

  it("ignores surrounding whitespace when measuring usable length", () => {
    const padded = `\n\n   ${"z".repeat(MIN_USEFUL_FETCH_CHARS)}   \n`;
    expect(isUselessFetchResult(padded)).toBe(false);
  });
});

describe("parseBracketToolCall", () => {
  it("parses [read_terminal(lines=50)] as read_terminal (the false-'done' bug)", () => {
    const a = parseBracketToolCall("[read_terminal(lines=50)]", isTool);
    expect(a).toEqual({ tool: "read_terminal", lines: 50 });
  });

  it("parses bare [read_terminal] with a default line count", () => {
    expect(parseBracketToolCall("[read_terminal]", isTool)).toEqual({
      tool: "read_terminal",
      lines: 50,
    });
  });

  it("parses [execute_command ls -la] (inline args)", () => {
    expect(parseBracketToolCall("[execute_command ls -la]", isTool)).toEqual({
      tool: "execute_command",
      command: "ls -la",
    });
  });

  it("parses [execute_command(npm test)] (parenthesised args)", () => {
    expect(parseBracketToolCall("[execute_command(npm test)]", isTool)).toEqual({
      tool: "execute_command",
      command: "npm test",
    });
  });

  it("parses the legacy [execute_command] trailing-args form", () => {
    expect(parseBracketToolCall("[execute_command] git status", isTool)).toEqual({
      tool: "execute_command",
      command: "git status",
    });
  });

  it("returns null for an unknown bracket token (caller falls back)", () => {
    expect(parseBracketToolCall("[search_web(query)]", isTool)).toBeNull();
    expect(parseBracketToolCall("[1] first, [2] second", isTool)).toBeNull();
    expect(parseBracketToolCall("just a normal answer", isTool)).toBeNull();
  });

  it("strips trailing JSON artifacts from the command", () => {
    const a = parseBracketToolCall('[execute_command ls -la"}', isTool);
    expect(a).toEqual({ tool: "execute_command", command: "ls -la" });
  });
});
