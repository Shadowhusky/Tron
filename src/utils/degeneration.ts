/**
 * Detects a model that has fallen into repetition instead of answering.
 *
 * Small local models sometimes lock into a short cycle and emit it forever —
 * observed live as:
 *
 *   "     :     "}Now:{"     ,     "}EMIT:{"     :     "}JSON:{"     ,     "}Emit:{"  …
 *
 * The agent request sets no `max_tokens`, so such a run generates until the
 * model's own limit. At local-inference speeds that is minutes of streaming
 * garbage, followed by five silent parse retries that each do the same thing —
 * which is what "the agent is stuck" actually looked like.
 *
 * A token cap bounds the damage; this bounds the *latency*, by letting the
 * stream be cancelled as soon as the loop is unmistakable.
 *
 * Tuned to be conservative. A false positive truncates a legitimate answer, so
 * the bar is deliberately high: a lot of text, a cycle repeated many times
 * back-to-back, and very low character diversity. Ordinary repetitive file
 * content (CSV rows, import blocks, ASCII rules) must NOT trip it.
 */

/** Don't judge anything shorter than this — short outputs are never the problem. */
const MIN_LENGTH = 600;
/** How much of the tail to examine. */
const TAIL_CHARS = 1500;
/** Longest repeating unit we look for. */
const MAX_CYCLE = 160;
/** Consecutive back-to-back repeats of one cycle before we call it degenerate. */
const MIN_REPEATS = 6;

/** Collapse whitespace runs so a whitespace-padded loop still reads as a cycle. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * True when the tail is one short unit repeated back-to-back many times.
 * This is the signal that actually fires on real degeneration.
 */
function hasRepeatingCycle(tail: string): boolean {
  for (let unit = 2; unit <= Math.min(MAX_CYCLE, Math.floor(tail.length / MIN_REPEATS)); unit++) {
    const probe = tail.slice(-unit);
    if (!probe.trim()) continue;
    let repeats = 0;
    let i = tail.length - unit;
    while (i >= 0 && tail.startsWith(probe, i)) {
      repeats++;
      i -= unit;
    }
    if (repeats >= MIN_REPEATS) return true;
  }
  return false;
}

/**
 * Fraction of distinct n-grams in the tail. Genuine prose or code stays high;
 * a locked cycle collapses towards zero.
 */
export function shingleDiversity(tail: string, n = 12): number {
  if (tail.length <= n) return 1;
  const seen = new Set<string>();
  const total = tail.length - n;
  for (let i = 0; i < total; i++) seen.add(tail.slice(i, i + n));
  return seen.size / total;
}

export function looksDegenerate(text: string): boolean {
  if (!text || text.length < MIN_LENGTH) return false;
  const tail = normalize(text.slice(-TAIL_CHARS));
  if (tail.length < MIN_LENGTH / 2) return false;
  // Both signals must agree: an exact repeating cycle AND almost no variety.
  // Requiring both is what keeps legitimate repetitive file content safe.
  return hasRepeatingCycle(tail) && shingleDiversity(tail) < 0.25;
}
