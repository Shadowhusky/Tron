import type { AgentStep } from "../types";

/**
 * Thread edits that must stay inside the CURRENT run.
 *
 * Runs are delimited by a `separator` step. Several reducers walk the thread
 * backwards looking for the most recent `thinking` entry — and two of them had
 * no run boundary, so on a follow-up message they could reach past the
 * separator and rewrite a PREVIOUS run's reasoning, or delete it. That is why
 * the thinking container rendered incorrectly after a follow-up: the new run's
 * thought was grafted onto an older run, leaving the current one with none.
 *
 * `read_terminal` merging in the same file already stops at the separator;
 * these now do the same.
 */

/** Index of the last step of the current run, i.e. after the final separator. */
export function currentRunStart(thread: AgentStep[]): number {
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i].step === "separator") return i + 1;
  }
  return 0;
}

/**
 * Turn the current run's in-flight `thinking` entry into a finished `thought`.
 * Appends one if this run has none — never touches an earlier run.
 */
export function finalizeThinking(thread: AgentStep[], output: string): AgentStep[] {
  const start = currentRunStart(thread);
  for (let i = thread.length - 1; i >= start; i--) {
    if (thread[i].step === "thinking") {
      const updated = [...thread];
      updated[i] = { step: "thought", output };
      return updated;
    }
  }
  return [...thread, { step: "thought", output }];
}

/**
 * Drop the current run's most recent thought/thinking entry (used when a parse
 * failed and the step is being retried silently). A run with nothing of its own
 * to retract is left alone rather than eating the previous run's reasoning.
 */
export function retractThought(thread: AgentStep[]): AgentStep[] {
  const start = currentRunStart(thread);
  for (let i = thread.length - 1; i >= start; i--) {
    if (thread[i].step === "thought" || thread[i].step === "thinking") {
      const updated = [...thread];
      updated.splice(i, 1);
      return updated;
    }
  }
  return thread;
}
