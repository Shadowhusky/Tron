import { describe, it, expect } from "vitest";
import { findEditableMatch, applyEdit } from "../utils/fileEdit";

// =============================================================================
// findEditableMatch — locates a search string in content, with progressive
// fallbacks for the kinds of near-misses LLMs commonly produce.
// =============================================================================

describe("findEditableMatch", () => {
  it("returns 'exact' mode for a clean direct hit", () => {
    const out = findEditableMatch("hello world", "world");
    expect(out).not.toBeNull();
    expect(out!.mode).toBe("exact");
    expect(out!.count).toBe(1);
  });

  it("counts every non-overlapping occurrence in exact mode", () => {
    const out = findEditableMatch("foo bar foo bar foo", "foo");
    expect(out!.count).toBe(3);
  });

  it("returns null when the search string is empty", () => {
    expect(findEditableMatch("hello", "")).toBeNull();
  });

  it("returns null when nothing matches under any normalization", () => {
    expect(findEditableMatch("hello world", "absent")).toBeNull();
  });

  it("matches when the file uses curly quotes but the LLM wrote straight quotes", () => {
    const file = `const greeting = “hello”;`; // curly double quotes
    const out = findEditableMatch(file, `const greeting = "hello";`);
    expect(out).not.toBeNull();
    expect(out!.mode).toBe("normalized");
    expect(out!.count).toBe(1);
  });

  it("matches when the LLM wrote curly quotes but the file has straight quotes", () => {
    const file = `const x = 'a';`;
    const search = `const x = ‘a’;`; // curly single quotes
    const out = findEditableMatch(file, search);
    expect(out).not.toBeNull();
    expect(out!.mode).toBe("normalized");
  });

  it("tolerates CRLF in the file when the search uses LF (or vice versa)", () => {
    const file = "line1\r\nline2\r\nline3\r\n";
    const out = findEditableMatch(file, "line1\nline2\n");
    expect(out).not.toBeNull();
    expect(out!.mode).toBe("normalized");
  });

  it("tolerates non-breaking spaces in the file", () => {
    const file = `hello world`;
    const out = findEditableMatch(file, "hello world");
    expect(out!.mode).toBe("normalized");
  });

  it("prefers exact-mode count even when normalized would also match", () => {
    const file = `"x"“x”"x"`;
    const out = findEditableMatch(file, `"x"`);
    expect(out!.mode).toBe("exact");
    expect(out!.count).toBe(2); // exact-only counts the two straight pairs
  });
});

// =============================================================================
// applyEdit — performs the substitution, preserving the file's original
// quote / line-ending style so the result doesn't drift.
// =============================================================================

describe("applyEdit", () => {
  it("returns null when no match exists", () => {
    expect(applyEdit("hello world", "absent", "x")).toBeNull();
  });

  it("replaces all exact matches", () => {
    const out = applyEdit("foo bar foo", "foo", "qux");
    expect(out!.content).toBe("qux bar qux");
    expect(out!.replacements).toBe(2);
  });

  it("preserves the file's curly quotes when the search used straight quotes", () => {
    const file = `say(“hello”)`;
    const out = applyEdit(file, `say("hello")`, `say("hi")`);
    expect(out!.content).toBe(`say(“hi”)`);
    expect(out!.replacements).toBe(1);
  });

  it("preserves CRLF endings if the file used CRLF", () => {
    const file = "a\r\nb\r\nc\r\n";
    const out = applyEdit(file, "a\nb", "AA\nBB");
    expect(out!.content).toBe("AA\r\nBB\r\nc\r\n");
  });

  it("matches across NBSP boundaries even when inserted text uses ASCII spaces", () => {
    const file = "alpha beta gamma";
    const out = applyEdit(file, "alpha beta", "X Y");
    expect(out!.content).toBe("X Y gamma");
    expect(out!.replacements).toBe(1);
  });

  it("returns the count of normalized matches", () => {
    const file = `“one” and “one”`;
    const out = applyEdit(file, `"one"`, `"two"`);
    expect(out!.replacements).toBe(2);
    expect(out!.content).toBe(`“two” and “two”`);
  });

  it("only swaps the matched span — surrounding text is untouched", () => {
    const file = `// note: do not edit\nfn = () => 1;\n// end`;
    const out = applyEdit(file, "fn = () => 1;", "fn = () => 2;");
    expect(out!.content).toBe(`// note: do not edit\nfn = () => 2;\n// end`);
    expect(out!.replacements).toBe(1);
  });
});
