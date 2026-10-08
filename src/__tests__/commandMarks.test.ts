import { describe, it, expect } from "vitest";
import { nextCommandLine } from "../utils/commandMarks";

describe("nextCommandLine", () => {
  const lines = [3, 40, 90, 150];

  it("jumps to the closest command above the viewport top", () => {
    expect(nextCommandLine(lines, 90, -1)).toBe(40);
    expect(nextCommandLine(lines, 100, -1)).toBe(90);
  });

  it("jumps to the closest command below the viewport top", () => {
    expect(nextCommandLine(lines, 40, 1)).toBe(90);
    expect(nextCommandLine(lines, 0, 1)).toBe(3);
  });

  it("returns null past either end", () => {
    expect(nextCommandLine(lines, 3, -1)).toBeNull();
    expect(nextCommandLine(lines, 150, 1)).toBeNull();
    expect(nextCommandLine([], 10, -1)).toBeNull();
  });

  it("ignores unsorted input and disposed markers (line -1)", () => {
    expect(nextCommandLine([90, -1, 3, 40], 90, -1)).toBe(40);
  });
});
