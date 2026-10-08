import type { AgentStep } from "../types";

const INFLIGHT = ["executing", "streaming", "streaming_thinking", "streaming_response", "thinking"];
const REMOVE_ON_STOP = ["streaming_thinking", "streaming_response", "thinking", "thought"];

/**
 * The agent thread after a manual Stop: in the CURRENT run (after the last
 * separator) transient thinking goes away and running steps become "stopped";
 * a plain "Stopped" marker is added when nothing was in flight. Earlier turns
 * are never touched.
 */
export function threadAfterStop(thread: AgentStep[]): AgentStep[] {
  let from = 0;
  for (let i = thread.length - 1; i >= 0; i--) {
    if (thread[i].step === "separator") {
      from = i + 1;
      break;
    }
  }
  const current = thread.slice(from);
  const hadInflight = current.some((s) => INFLIGHT.includes(s.step));
  const cleaned = current
    .filter((s) => !REMOVE_ON_STOP.includes(s.step))
    .map((s) => (s.step === "executing" || s.step === "streaming" ? { ...s, step: "stopped" } : s));
  return [
    ...thread.slice(0, from),
    ...cleaned,
    ...(hadInflight ? [] : [{ step: "stopped", output: "Stopped" }]),
  ];
}
