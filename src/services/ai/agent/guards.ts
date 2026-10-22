/**
 * Repetition detection for the agent loop.
 *
 * Heuristics here only ever flag *suspicion*; an LLM arbiter decides whether
 * the run is genuinely stuck, and the caller owns the consequences (blocking,
 * escalating, terminating). Keeping the detection pure is what makes the
 * fixture-driven tests possible — every one of these fired in a real logged
 * runaway before it was written.
 */

import { isHardRepetitionLoop } from "../../../utils/agentLoop";

export interface RepetitionSignals {
  /** The same exact action, back-to-back, past this tool's tolerance. */
  consecutive: boolean;
  /** An A→B→A→B→A→B ping-pong across the recent window. */
  alternating: boolean;
  /** Many near-identical probes — same coarse shape, reworded arguments. */
  semantic: boolean;
  /** This coarse shape has run to its cumulative cap across the whole task. */
  hardRepetition: boolean;
  /** Any of the above. */
  suspicious: boolean;
}

/**
 * `final_answer` and `ask_question` are exempt from loop detection: blocking a
 * final_answer while instructing the model to "use final_answer" is a deadlock
 * by construction (log fd5977963a).
 */
export function isTerminalTool(tool: string): boolean {
  return tool === "final_answer" || tool === "ask_question";
}

/** Collapse a long payload to a bounded fingerprint so keys stay small. */
export function hashContent(s: string | undefined): string | undefined {
  if (typeof s !== "string" || s.length === 0) return s;
  if (s.length <= 64) return s;
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return `${s.length}#${h}`;
}

/**
 * Exact identity of an action. File edits hash the whole payload, so
 * re-emitting the same search/replace against one path is caught — recording
 * only the path let models edit the same file forever.
 */
export function buildActionKey(action: Record<string, any>): string {
  return JSON.stringify({
    tool: action.tool,
    path: action.path,
    command: action.command,
    text: action.text,
    query: action.query,
    url: action.url,
    search: hashContent(action.search),
    replace: hashContent(action.replace),
    content: hashContent(action.content),
  });
}

/** The leading argument used for coarse grouping and arbiter context. */
export function coarseArgsOf(action: Record<string, any>): string {
  return action.command || action.query || action.path || action.url || "";
}

/**
 * Coarse shape of an action. File edits keep a short payload fingerprint so
 * five genuinely different edits to one file are not mistaken for repetition —
 * only reword-only reattempts collide.
 */
export function buildCoarseKey(action: Record<string, any>): string {
  const isFileEdit = action.tool === "write_file" || action.tool === "edit_file";
  if (isFileEdit) {
    const fingerprint = `:${(action.search || action.content || "").slice(0, 30)}>${(action.replace || "").slice(0, 30)}`;
    return `${action.tool}:${action.path || ""}${fingerprint}`;
  }
  return `${action.tool}:${coarseArgsOf(action).slice(0, 50)}`;
}

/**
 * How many identical calls in a row are tolerated. Menu navigation
 * (`send_text`) and build monitoring (`read_terminal`) legitimately repeat;
 * everything else is suspicious on the second identical call, because
 * re-running the same `sed` or `edit_file` back-to-back is a model glitch.
 */
export function maxConsecutiveFor(tool: string): number {
  return tool === "send_text" || tool === "read_terminal" ? 5 : 2;
}

/** How many coarse matches in the 12-entry window count as semantic repetition. */
export function coarseThresholdFor(tool: string): number {
  return tool === "read_terminal" || tool === "send_text" ? 8 : 5;
}

export function isConsecutiveRepeat(
  recentActions: readonly string[],
  actionKey: string | null | undefined,
  maxConsecutive: number,
): boolean {
  if (actionKey == null || recentActions.length < maxConsecutive) return false;
  for (let i = 1; i <= maxConsecutive; i++) {
    if (recentActions[recentActions.length - i] !== actionKey) return false;
  }
  return true;
}

export function isAlternatingRepeat(recentActions: readonly string[]): boolean {
  const n = recentActions.length;
  if (n < 6) return false;
  return (
    recentActions[n - 1] === recentActions[n - 3] &&
    recentActions[n - 3] === recentActions[n - 5] &&
    recentActions[n - 2] === recentActions[n - 4] &&
    recentActions[n - 4] === recentActions[n - 6]
  );
}

export function isSemanticRepeat(
  recentCoarseKeys: readonly string[],
  coarseKey: string,
  tool: string,
): boolean {
  const matches = recentCoarseKeys.filter((k) => k === coarseKey).length;
  return matches >= coarseThresholdFor(tool);
}

/** Evaluate every repetition heuristic for one action. */
export function detectRepetition(args: {
  action: Record<string, any>;
  actionKey: string | null;
  recentActions: readonly string[];
  recentCoarseKeys: readonly string[];
  coarseKey: string;
  coarseTotal: number;
}): RepetitionSignals {
  const { action, actionKey, recentActions, recentCoarseKeys, coarseKey, coarseTotal } = args;
  const consecutive = isConsecutiveRepeat(recentActions, actionKey, maxConsecutiveFor(action.tool));
  const alternating = isAlternatingRepeat(recentActions);
  const semantic = isSemanticRepeat(recentCoarseKeys, coarseKey, action.tool);
  const hardRepetition = isHardRepetitionLoop(coarseTotal, action.tool);
  return {
    consecutive,
    alternating,
    semantic,
    hardRepetition,
    suspicious: consecutive || alternating || semantic || hardRepetition,
  };
}
