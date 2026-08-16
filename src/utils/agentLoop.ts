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

/**
 * Infer the tool from bare ARGUMENT JSON that carries no tool name at all.
 *
 * Tool-trained models (observed: qwen3.8-27b on LM Studio, log/live 2026-08-15)
 * leak their native function-calling format into plain text: instead of
 * {"tool":"todo_write","todos":[...]} they emit just {"todos":[...]} (sometimes
 * inside <tool_call> XML). Without inference the parser either fails outright
 * (5 silent retries, each 30–80s on a local model) or — worse — coerces a todo
 * ITEM ({"content":"...","status":"in_progress"}) into a bogus final_answer
 * that the completion guards then reject forever.
 *
 * Only unambiguous key signatures are mapped, most-specific first; anything
 * ambiguous returns null so the caller's existing coercion/retry paths run.
 * Pure, unit-tested.
 */
export function inferToolFromShape(
  obj: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (typeof obj.tool === "string" || "_plan" in obj) return null;
  const has = (k: string) => typeof obj[k] === "string" && (obj[k] as string).length > 0;

  if (
    Array.isArray(obj.todos) &&
    obj.todos.length > 0 &&
    obj.todos.every((t) => t && typeof t === "object" && typeof (t as { content?: unknown }).content === "string")
  ) {
    return { tool: "todo_write", ...obj };
  }
  // A single todo item — only when status is one of the protocol's enum values
  // (a final answer never carries status:"in_progress").
  if (has("content") && ["pending", "in_progress", "completed"].includes(obj.status as string)) {
    return { tool: "todo_write", todos: [{ content: obj.content, status: obj.status }] };
  }
  if (has("path") && has("search") && typeof obj.replace === "string") {
    return { tool: "edit_file", ...obj };
  }
  if (has("path") && typeof obj.content === "string") {
    return { tool: "write_file", ...obj };
  }
  if (has("path") && has("query")) return { tool: "search_dir", ...obj };
  if (has("url")) return { tool: "web_fetch", ...obj };
  if (has("query")) return { tool: "web_search", ...obj };
  if (has("command")) return { tool: "execute_command", ...obj };
  if (has("question")) return { tool: "ask_question", ...obj };
  if (has("text") && has("description")) return { tool: "send_text", ...obj };
  if (typeof obj.lines === "number" && Object.keys(obj).length === 1) {
    return { tool: "read_terminal", ...obj };
  }
  return null;
}

/**
 * Parse a Hermes/qwen-style XML tool call emitted as plain TEXT:
 *   <tool_call>
 *   <function=search_dir>
 *   <parameter=path>
 *   "/Users/richardliao/Desktop/flux-3d"
 *   </parameter>
 *   <parameter="query>          ← malformed quoting seen live
 *   updateRipples()
 *   </parameter>
 *   </function>
 *   </tool_call>
 * Observed live (log d3f522fd6d): qwen3.8 emitted exactly this on the text
 * path; unparsed, the plain-text coercion turned it into a bogus "done"
 * final_answer containing raw XML. Tolerates missing closers, `name="x"`
 * syntax, and stray quotes around keys/values. Pure, unit-tested.
 */
export function parseXmlToolCall(
  text: string,
  isKnownTool: (name: string) => boolean,
): Record<string, unknown> | null {
  const fnMatch = text.match(/<function(?:\s+name\s*=\s*|[=\s:]+)["']?([\w.-]+)["']?\s*>/i);
  if (!fnMatch || !isKnownTool(fnMatch[1])) return null;
  const action: Record<string, unknown> = { tool: fnMatch[1] };

  const paramRe = /<parameter[=\s:]+["']?([\w.-]+)["']?\s*>/gi;
  const opens: Array<{ key: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = paramRe.exec(text)) !== null) {
    opens.push({ key: m[1], start: m.index + m[0].length });
  }
  for (const { key, start } of opens) {
    // Value runs to the earliest terminator — models drop closing tags freely.
    let end = text.length;
    for (const term of ["</parameter>", "<parameter", "</function>", "</tool_call>"]) {
      const idx = text.indexOf(term, start);
      if (idx >= 0 && idx < end) end = idx;
    }
    let raw = text.slice(start, end).trim();
    // Strip one pair of wrapping quotes: "/some/path" → /some/path
    if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
      raw = raw.slice(1, -1);
    }
    let value: unknown = raw;
    if (/^-?\d+$/.test(raw)) value = parseInt(raw, 10);
    else if (raw === "true" || raw === "false") value = raw === "true";
    action[key] = value;
  }
  return action;
}

/** True when text looks like an ATTEMPTED tool call (XML or JSON style) —
 *  such text must never be coerced into a final_answer. */
export function looksLikeToolCallText(text: string): boolean {
  return /<tool_call|<function[=\s:>]|<\/?parameter[=\s:>]|\{\s*"tool"\s*:/i.test(text);
}
