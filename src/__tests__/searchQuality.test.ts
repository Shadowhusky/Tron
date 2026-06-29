import { describe, it, expect } from "vitest";
import {
  queryTerms,
  isRedundantQuery,
  scoreResultRelevance,
  searchQualityHint,
} from "../utils/searchQuality";

describe("queryTerms", () => {
  it("lowercases, strips punctuation/stopwords, and de-dupes", () => {
    expect(queryTerms("How do I fix the CRP Robot IPO price?")).toEqual([
      "fix", "crp", "robot", "ipo", "price",
    ]);
  });
  it("returns [] for empty / stopword-only queries", () => {
    expect(queryTerms("")).toEqual([]);
    expect(queryTerms("what is the of a")).toEqual([]);
  });
});

describe("isRedundantQuery", () => {
  const recent = ["CRP Robot IPO offer price HKEX"];
  it("flags a reordered/near-identical query", () => {
    expect(isRedundantQuery("HKEX CRP Robot IPO price offer", recent)).toBe(true);
  });
  it("does NOT flag a genuinely different query", () => {
    expect(isRedundantQuery("HeChuan 688320 dividend history", recent)).toBe(false);
  });
  it("never flags against an empty history", () => {
    expect(isRedundantQuery("anything here", [])).toBe(false);
  });
});

describe("scoreResultRelevance", () => {
  const results = [
    { title: "CRP Robot Technology IPO", snippet: "HKEX offer price for CRP robot" },
  ];
  it("is high when query terms appear in results", () => {
    expect(scoreResultRelevance("CRP robot IPO price", results)).toBeGreaterThanOrEqual(0.75);
  });
  it("is low when results are off-topic", () => {
    const junk = [{ title: "Stock Options - HKEX", snippet: "list of option classes" }];
    expect(scoreResultRelevance("CRP robot embodied intelligence revenue", junk)).toBeLessThan(0.34);
  });
  it("is 0 for no results, 1 for a stopword-only query", () => {
    expect(scoreResultRelevance("crp robot", [])).toBe(0);
    expect(scoreResultRelevance("what is the", results)).toBe(1);
  });
});

describe("searchQualityHint", () => {
  it("warns about a redundant query before checking relevance", () => {
    const hint = searchQualityHint("CRP robot IPO price", [], ["IPO price CRP robot"]);
    expect(hint).toMatch(/nearly identical/i);
  });
  it("warns about off-topic results", () => {
    const junk = [{ title: "Stock Options - HKEX", snippet: "option classes" }];
    const hint = searchQualityHint("CRP robot embodied revenue 2025", junk, []);
    expect(hint).toMatch(/off-topic/i);
  });
  it("returns null for a healthy, novel search", () => {
    const good = [{ title: "CRP Robot IPO", snippet: "CRP robot embodied revenue 2025" }];
    expect(searchQualityHint("CRP robot embodied revenue 2025", good, [])).toBeNull();
  });
  it("returns null for an empty query", () => {
    expect(searchQualityHint("", [], [])).toBeNull();
  });
});
