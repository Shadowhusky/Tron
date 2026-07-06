import { describe, it, expect } from "vitest";
import { INPUT_REPORT_RESET, stripInputReportEnables } from "../utils/terminalModes";

describe("INPUT_REPORT_RESET", () => {
  it("disables every mouse-tracking + focus mode", () => {
    for (const m of [9, 1000, 1002, 1003, 1004, 1005, 1006, 1015]) {
      expect(INPUT_REPORT_RESET).toContain(`\x1b[?${m}l`);
    }
  });
  it("only emits disable (l) sequences, never enable (h)", () => {
    expect(INPUT_REPORT_RESET).not.toMatch(/h/);
  });
  it("does NOT touch bracketed-paste or cursor-key modes (shell owns them)", () => {
    expect(INPUT_REPORT_RESET).not.toContain("2004");
    expect(INPUT_REPORT_RESET).not.toContain("?1l");
    expect(INPUT_REPORT_RESET).not.toContain("?1h");
  });
});

describe("stripInputReportEnables", () => {
  it("removes mouse + focus enable sequences from replayed data", () => {
    const data = "hello\x1b[?1003h\x1b[?1006hworld\x1b[?1004htail";
    expect(stripInputReportEnables(data)).toBe("helloworldtail");
  });

  it("strips every tracking + encoding variant", () => {
    for (const m of [9, 1000, 1002, 1003, 1004, 1005, 1006, 1015]) {
      expect(stripInputReportEnables(`x\x1b[?${m}hy`)).toBe("xy");
    }
  });

  it("leaves disable sequences and shell-owned modes intact", () => {
    const data = "\x1b[?1003l\x1b[?2004h\x1b[?1htext";
    expect(stripInputReportEnables(data)).toBe(data);
  });

  it("does not strip lookalike SGR/text (only DEC-private ?NNNh)", () => {
    // e.g. a 256-color SGR or plain digits+h must survive
    const data = "\x1b[38;5;1003mred\x1b[0m 1003h";
    expect(stripInputReportEnables(data)).toBe(data);
  });

  it("handles empty / no-match input", () => {
    expect(stripInputReportEnables("")).toBe("");
    expect(stripInputReportEnables("plain output\n")).toBe("plain output\n");
  });
});
