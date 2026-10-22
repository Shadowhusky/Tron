import { describe, it, expect } from "vitest";
import { createSessionLog, type SessionEvent } from "../services/ai/agent/events";
import {
  deriveRunState,
  hasDoneWork,
  seedFromContinuation,
  createRunStateView,
} from "../services/ai/agent/derive";

/**
 * The run state the completion and scaffold guards read used to be six mutable
 * locals written from ~43 places. These pin the fold that replaced five of them.
 */

describe("deriveRunState", () => {
  it("starts empty", () => {
    const s = deriveRunState([]);
    expect(s.executedCommands.size).toBe(0);
    expect(s.usedScaffold).toBe(false);
    expect(s.wroteFiles).toBe(false);
    expect(s.usedWebTools).toBe(false);
    expect(s.lastWriteDir).toBe("");
  });

  it("collects distinct executed commands", () => {
    const s = deriveRunState([
      { type: "command/executed", command: "ls" },
      { type: "command/executed", command: "pwd" },
      { type: "command/executed", command: "ls" },
    ]);
    expect([...s.executedCommands].sort()).toEqual(["ls", "pwd"]);
  });

  it("tracks file writes and keeps the SHALLOWEST directory as the project root", () => {
    const s = deriveRunState([
      { type: "file/written", dir: "/proj/src/deep" },
      { type: "file/written", dir: "/proj" },
      { type: "file/written", dir: "/proj/src" },
    ]);
    expect(s.wroteFiles).toBe(true);
    expect(s.lastWriteDir).toBe("/proj");
  });

  it("does not let a nested write drag the project root deeper", () => {
    const s = deriveRunState([
      { type: "file/written", dir: "/proj" },
      { type: "file/written", dir: "/proj/src/components" },
    ]);
    expect(s.lastWriteDir).toBe("/proj");
  });

  it("keeps the previous write dir when a write reports none", () => {
    const s = deriveRunState([
      { type: "file/written", dir: "/a" },
      { type: "file/written" },
    ]);
    expect(s.lastWriteDir).toBe("/a");
  });

  it("lets an explicit mkdir override the shallowest-wins heuristic", () => {
    const s = deriveRunState([
      { type: "file/written", dir: "/proj" },
      { type: "dir/created", dir: "/proj/src/generated" },
    ]);
    expect(s.lastWriteDir).toBe("/proj/src/generated");
  });

  it("latches the scaffold guard once a scaffold command runs", () => {
    expect(deriveRunState([{ type: "command/scaffold" }]).usedScaffold).toBe(true);
  });

  it("lets the circuit breaker release the scaffold guard (last write wins)", () => {
    const s = deriveRunState([
      { type: "command/scaffold" },
      { type: "guards/scaffold-reset" },
    ]);
    expect(s.usedScaffold).toBe(false);
  });

  it("re-latches the guard if another scaffold runs after a reset", () => {
    const s = deriveRunState([
      { type: "command/scaffold" },
      { type: "guards/scaffold-reset" },
      { type: "command/scaffold" },
    ]);
    expect(s.usedScaffold).toBe(true);
  });

  it("a breaker reset does NOT erase executed commands", () => {
    // That evidence is what the final_answer guards use to tell real work from
    // a lazy completion; clearing it would let a bare "Done." through.
    const s = deriveRunState([
      { type: "command/executed", command: "npm test" },
      { type: "guards/scaffold-reset" },
    ]);
    expect(s.executedCommands.size).toBe(1);
  });

  it("records web tool use", () => {
    expect(deriveRunState([{ type: "web/used" }]).usedWebTools).toBe(true);
  });
});

describe("hasDoneWork", () => {
  it("is false on an empty run and true after any real work", () => {
    expect(hasDoneWork(deriveRunState([]))).toBe(false);
    expect(hasDoneWork(deriveRunState([{ type: "command/executed", command: "ls" }]))).toBe(true);
    expect(hasDoneWork(deriveRunState([{ type: "file/written" }]))).toBe(true);
    expect(hasDoneWork(deriveRunState([{ type: "web/used" }]))).toBe(true);
  });

  it("is not satisfied by a scaffold guard alone", () => {
    expect(hasDoneWork(deriveRunState([{ type: "command/scaffold" }]))).toBe(false);
  });
});

describe("seedFromContinuation", () => {
  it("round-trips resumed state through the fold", () => {
    const original = {
      executedCommands: ["ls", "npm test"],
      usedScaffold: true,
      wroteFiles: true,
      usedWebTools: true,
      lastWriteDir: "/proj",
    };
    const s = deriveRunState(seedFromContinuation(original));
    expect([...s.executedCommands].sort()).toEqual(["ls", "npm test"]);
    expect(s.usedScaffold).toBe(true);
    expect(s.wroteFiles).toBe(true);
    expect(s.usedWebTools).toBe(true);
    expect(s.lastWriteDir).toBe("/proj");
  });

  it("round-trips an empty continuation", () => {
    const s = deriveRunState(seedFromContinuation({}));
    expect(hasDoneWork(s)).toBe(false);
    expect(s.usedScaffold).toBe(false);
  });

  it("does not resurrect a scaffold guard the breaker had cleared", () => {
    const s = deriveRunState(seedFromContinuation({ usedScaffold: false, lastWriteDir: "/p" }));
    expect(s.usedScaffold).toBe(false);
    expect(s.lastWriteDir).toBe("/p");
  });
});

describe("createRunStateView", () => {
  it("reflects appends and caches between them", () => {
    const log = createSessionLog();
    const view = createRunStateView(log);
    expect(view().executedCommands.size).toBe(0);
    const first = view();
    expect(view()).toBe(first); // same object while the log is unchanged

    log.append({ type: "command/executed", command: "ls" });
    expect(view().executedCommands.has("ls")).toBe(true);
    expect(view()).not.toBe(first);
  });

  it("seeds from an existing event list", () => {
    const seed: SessionEvent[] = [{ type: "web/used" }];
    expect(createRunStateView(createSessionLog(seed))().usedWebTools).toBe(true);
  });
});
