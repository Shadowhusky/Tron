import { describe, it, expect } from "vitest";
import { fuzzyScore, fuzzyFilter } from "../utils/fuzzy";

describe("fuzzyScore", () => {
  it("matches subsequences case-insensitively", () => {
    expect(fuzzyScore("spl", "Split Horizontal")).not.toBeNull();
    expect(fuzzyScore("SH", "Split Horizontal")).not.toBeNull();
  });
  it("returns null for non-subsequences", () => {
    expect(fuzzyScore("xyz", "Split Horizontal")).toBeNull();
  });
  it("empty query matches everything with zero score", () => {
    expect(fuzzyScore("", "anything")).toBe(0);
  });
  it("scores word-boundary and consecutive matches higher", () => {
    const acronym = fuzzyScore("sh", "Split Horizontal")!;
    const buried = fuzzyScore("sh", "wash house")!;
    expect(acronym).toBeGreaterThan(buried);
  });
  it("ignores spaces in the query", () => {
    expect(fuzzyScore("split h", "Split Horizontal")).not.toBeNull();
  });
});

describe("fuzzyFilter", () => {
  const items = ["New Tab", "Split Horizontal", "Split Vertical", "Open Settings", "Theme: Dark"];
  it("returns all items for an empty query", () => {
    expect(fuzzyFilter("", items, (s) => s)).toEqual(items);
  });
  it("filters and ranks by score", () => {
    const out = fuzzyFilter("split", items, (s) => s);
    expect(out[0]).toMatch(/^Split/);
    expect(out).toHaveLength(2);
  });
  it("drops non-matches entirely", () => {
    expect(fuzzyFilter("zzz", items, (s) => s)).toHaveLength(0);
  });
  it("ranks history-style commands sensibly", () => {
    const hist = ["git status", "git push origin main", "npm run build", "grep -r foo ."];
    const out = fuzzyFilter("gp", hist, (s) => s);
    expect(out[0]).toBe("git push origin main");
  });
});
