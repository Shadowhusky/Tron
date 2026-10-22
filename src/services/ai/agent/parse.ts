/**
 * Tool-call parsing and coercion — the recovery stack that turns whatever a
 * model actually emitted into a `{tool, ...args}` action.
 *
 * Extracted verbatim from the agent loop, where it was redefined on every
 * iteration inside a 3,000-line closure. Everything here is PURE: no IO, no
 * event emission, no run state. That is what makes it testable, and the
 * local-model recovery paths (bare arguments, XML tool calls, bracket calls,
 * markdown fences, `\xHH` escapes) are the parts most worth testing.
 */

import {
  parseBracketToolCall,
  inferToolFromShape,
  parseXmlToolCall,
  looksLikeToolCallText,
} from "../../../utils/agentLoop";
import { AGENT_TOOL_NAMES } from "../toolSchemas";

export type Action = Record<string, any>;

const TOOL_NAMES = new Set(AGENT_TOOL_NAMES);
const isKnownTool = (n: string): boolean => TOOL_NAMES.has(n);

/** Tools whose single string argument is a command, not free content. */
const COMMAND_TOOLS = new Set(["execute_command", "run_in_terminal"]);

/** Non-standard answer keys small models reach for instead of `content`. */
const ANSWER_KEYS = ["answer", "response", "text", "message", "result", "reply", "output"];

const QUESTION_RE = /^(please clarify|what|how|can you|could you|would you)\b/i;

/** Convert `\xHH` escapes (invalid JSON) to `\u00HH` (valid JSON). */
export function fixJsonEscapes(raw: string): string {
  return raw.replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1");
}

/** Escape bare newlines/tabs inside JSON string values, not structural whitespace. */
export function escapeNewlinesInStrings(text: string): string {
  let result = "";
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (esc) { result += ch; esc = false; continue; }
    if (ch === "\\") { result += ch; esc = true; continue; }
    if (ch === '"') { inStr = !inStr; result += ch; continue; }
    if (inStr) {
      if (ch === "\n") { result += "\\n"; continue; }
      if (ch === "\r") { result += "\\r"; continue; }
      if (ch === "\t") { result += "\\t"; continue; }
    }
    result += ch;
  }
  return result;
}

/**
 * Normalize the many near-miss shapes models emit into `{tool, ...args}`:
 * an array wrapper, a tool name used as the top-level key, gpt-oss's
 * `{"cmd":["bash","-lc",...]}`, or bare arguments with no tool name at all.
 */
export function normalizeToolKey(obj: any): any {
  if (Array.isArray(obj)) {
    if (obj.length > 0 && typeof obj[0] === "object") return normalizeToolKey(obj[0]);
    return obj;
  }
  if (!obj || typeof obj !== "object" || obj.tool) return obj;

  const keys = Object.keys(obj);
  const toolKey = keys.find((k) => TOOL_NAMES.has(k));
  if (toolKey) {
    const val = obj[toolKey];
    const rest = { ...obj };
    delete rest[toolKey];
    if (typeof val === "string") {
      const prop = COMMAND_TOOLS.has(toolKey) ? "command" : "content";
      return { tool: toolKey, [prop]: val, ...rest };
    }
    if (typeof val === "object" && val !== null) {
      return { tool: toolKey, ...val, ...rest };
    }
    return obj;
  }

  if (obj.cmd) {
    const command = Array.isArray(obj.cmd)
      ? obj.cmd[obj.cmd.length - 1]
      : typeof obj.cmd === "string"
        ? obj.cmd
        : null;
    if (typeof command === "string") return { tool: "execute_command", command };
  }

  const inferred = inferToolFromShape(obj);
  if (inferred) return inferred;
  return obj;
}

/** Scan `text` for balanced `{}` objects, returning each candidate substring. */
function* balancedObjects(text: string): Generator<string> {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const openIdx = text.indexOf("{", searchFrom);
    if (openIdx === -1) return;

    let balance = 0;
    let inStr = false;
    let esc = false;
    let endIdx = -1;

    for (let i = openIdx; i < text.length; i++) {
      const char = text[i];
      if (esc) { esc = false; continue; }
      if (char === "\\") { esc = true; continue; }
      if (char === '"') { inStr = !inStr; continue; }
      if (!inStr) {
        if (char === "{") balance++;
        else if (char === "}") {
          balance--;
          if (balance === 0) { endIdx = i; break; }
        }
      }
    }

    if (endIdx === -1) return; // unbalanced — stop
    yield text.slice(openIdx, endIdx + 1);
    searchFrom = endIdx + 1;
  }
}

/**
 * Best-effort extraction of a tool call from raw model text, trying in order:
 * direct parse, newline repair, markdown fence, `<|channel|>` token wrapper,
 * then a balanced-brace scan with trailing-comma repair.
 */
