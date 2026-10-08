import { describe, it, expect } from "vitest";
import claudeBash from "./fixtures/cli-agent/claude-bash.jsonl?raw";
import claudePermission from "./fixtures/cli-agent/claude-permission.jsonl?raw";
import codexCommand from "./fixtures/cli-agent/codex-command.jsonl?raw";
import { applyCliEvent } from "../services/ai/cliAgent/thread";
import { createClaudeNormalizer, createCodexNormalizer, type CliAgentEvent } from "../services/ai/cliAgent/normalize";
import type { AgentStep } from "../types";

const FIXTURES: Record<string, string> = {
  "claude-bash.jsonl": claudeBash,
  "claude-permission.jsonl": claudePermission,
  "codex-command.jsonl": codexCommand,
};
const fixture = (name: string): unknown[] =>
  FIXTURES[name].split("\n").filter(Boolean).map((l) => JSON.parse(l));

const start: AgentStep[] = [{ step: "separator", output: "task" }];
const fold = (events: CliAgentEvent[], thread = start) => events.reduce(applyCliEvent, thread);

describe("applyCliEvent — real runs", () => {
  it("renders a claude Bash run as executed + done (redacted thinking dropped)", () => {
    const n = createClaudeNormalizer();
    const thread = fold(fixture("claude-bash.jsonl").flatMap((m) => n(m)));
    expect(thread.map((s) => s.step)).toEqual(["separator", "executed", "done"]);
    expect(thread[1]).toMatchObject({
      step: "executed",
      output: "echo tron-probe\n---\ntron-probe",
      payload: { tool: "execute_command", command: "echo tron-probe" },
    });
    expect(thread[2]).toEqual({ step: "done", output: "done" });
  });

  it("renders a codex run with its intermediate message as a thought", () => {
    const n = createCodexNormalizer();
    const thread = fold(fixture("codex-command.jsonl").flatMap((m) => n(m)));
    expect(thread.map((s) => s.step)).toEqual(["separator", "thought", "executed", "done"]);
    expect(thread[1].output).toBe("I’ll run the command.");
    expect(thread[3].output).toBe("done");
  });
});

describe("applyCliEvent — individual events", () => {
  it("accumulates thinking and finalizes it into a thought", () => {
    const t = fold([
      { type: "thinking_start" },
      { type: "thinking_delta", text: "Let me " },
      { type: "thinking_delta", text: "check." },
    ]);
    expect(t.at(-1)).toEqual({ step: "thinking", output: "Let me check." });
    expect(applyCliEvent(t, { type: "thinking_end" }).at(-1)).toEqual({ step: "thought", output: "Let me check." });
  });

  it("streams text into one streaming entry and cleans it up when a tool starts", () => {
    const t = fold([
      { type: "text_delta", text: "Look" },
      { type: "text_delta", text: "ing" },
    ]);
    expect(t.at(-1)).toEqual({ step: "streaming", output: "Looking" });
    const after = applyCliEvent(t, { type: "tool_start", id: "x", name: "Read", input: { file_path: "/a.ts" } });
    expect(after.map((s) => s.step)).toEqual(["separator", "executing"]);
    expect(after.at(-1)).toMatchObject({ output: "Reading file: /a.ts", payload: { tool: "read_file", path: "/a.ts", toolUseId: "x" } });
  });

  it("completes the matching tool even when another one is running", () => {
    const t = fold([
      { type: "tool_start", id: "a", name: "Grep", input: { pattern: "foo", path: "src" } },
      { type: "tool_start", id: "b", name: "Edit", input: { file_path: "/x.ts" } },
      { type: "tool_end", id: "a", output: "src/x.ts:1:foo", isError: false },
      { type: "tool_end", id: "b", output: "nope", isError: true },
    ]);
    expect(t[1]).toMatchObject({ step: "executed", output: "Searching 'foo' in: src\n---\nsrc/x.ts:1:foo" });
    expect(t[2]).toMatchObject({ step: "failed", output: "Edited file: /x.ts\n---\nnope" });
  });

  it("truncates long tool output", () => {
    const t = fold([
      { type: "tool_start", id: "a", name: "Bash", input: { command: "cat big" } },
      { type: "tool_end", id: "a", output: "x".repeat(10_000), isError: false },
    ]);
    expect(t[1].output.length).toBeLessThan(2_200);
    expect(t[1].output).toContain("truncated");
  });

  it("shows todos as a plan step", () => {
    const t = applyCliEvent(start, { type: "todos", todos: [{ content: "a", status: "pending" }] });
    expect(t.at(-1)).toEqual({ step: "plan", output: "", payload: { tool: "todo_write", todos: [{ content: "a", status: "pending" }] } });
  });

  it("turns a failed result into a failed step", () => {
    expect(applyCliEvent(start, { type: "result", text: "boom", isError: true }).at(-1)).toEqual({ step: "failed", output: "boom" });
  });

  it("does not repeat the answer when the final text was already shown", () => {
    const t = fold([{ type: "text", text: "All set." }, { type: "result", text: "All set.", isError: false }]);
    expect(t.map((s) => s.step)).toEqual(["separator", "done"]);
  });

  it("never touches steps from earlier runs", () => {
    const prior: AgentStep[] = [
      { step: "separator", output: "old" },
      { step: "executing", output: "ls", payload: { toolUseId: "a" } },
      { step: "separator", output: "new" },
    ];
    expect(applyCliEvent(prior, { type: "tool_end", id: "a", output: "x", isError: false })).toBe(prior);
  });
});
