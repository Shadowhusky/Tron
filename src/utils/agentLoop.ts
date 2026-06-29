/**
 * Pure helpers for the agent loop's repetition / progress heuristics.
 *
 * Background: the windowed loop detector + LLM arbiter catch exact and
 * near-exact repeats, but a "hard question" the agent can't answer produces
 * *death by a thousand variations* — many semantically-identical probes with
 * slightly different text (e.g. the same `docker exec … cat config | python3
 * -c "<different one-liner>"` run 50 times). Each looks distinct enough that
 * the arbiter keeps allowing it, and the 12-entry window gets cleared/softened
 * between checks, so nothing converges before `maxSteps`.
 *
 * The cumulative cap below is an arbiter-independent backstop: it counts how
 * many times a given coarse action shape has run across the WHOLE task and
 * forces a break once that crosses a hard ceiling — no LLM judgement, no
 * window to clear. Kept pure so it's unit-tested.
 */

/** Tools that legitimately repeat the same coarse shape and must NOT be capped:
 *  read_terminal (polling a long build), send_text (menu navigation / keystrokes). */
const UNCAPPED_TOOLS = new Set(["read_terminal", "send_text"]);

/**
 * Minimum trimmed character count for a web_fetch result to count as usable
 * text. Pages below this are almost always JS-rendered shells or anti-scrape
 * stubs (observed in 88ab9361f7.json: moomoo/futunn/cfi returned 0–27 chars and
 * the agent re-fetched them forever). Kept low so legitimate terse quote/price
 * pages (~40–60 chars of real text) are NOT misflagged as dead. A genuine
 * network failure surfaces via the fetch error path, not as short content, so
 * this only catches stable "200 OK but no readable text" responses.
 */
export const MIN_USEFUL_FETCH_CHARS = 40;

/** True when a web_fetch result has too little text to be useful — a dead
 *  anti-scrape / JS-only page that won't yield more on re-fetch. Pure, unit-tested. */
export function isUselessFetchResult(content: string | null | undefined): boolean {
  return (content ?? "").trim().length < MIN_USEFUL_FETCH_CHARS;
}

/**
 * Hard ceiling on how many times one coarse action shape may run across a task
 * before it's treated as an exhausted, looping approach. Returns Infinity for
 * tools that legitimately repeat. 12 is well above normal iterative work
 * (re-running tests, editing a few files) but far below the 50× pathological
 * loops seen in logs.
 */
export function cumulativeRepetitionCap(tool: string): number {
  if (UNCAPPED_TOOLS.has(tool)) return Infinity;
  return 12;
}

/** True when a coarse action shape has repeated to/past its cumulative cap. */
export function isHardRepetitionLoop(coarseTotal: number, tool: string): boolean {
  return coarseTotal >= cumulativeRepetitionCap(tool);
}

/** True the FIRST time the cap is crossed (so we bump the loop counter once). */
export function isFirstCapCross(coarseTotal: number, tool: string): boolean {
  return coarseTotal === cumulativeRepetitionCap(tool);
}

/**
 * Whether an action represents genuine forward progress for stagnation
 * tracking. Producing command output is NOT progress — a stuck agent produces
 * output every step. Progress = exploring a NOVEL action shape (first time this
 * coarse key has been seen). `coarseTotal` is the cumulative count INCLUDING
 * the current occurrence, so 1 means "never seen before".
 */
export function isNovelAction(coarseTotal: number): boolean {
  return coarseTotal === 1;
}

/**
 * Parse a bracket-style tool call that non-JSON models sometimes emit, in any
 * of its shapes:
 *   [read_terminal]            [read_terminal(lines=50)]
 *   [execute_command ls -la]   [execute_command(ls -la)]   [execute_command] ls
 * Returns a partial action object, or null if the leading bracket token isn't a
 * known tool (so the caller can fall back). Crucially this must catch
 * `[read_terminal(lines=50)]` — otherwise it falls through and becomes a bogus
 * "done" final_answer (observed bug). Pure, so it's unit-tested.
 */
export function parseBracketToolCall(
  trimmed: string,
  isKnownTool: (name: string) => boolean,
): Record<string, unknown> | null {
  const m = trimmed.match(/^\[\s*(\w+)([^\]]*)\]?([\s\S]*)$/);
  if (!m || !isKnownTool(m[1])) return null;
  const toolName = m[1];
  let inner = (m[2] || "").trim();
  const trailing = m[3] || "";
  // Unwrap a parenthesised inner section: "(lines=50)" → "lines=50"
  const paren = inner.match(/^\(([\s\S]*)\)$/);
  if (paren) inner = paren[1].trim();
  // The argument is the inner section, else the trailing text after the bracket.
  let arg = inner || trailing;
  // Cut off at a newline that starts a new tool / JSON / bracket call.
  const nlIdx = arg.search(/\r?\n\s*(?:\[\w+|\{|\["?tool"?)/);
  if (nlIdx >= 0) arg = arg.slice(0, nlIdx);
  // Strip trailing JSON closing fragments / stray punctuation.
  arg = arg.replace(/\s*(?:["'`]?\s*[\]}]+\s*[,;]?\s*)+$/, "");
  // Strip a lone trailing single/double quote with no opening match.
  const dq = (arg.match(/"/g) || []).length;
  const sq = (arg.match(/'/g) || []).length;
  if (dq % 2 === 1 && arg.endsWith('"')) arg = arg.slice(0, -1);
  if (sq % 2 === 1 && arg.endsWith("'")) arg = arg.slice(0, -1);
  arg = arg.trim();

  const action: Record<string, unknown> = { tool: toolName };
  if (toolName === "execute_command" || toolName === "run_in_terminal") {
    action.command = arg || "echo 'no command provided'";
  } else if (toolName === "read_terminal") {
    const n = arg.match(/(\d{1,4})/); // "lines=50" → 50
    action.lines = n ? parseInt(n[1], 10) : 50;
  } else if (toolName === "final_answer") {
    action.content = arg || "Done.";
  } else if (toolName === "ask_question") {
    action.question = arg || "Could you clarify?";
  } else if (arg) {
    action.content = arg;
  }
  return action;
}
