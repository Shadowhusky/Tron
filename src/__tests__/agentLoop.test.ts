import { describe, it, expect } from "vitest";
import {
  cumulativeRepetitionCap,
  isHardRepetitionLoop,
  isFirstCapCross,
  isNovelAction,
} from "../utils/agentLoop";

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
