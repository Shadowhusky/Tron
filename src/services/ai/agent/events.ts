/**
 * The agent run's append-only event log.
 *
 * Before this, the facts a run accumulated lived in six mutable locals scattered
 * across ~43 assignment sites inside one 3,000-line closure, which is why
 * resuming after `ask_question` had to enumerate every one of them by hand.
 *
 * Here, facts are appended once and the state the guards read is a *projection*
 * of them (see ./derive). Adding a new derived fact means folding it, not
 * threading another variable through the loop.
 *
 * Scope note: this log currently records the facts guard state is derived from.
 * It is deliberately not yet the source of the model's message history, nor is
 * it persisted — those are separate follow-ups.
 */

/** A durable fact produced by a run. */
export type SessionEvent =
  /** A shell command completed (`execute_command` or `run_in_terminal`). */
  | { type: "command/executed"; command: string }
  /** A scaffold command ran — the guard that stops a second scaffold. */
  | { type: "command/scaffold" }
  /** A file was created or edited; `dir` is its parent, when known. */
  | { type: "file/written"; dir?: string }
  /** A directory was created (`mkdir`), which becomes the write target. */
  | { type: "dir/created"; dir: string }
  /** A web search or fetch returned — counts as work for the completion guards. */
  | { type: "web/used" }
  /**
   * The circuit breaker cleared the scaffold guard so a blocked run can move.
   * Deliberately an event: it is a decision, not a consequence, and replaying
   * the log without it would resurrect a guard the breaker had released.
   */
  | { type: "guards/scaffold-reset" };

export interface SessionLog {
  /** Append one fact. */
  append(event: SessionEvent): void;
  /** Every fact so far, oldest first. */
  readonly events: readonly SessionEvent[];
}

export function createSessionLog(seed: readonly SessionEvent[] = []): SessionLog {
  const events: SessionEvent[] = [...seed];
  return {
    append(event) { events.push(event); },
    get events() { return events; },
  };
}
