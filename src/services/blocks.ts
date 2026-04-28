/**
 * Per-session shell-block store. Each Block represents one command + its
 * captured output, bracketed by OSC 1337 markers emitted by the
 * Tron-injected zsh integration (see electron/ipc/shellIntegration.ts).
 *
 * Block data is the structured replacement for our current
 * "regex-strip-ANSI scrollback" approach to feeding the agent context —
 * it gives the LLM clean cmd/exitCode/output triples instead of raw
 * terminal soup.
 *
 * The store is a thin singleton (no React context) so the xterm OSC
 * handler in Terminal.tsx, the agent loop in services/ai/index.ts, and
 * any future sidebar UI can all observe the same data without prop
 * drilling. State is in-memory only; blocks are evicted on PTY close.
 */

export interface Block {
  /** Stable ID composed of (PTY pid, sequence). Unique within a session. */
  id: string;
  /** The command line as exec'd by the shell. */
  command: string;
  /** Captured stdout/stderr — raw bytes from the PTY between markers. */
  output: string;
  /** Exit code reported by the precmd hook. -1 if the block is still open. */
  exitCode: number;
  /** Working directory at command-end (from PWD in the precmd hook). */
  cwd: string;
  /** ms-precision wall-clock start time (Date.now() when preexec fired). */
  startedAt: number;
  /** ms-precision finish time. 0 if still running. */
  finishedAt: number;
  /** True until the BlockEnd marker arrives. */
  open: boolean;
}

type Listener = (sessionId: string, blocks: Block[]) => void;

const sessionBlocks = new Map<string, Block[]>();
/** The currently-open block per session — output appended here until end. */
const openBlock = new Map<string, Block>();
const listeners = new Set<Listener>();

/** Cap to keep memory bounded on long-running terminals. ~500 commands is
 *  enough scrollback for context; older blocks fall off the front. */
const MAX_BLOCKS_PER_SESSION = 500;
/** Per-block output cap. The agent rarely needs more than this; long
 *  outputs get a `[truncated]` suffix. Matches the strip-ANSI cleanup
 *  budget we already use for scrollback. */
const MAX_OUTPUT_BYTES = 64 * 1024;

function notify(sessionId: string) {
  const blocks = sessionBlocks.get(sessionId) || [];
  for (const l of listeners) l(sessionId, blocks);
}

export function startBlock(
  sessionId: string,
  blockId: string,
  command: string,
): Block {
  // Close any block that was orphaned (e.g. shell exec'd without a precmd
  // running, or a previous BlockStart had no matching End).
  const prev = openBlock.get(sessionId);
  if (prev && prev.open) {
    prev.open = false;
    prev.finishedAt = Date.now();
  }
  const block: Block = {
    id: blockId,
    command,
    output: "",
    exitCode: -1,
    cwd: "",
    startedAt: Date.now(),
    finishedAt: 0,
    open: true,
  };
  const list = sessionBlocks.get(sessionId) || [];
  list.push(block);
  while (list.length > MAX_BLOCKS_PER_SESSION) list.shift();
  sessionBlocks.set(sessionId, list);
  openBlock.set(sessionId, block);
  notify(sessionId);
  return block;
}

export function appendBlockOutput(sessionId: string, chunk: string): void {
  const block = openBlock.get(sessionId);
  if (!block || !block.open) return;
  if (block.output.length >= MAX_OUTPUT_BYTES) return;
  const remaining = MAX_OUTPUT_BYTES - block.output.length;
  if (chunk.length > remaining) {
    block.output += chunk.slice(0, remaining) + "\n[truncated]";
  } else {
    block.output += chunk;
  }
}

export function endBlock(
  sessionId: string,
  blockId: string,
  exitCode: number,
  cwd: string,
): Block | null {
  const block = openBlock.get(sessionId);
  if (!block || block.id !== blockId) return null;
  block.open = false;
  block.exitCode = exitCode;
  block.cwd = cwd;
  block.finishedAt = Date.now();
  openBlock.delete(sessionId);
  notify(sessionId);
  return block;
}

export function getBlocks(sessionId: string): Block[] {
  return sessionBlocks.get(sessionId) || [];
}

/** Most-recent N completed blocks, newest last. Used by the agent when
 *  building context — open blocks are excluded since their output is
 *  partial. */
export function getRecentCompletedBlocks(sessionId: string, n: number): Block[] {
  const all = sessionBlocks.get(sessionId) || [];
  const completed = all.filter((b) => !b.open);
  return completed.slice(-n);
}

export function clearBlocks(sessionId: string): void {
  sessionBlocks.delete(sessionId);
  openBlock.delete(sessionId);
  notify(sessionId);
}

export function subscribeBlocks(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
