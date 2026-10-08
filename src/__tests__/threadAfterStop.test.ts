import { describe, it, expect } from "vitest";
import { threadAfterStop } from "../utils/threadAfterStop";
import type { AgentStep } from "../types";

describe("threadAfterStop", () => {
  it("only cleans up the current run — earlier turns keep their thoughts and messages", () => {
    const thread: AgentStep[] = [
      { step: "separator", output: "first task" },
      { step: "thought", output: "earlier reasoning" },
      { step: "message", output: "earlier CLI message" },
      { step: "done", output: "ok" },
      { step: "separator", output: "second task" },
      { step: "message", output: "Looking at the tests" },
      { step: "thought", output: "transient" },
      { step: "thinking", output: "…" },
      { step: "executing", output: "npm test" },
      { step: "streaming", output: "partial" },
    ];
    expect(threadAfterStop(thread)).toEqual([
      { step: "separator", output: "first task" },
      { step: "thought", output: "earlier reasoning" },
      { step: "message", output: "earlier CLI message" },
      { step: "done", output: "ok" },
      { step: "separator", output: "second task" },
      { step: "message", output: "Looking at the tests" },
      { step: "stopped", output: "npm test" },
      { step: "stopped", output: "partial" },
    ]);
  });

  it("adds a Stopped marker when nothing was in flight", () => {
    const thread: AgentStep[] = [
      { step: "separator", output: "task" },
      { step: "executed", output: "ls" },
    ];
    expect(threadAfterStop(thread).at(-1)).toEqual({ step: "stopped", output: "Stopped" });
  });

  it("does not treat an earlier run's leftovers as in flight", () => {
    const thread: AgentStep[] = [
      { step: "separator", output: "old" },
      { step: "executing", output: "never closed" },
      { step: "separator", output: "new" },
    ];
    expect(threadAfterStop(thread)).toEqual([...thread, { step: "stopped", output: "Stopped" }]);
  });
});
