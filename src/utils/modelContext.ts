/**
 * How much room a model actually has, and how much of it the conversation may
 * claim.
 *
 * `AIConfig.contextWindow` is a single manual number in CHARACTERS defaulting
 * to 16,000 (~4k tokens) — fine for a small local model, but absurdly
 * pessimistic for a 200k-token cloud model. Because every budget in the app
 * derived from that one number, a long conversation was clipped just as hard
 * on Claude as on a 7B local model. That is why an earlier task could reach the
 * agent as "Create a tui (terminal ui) program that shows the allocation of
 * current machine'…" and a follow-up of "continue" had nothing to continue
 * from (log ddb57d1bbd).
 *
 * The configured value still wins when the user sets one — this only supplies
 * a better default for models we recognise.
 */

/** Characters per token, averaged over English prose + code. Deliberately
 *  conservative: over-estimating tokens is what overflows a local model. */
const CHARS_PER_TOKEN = 3.5;

/** Context window in TOKENS for model families we recognise. First match wins,
 *  so put more specific patterns first. */
const KNOWN_CONTEXT_TOKENS: Array<[RegExp, number]> = [
  // Anthropic
  [/claude.*(opus|sonnet)[-_ ]?5/i, 200_000],
  [/claude|anthropic/i, 200_000],
  // OpenAI
  [/^o[1-9]|gpt-5|gpt-4\.1/i, 128_000],
  [/gpt-4o|gpt-4/i, 128_000],
  // Google
  [/gemini.*(1\.5|2|3)/i, 1_000_000],
  [/gemini/i, 128_000],
  // DeepSeek
  [/deepseek/i, 64_000],
  // Open-weight families commonly run locally
  [/qwen ?3|qwen3/i, 32_768],
  [/qwen/i, 32_768],
  [/llama[-_ ]?3\.[1-9]|llama[-_ ]?4/i, 128_000],
  [/llama/i, 8_192],
  [/mistral|mixtral/i, 32_768],
  [/gemma/i, 8_192],
  [/phi/i, 16_384],
  [/kimi|moonshot/i, 128_000],
  [/glm/i, 128_000],
  [/minimax/i, 200_000],
];

/** Best guess at a model's context window in tokens, or null if unrecognised. */
export function inferContextTokens(model: string | undefined): number | null {
  if (!model) return null;
  // An explicit size in the model id beats any table: "…-32k", "…-128k".
  const explicit = model.match(/[-_:@](\d{1,4})k\b/i);
  if (explicit) {
    const k = parseInt(explicit[1], 10);
    if (k > 0 && k <= 10_000) return k * 1024;
  }
  for (const [re, tokens] of KNOWN_CONTEXT_TOKENS) {
    if (re.test(model)) return tokens;
  }
  return null;
}

/** Default characters of context for a model, before any user override. */
export const DEFAULT_CONTEXT_CHARS = 16_000;

export function contextCharsFor(
  model: string | undefined,
  configured?: number,
): number {
  // A user-set value is authoritative — they may be capping a big model on
  // purpose, or know their local server's real limit.
  if (configured && configured > 0) return configured;
  const tokens = inferContextTokens(model);
  if (!tokens) return DEFAULT_CONTEXT_CHARS;
  return Math.round(tokens * CHARS_PER_TOKEN);
}

/**
 * Characters of the total budget the prior conversation may occupy.
 *
 * The conversation competes with terminal scrollback, the agent thread and the
 * system prompt, so it gets a slice rather than the lot — and a hard ceiling so
 * a million-token model doesn't paste an entire day's chat into every call.
 */
export function conversationBudgetChars(totalChars: number): number {
  const share = Math.round(totalChars * 0.25);
  return Math.max(1_200, Math.min(share, 60_000));
}

/** True when there is room to include prior turns verbatim rather than clipped. */
export function canIncludeFullConversation(
  conversationChars: number,
  totalChars: number,
): boolean {
  return conversationChars <= conversationBudgetChars(totalChars);
}