export function tryParseJson(text: string): any {
  if (!text.trim()) return null;

  try {
    return normalizeToolKey(JSON.parse(fixJsonEscapes(text)));
  } catch { /* fall through */ }

  try {
    return normalizeToolKey(JSON.parse(escapeNewlinesInStrings(fixJsonEscapes(text))));
  } catch { /* fall through */ }

  const mdMatch = text.match(/```\w*\s*([\s\S]*?)```/);
  if (mdMatch) {
    try {
      return normalizeToolKey(JSON.parse(fixJsonEscapes(mdMatch[1].trim())));
    } catch { /* fall through */ }
  }

  const lastTokenIdx = text.lastIndexOf("<|");
  if (lastTokenIdx >= 0) {
    const closingIdx = text.indexOf("|>", lastTokenIdx);
    if (closingIdx >= 0) {
      const afterLastToken = text.slice(closingIdx + 2).trim();
      if (afterLastToken.startsWith("{")) {
        try {
          return normalizeToolKey(JSON.parse(fixJsonEscapes(afterLastToken)));
        } catch { /* fall through */ }
      }
    }
  }

  for (const raw of balancedObjects(text)) {
    const candidate = fixJsonEscapes(raw);
    try {
      const obj = normalizeToolKey(JSON.parse(candidate));
      if (obj.tool || obj.content) return obj;
    } catch {
      try {
        const obj = normalizeToolKey(JSON.parse(escapeNewlinesInStrings(candidate)));
        if (obj.tool || obj.content) return obj;
      } catch { /* fall through */ }
      const fixed = candidate.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
      try {
        const obj = normalizeToolKey(JSON.parse(fixed));
        if (obj.tool || obj.content) return obj;
      } catch { /* fall through */ }
    }
  }

  return null;
}

/** Route a bare string to `ask_question` when it reads as a question, else `final_answer`. */
function answerOrQuestion(action: Action, value: string): void {
  if (QUESTION_RE.test(value.trim()) || value.includes("?")) {
    action.tool = "ask_question";
    action.question = value;
  } else {
    action.tool = "final_answer";
    action.content = value;
  }
}

/**
 * Turn a parsed-but-tool-less object, or plain prose, into an action.
 *
 * The critical rule: text that LOOKS like an attempted tool call (XML, JSON,
 * or a bracketed known tool) is never coerced into a final answer — doing so
 * produced bogus "done" runs echoing raw XML (log d3f522fd6d). Such text
 * returns null so the caller retries the parse instead.
 */
export function coerceAction(action: any, responseText: string): any {
  if (!action) {
    const trimmed = (responseText || "").trim();

    const xmlAction = parseXmlToolCall(trimmed, isKnownTool);
    if (xmlAction) return xmlAction;
    const bracketAction = parseBracketToolCall(trimmed, isKnownTool);
    if (bracketAction) return bracketAction;

    if (trimmed && !trimmed.includes("{")) {
      const btool = trimmed.match(/^\[\s*(\w+)/);
      const looksLikeBracketToolCall = !!(btool && TOOL_NAMES.has(btool[1]));
      if (looksLikeBracketToolCall || looksLikeToolCallText(trimmed)) return null;

      const coerced: Action = {};
      if (QUESTION_RE.test(trimmed) || trimmed.includes("?")) {
        coerced.tool = "ask_question";
        coerced.question = trimmed;
      } else if (trimmed.length < 500) {
        coerced.tool = "final_answer";
        coerced.content = trimmed;
      } else {
        return null; // too long — let it fail
      }
      return coerced;
    }
    return action;
  }

  if (typeof action.command === "string") {
    action.tool = "execute_command";
  } else if (typeof action.question === "string") {
    action.tool = "ask_question";
  } else if (typeof action.error === "string") {
    if (/\b(clarify|understand|help with|what|how|please)\b/i.test(action.error) || action.error.includes("?")) {
      action.tool = "ask_question";
      action.question = action.error;
    } else {
      action.tool = "final_answer";
      action.content = action.error;
    }
  } else if (typeof action.content === "string") {
    // Preserves the original asymmetry: `content` is already in place, so the
    // final_answer branch must not overwrite it.
    if (QUESTION_RE.test(action.content.trim()) || action.content.includes("?")) {
      action.tool = "ask_question";
      action.question = action.content;
    } else {
      action.tool = "final_answer";
    }
  } else {
    const answerKey = ANSWER_KEYS.find((k) => typeof action[k] === "string");
    if (answerKey) answerOrQuestion(action, action[answerKey] as string);
  }
  return action;
}

/**
 * Full pipeline: parse the response, fall back to reasoning text, then coerce.
 * Returns an action (which may carry `_plan` instead of `tool`), or null when
 * nothing usable could be recovered and the caller should retry.
 */
export function parseAction(responseText: string, thinkingText?: string): any {
  let action = tryParseJson(responseText);
  if (!action?.tool && !action?._plan && thinkingText) {
    action = tryParseJson(thinkingText);
  }
  if (action && action._plan) return action;
  if (!action || !action.tool) return coerceAction(action, responseText);
  return action;
}
