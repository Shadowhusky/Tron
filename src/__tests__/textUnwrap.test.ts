import { describe, it, expect } from "vitest";
import {
  visualWidth,
  firstTokenWidth,
  isBlockStart,
  smartUnwrapSelection,
  joinHardWrappedUrl,
} from "../utils/textUnwrap";

describe("visualWidth / firstTokenWidth", () => {
  it("counts ASCII as 1 and CJK as 2 columns", () => {
    expect(visualWidth("abc")).toBe(3);
    expect(visualWidth("成都机器人")).toBe(10);
    expect(visualWidth("ab成都")).toBe(6);
  });
  it("measures the first non-space token, ignoring leading indent", () => {
    expect(firstTokenWidth("  continuation words")).toBe("continuation".length);
    expect(firstTokenWidth("单词 rest")).toBe(4);
    expect(firstTokenWidth("   ")).toBe(0);
  });
});

describe("isBlockStart", () => {
  it("treats bullets, box-drawing, and prompts as new blocks", () => {
    for (const l of ["⏺ item", "● dot", "- dash", "* star", "│ box", "╰─ end", "$ cmd", "> quote", "# head", ""]) {
      expect(isBlockStart(l)).toBe(true);
    }
  });
  it("treats plain prose as continuation material", () => {
    expect(isBlockStart("continuation of the sentence")).toBe(false);
    expect(isBlockStart("中文继续")).toBe(false);
  });
});

describe("smartUnwrapSelection (claude-code style hard-wrapped output)", () => {
  const COLS = 40;

  it("strips trailing padding spaces on every line", () => {
    const sel = "hello world      \nsecond line   ";
    expect(smartUnwrapSelection(sel, COLS)).toBe("hello world\nsecond line");
  });

  it("joins an indented word-wrapped paragraph into one line", () => {
    // line1 is 37 cols; next word "continuation" (12) would not fit -> wrap
    const line1 = "⏺ This is a response from claude that";
    const line2 = "  continuation of the same sentence.";
    expect(line1.length).toBe(37);
    expect(smartUnwrapSelection(`${line1}\n${line2}`, COLS)).toBe(
      "⏺ This is a response from claude that continuation of the same sentence.",
    );
  });

  it("does NOT join when the wrap invariant fails (short first line)", () => {
    const sel = "short line\n  more text here";
    expect(smartUnwrapSelection(sel, COLS)).toBe("short line\n  more text here");
  });

  it("does NOT join unindented lines (git log / ls style)", () => {
    const line1 = "878c060 a commit subject that fills up"; // 39 cols, near-full
    const line2 = "fc8708b another separate commit subject";
    expect(smartUnwrapSelection(`${line1}\n${line2}`, COLS)).toBe(`${line1}\n${line2}`);
  });

  it("does NOT join onto bullet / box lines even when indented", () => {
    const line1 = "⏺ A list intro that fills the width ok"; // 38
    const line2 = "  ⏺ second bullet item";
    expect(smartUnwrapSelection(`${line1}\n${line2}`, COLS)).toBe(`${line1}\n${line2}`);
  });

  it("joins a flush cut (exactly cols) without inserting a space", () => {
    const line1 = "x".repeat(COLS);
    const line2 = "yz";
    expect(smartUnwrapSelection(`${line1}\n${line2}`, COLS)).toBe(`${"x".repeat(COLS)}yz`);
  });

  it("joins CJK flush cut without inserting a space", () => {
    const line1 = "统".repeat(COLS / 2); // width 40, flush
    const line2 = "计结果";
    expect(smartUnwrapSelection(`${line1}\n${line2}`, COLS)).toBe(`${line1}${line2}`);
  });

  it("preserves blank lines as paragraph separators", () => {
    const sel = "para one   \n\npara two";
    expect(smartUnwrapSelection(sel, COLS)).toBe("para one\n\npara two");
  });

  it("handles CRLF input", () => {
    const line1 = "⏺ This is a response from claude that";
    const line2 = "  continuation of the same sentence.";
    expect(smartUnwrapSelection(`${line1}\r\n${line2}`, COLS)).toBe(
      "⏺ This is a response from claude that continuation of the same sentence.",
    );
  });

  it("returns single lines trimmed", () => {
    expect(smartUnwrapSelection("just one line   ", COLS)).toBe("just one line");
  });
});

describe("joinHardWrappedUrl", () => {
  const COLS = 40;

  it("joins a URL cut flush at the right edge across two rows", () => {
    const row0 = "see https://github.com/anthropics/cbaa"; // 39 cols, url to edge
    const row1 = "de-code/issues/48037 for details";
    const res = joinHardWrappedUrl([row0, row1], COLS);
    expect(res?.url).toBe("https://github.com/anthropics/cbaade-code/issues/48037");
    expect(res?.rowSpan).toBe(2);
  });

  it("joins an indented continuation when the wrap invariant holds", () => {
    const row0 = "⏺ Docs: https://example.com/some/very/l"; // 40 cols flush
    const row1 = "  ong/path?query=1&other=2";
    const res = joinHardWrappedUrl([row0, row1], COLS);
    expect(res?.url).toBe("https://example.com/some/very/long/path?query=1&other=2");
  });

  it("does NOT extend when the next row is prose (invariant fails)", () => {
    const row0 = "see https://example.com/page";
    const row1 = "and then run the command";
    const res = joinHardWrappedUrl([row0, row1], COLS);
    expect(res?.url).toBe("https://example.com/page");
    expect(res?.rowSpan).toBe(1);
  });

  it("strips trailing punctuation from the final URL", () => {
    const res = joinHardWrappedUrl(["read https://example.com/docs)."], COLS);
    expect(res?.url).toBe("https://example.com/docs");
  });

  it("returns null when no URL present", () => {
    expect(joinHardWrappedUrl(["no links here"], COLS)).toBeNull();
  });

  it("caps extension at 4 continuation rows", () => {
    const rows = [
      "x https://e.co/" + "a".repeat(COLS - 16), // fills to edge
      "b".repeat(COLS),
      "c".repeat(COLS),
      "d".repeat(COLS),
      "e".repeat(COLS),
      "f".repeat(COLS),
    ];
    const res = joinHardWrappedUrl(rows, COLS);
    expect(res?.rowSpan).toBeLessThanOrEqual(5); // origin + max 4
  });
});
