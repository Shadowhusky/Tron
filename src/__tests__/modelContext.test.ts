import { describe, it, expect } from "vitest";
import {
  DEFAULT_CONTEXT_CHARS,
  canIncludeFullConversation,
  contextCharsFor,
  conversationBudgetChars,
  inferContextTokens,
} from "../utils/modelContext";

describe("inferContextTokens", () => {
  it("recognises the big cloud models", () => {
    expect(inferContextTokens("claude-opus-5")).toBe(200_000);
    expect(inferContextTokens("gpt-5")).toBe(128_000);
    expect(inferContextTokens("gemini-2.5-pro")).toBe(1_000_000);
  });

  it("recognises models people actually run locally", () => {
    expect(inferContextTokens("qwen/qwen3.8-27b")).toBe(32_768);
    expect(inferContextTokens("llama3.1:8b")).toBe(128_000);
    expect(inferContextTokens("mistral-nemo")).toBe(32_768);
  });

  it("prefers an explicit size in the model id over the table", () => {
    expect(inferContextTokens("some-model-8k")).toBe(8 * 1024);
    expect(inferContextTokens("qwen2.5-coder:32k")).toBe(32 * 1024);
  });

  it("returns null for anything it doesn't know", () => {
    expect(inferContextTokens("totally-made-up-model")).toBeNull();
    expect(inferContextTokens(undefined)).toBeNull();
    expect(inferContextTokens("")).toBeNull();
  });
});

describe("contextCharsFor", () => {
  it("lets a user-set window win — they may be capping on purpose", () => {
    expect(contextCharsFor("claude-opus-5", 12_000)).toBe(12_000);
  });

  it("gives a big model far more room than the flat 16k default", () => {
    expect(contextCharsFor("claude-opus-5")).toBeGreaterThan(DEFAULT_CONTEXT_CHARS * 10);
  });

  it("keeps the conservative default for unknown models", () => {
    expect(contextCharsFor("mystery-model")).toBe(DEFAULT_CONTEXT_CHARS);
    expect(contextCharsFor(undefined)).toBe(DEFAULT_CONTEXT_CHARS);
  });

  it("does not shrink a small local model beyond its real window", () => {
    // qwen3 ≈ 32k tokens; must stay well above the old flat default.
    expect(contextCharsFor("qwen/qwen3.8-27b")).toBeGreaterThan(DEFAULT_CONTEXT_CHARS);
  });
});

describe("conversationBudgetChars", () => {
  it("gives the conversation a slice, never the whole window", () => {
    const total = 100_000;
    expect(conversationBudgetChars(total)).toBeLessThan(total / 2);
  });

  it("still allows something usable on a tiny window", () => {
    expect(conversationBudgetChars(4_000)).toBeGreaterThanOrEqual(1_200);
  });

  it("caps a million-token model so it can't paste an entire day of chat", () => {
    expect(conversationBudgetChars(3_500_000)).toBeLessThanOrEqual(60_000);
  });

  it("scales with the model — a big model carries more conversation", () => {
    expect(conversationBudgetChars(contextCharsFor("claude-opus-5")))
      .toBeGreaterThan(conversationBudgetChars(DEFAULT_CONTEXT_CHARS));
  });
});

describe("canIncludeFullConversation", () => {
  it("is true for a normal chat on a large model, false on a tiny one", () => {
    const chat = 20_000;
    expect(canIncludeFullConversation(chat, contextCharsFor("claude-opus-5"))).toBe(true);
    expect(canIncludeFullConversation(chat, DEFAULT_CONTEXT_CHARS)).toBe(false);
  });
});
