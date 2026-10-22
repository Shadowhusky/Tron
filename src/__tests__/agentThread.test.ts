import { describe, it, expect } from "vitest";
import type { AgentStep } from "../types";
import { currentRunStart, finalizeThinking, retractThought } from "../utils/agentThread";

const sep = (p: string): AgentStep => ({ step: "separator", output: p });
const s = (step: string, output = ""): AgentStep => ({ step, output });

/** Two completed runs, then a follow-up run in progress. */
const followUp: AgentStep[] = [
  sep("first task"),
  s("thought", "reasoning about the FIRST task"),
  s("executed", "which cargo"),
  s("done", "cargo is missing"),
  sep("follow-up task"),
  s("thinking", ""),
];

describe("currentRunStart", () => {
  it("points just past the last separator", () => {
    expect(currentRunStart(followUp)).toBe(5);
  });
  it("is 0 for a thread with no separator", () => {
    expect(currentRunStart([s("thinking")])).toBe(0);
  });
  it("is the end for a run that has only just started", () => {
    expect(currentRunStart([sep("a"), s("x"), sep("b")])).toBe(3);
  });
});

describe("finalizeThinking — must not reach into a previous run", () => {
  it("finalizes the current run's thinking entry", () => {
    const out = finalizeThinking(followUp, "reasoning about the FOLLOW-UP");
    expect(out[5]).toEqual({ step: "thought", output: "reasoning about the FOLLOW-UP" });
    // The earlier run is untouched — this is the bug being fixed.
    expect(out[1]).toEqual({ step: "thought", output: "reasoning about the FIRST task" });
  });

  it("appends rather than rewriting an older run when this run has no thinking yet", () => {
    const noThinking: AgentStep[] = [
      sep("first"),
      s("thinking", "OLD run reasoning"),
      sep("follow-up"),
      s("executed", "ls"),
    ];
    const out = finalizeThinking(noThinking, "NEW reasoning");
    // Previously this walked back and clobbered index 1.
    expect(out[1]).toEqual({ step: "thinking", output: "OLD run reasoning" });
    expect(out[out.length - 1]).toEqual({ step: "thought", output: "NEW reasoning" });
    expect(out).toHaveLength(noThinking.length + 1);
  });

  it("appends when there is no separator at all (very first run)", () => {
    expect(finalizeThinking([], "x")).toEqual([{ step: "thought", output: "x" }]);
  });
});

describe("retractThought — must not delete a previous run's reasoning", () => {
  it("removes the current run's thought", () => {
    const thread: AgentStep[] = [sep("a"), s("thought", "old"), sep("b"), s("thought", "new")];
    const out = retractThought(thread);
    expect(out).toHaveLength(3);
    expect(out.some((x) => x.output === "old")).toBe(true);
    expect(out.some((x) => x.output === "new")).toBe(false);
  });

  it("leaves the thread alone when the current run has nothing to retract", () => {
    const thread: AgentStep[] = [sep("a"), s("thought", "old"), sep("b"), s("executed", "ls")];
    // Previously this deleted the previous run's thought.
    expect(retractThought(thread)).toEqual(thread);
  });

  it("is a no-op on an empty thread", () => {
    expect(retractThought([])).toEqual([]);
  });
});
