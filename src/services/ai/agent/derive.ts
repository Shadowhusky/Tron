/**
 * Projections of the session log.
 *
 * `deriveRunState` replaces five of the six mutable locals the agent loop used
 * to thread through its guards. It is a pure fold, so the guard conditions that
 * depend on it are testable without running a model.
 *
 * The sixth, `terminalBusy`, is deliberately NOT here. It is live PTY state —
 * set before an await, cleared in a catch, cleared again when a read shows an
 * idle prompt across 21 sites — not a fold over completed work. Forcing it into
 * a projection would misrepresent it, so the loop still owns it explicitly.
 */

import type { SessionEvent } from "./events";

export interface RunState {
  /** Distinct shell commands that have run — evidence that work happened. */
  executedCommands: Set<string>;
  /** A scaffold command already ran; a second one is blocked. */
  usedScaffold: boolean;
  /** At least one file was written or edited. */
  wroteFiles: boolean;
  /** A web search or fetch returned — counts as work for completion guards. */
  usedWebTools: boolean;
  /** Most recent directory written to, used to resolve relative paths. */
  lastWriteDir: string;
}

export function deriveRunState(events: readonly SessionEvent[]): RunState {
  const state: RunState = {
    executedCommands: new Set<string>(),
    usedScaffold: false,
    wroteFiles: false,
    usedWebTools: false,
    lastWriteDir: "",
  };

  for (const event of events) {
    switch (event.type) {
      case "command/executed":
        state.executedCommands.add(event.command);
        break;
      case "command/scaffold":
        state.usedScaffold = true;
        break;
      case "file/written":
        state.wroteFiles = true;
        // Shallowest wins — this approximates the project root, so writing a
        // nested file must not drag the target deeper. Not last-write-wins.
        if (event.dir && (!state.lastWriteDir || event.dir.length < state.lastWriteDir.length)) {
          state.lastWriteDir = event.dir;
        }
        break;
      case "dir/created":
        // An explicit mkdir is a deliberate choice of target, so it overrides
        // the shallowest-wins heuristic outright.
        state.lastWriteDir = event.dir;
        break;
      case "web/used":
        state.usedWebTools = true;
        break;
      case "guards/scaffold-reset":
        // Last-write-wins: the breaker released the guard, so a later scaffold
        // is allowed again until another `command/scaffold` is appended.
        state.usedScaffold = false;
        break;
    }
  }

  return state;
}

/** True when the run has produced evidence of real work — the completion guards' test. */
export function hasDoneWork(state: RunState): boolean {
  return state.wroteFiles || state.executedCommands.size > 0 || state.usedWebTools;
}

/** Rebuild a log from a resumed continuation's flat fields. */
export function seedFromContinuation(c: {
  executedCommands?: string[];
  usedScaffold?: boolean;
  wroteFiles?: boolean;
  usedWebTools?: boolean;
  lastWriteDir?: string;
}): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const command of c.executedCommands ?? []) events.push({ type: "command/executed", command });
  if (c.wroteFiles) events.push({ type: "file/written" });
  if (c.usedWebTools) events.push({ type: "web/used" });
  // Order matters: lastWriteDir must survive, and scaffold state is applied
  // last so a resumed `usedScaffold: false` is not overwritten by the fold.
  if (c.lastWriteDir) events.push({ type: "dir/created", dir: c.lastWriteDir });
  if (c.usedScaffold) events.push({ type: "command/scaffold" });
  return events;
}

/**
 * A memoized `deriveRunState` over a growing log. The loop reads run state many
 * times per iteration; recomputing the fold each time is wasted work, and the
 * event count is a sufficient cache key for an append-only log.
 */
export function createRunStateView(log: { readonly events: readonly SessionEvent[] }): () => RunState {
  let cached: RunState | null = null;
  let cachedLength = -1;
  return () => {
    if (cached === null || cachedLength !== log.events.length) {
      cached = deriveRunState(log.events);
      cachedLength = log.events.length;
    }
    return cached;
  };
}
