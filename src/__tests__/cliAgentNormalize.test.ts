import { describe, it, expect } from "vitest";
import claudeBash from "./fixtures/cli-agent/claude-bash.jsonl?raw";
import claudePermission from "./fixtures/cli-agent/claude-permission.jsonl?raw";
import codexCommand from "./fixtures/cli-agent/codex-command.jsonl?raw";
import {
  createClaudeNormalizer,
  createCodexNormalizer,
  unwrapShellCommand,
  type CliAgentEvent,
} from "../services/ai/cliAgent/normalize";

const FIXTURES: Record<string, string> = {
  "claude-bash.jsonl": claudeBash,
  "claude-permission.jsonl": claudePermission,
  "codex-command.jsonl": codexCommand,
};
const fixture = (name: string): unknown[] =>
  FIXTURES[name].split("\n").filter(Boolean).map((l) => JSON.parse(l));

const run = (normalize: (m: unknown) => CliAgentEvent[], msgs: unknown[]) => msgs.flatMap((m) => normalize(m));

describe("claude normalizer (real captures)", () => {
  it("turns a Bash run into session → thinking → tool → text → result", () => {
    const events = run(createClaudeNormalizer(), fixture("claude-bash.jsonl"));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("session");
    expect(events[0]).toMatchObject({ type: "session", id: "b64a3747-3b40-49e5-a02e-c03d9a511836" });
    expect(types).toContain("thinking_start");
    expect(types).toContain("thinking_end");
    const start = events.find((e) => e.type === "tool_start");
    expect(start).toMatchObject({ name: "Bash", input: { command: "echo tron-probe" } });
    const end = events.find((e) => e.type === "tool_end");
    expect(end).toMatchObject({ id: (start as { id: string }).id, output: "tron-probe", isError: false });
    expect(events.filter((e) => e.type === "text_delta").map((e) => (e as { text: string }).text).join("")).toBe("done");
    expect(events.at(-1)).toMatchObject({ type: "result", text: "done", isError: false, sessionId: "b64a3747-3b40-49e5-a02e-c03d9a511836" });
  });

  it("surfaces can_use_tool as a permission event", () => {
    const perm = run(createClaudeNormalizer(), fixture("claude-permission.jsonl")).find((e) => e.type === "permission");
    expect(perm).toMatchObject({
      type: "permission",
      requestId: "cc7699e4-b939-4b8b-95aa-b851edaaef9b",
      tool: "Write",
      input: { file_path: "/tmp/probe/probe.txt", content: "hi" },
    });
  });

  it("drops sub-agent traffic", () => {
    const n = createClaudeNormalizer();
    expect(n({ type: "assistant", parent_tool_use_id: "toolu_x", message: { content: [{ type: "text", text: "inner" }] } })).toEqual([]);
  });

  it("maps TodoWrite to a todos event instead of a tool call", () => {
    const n = createClaudeNormalizer();
    const out = n({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [{
          type: "tool_use", id: "t1", name: "TodoWrite",
          input: { todos: [{ content: "Write tests", status: "in_progress", activeForm: "Writing tests" }, { content: "Ship", status: "pending" }] },
        }],
      },
    });
    expect(out).toEqual([{ type: "todos", todos: [{ content: "Write tests", status: "in_progress" }, { content: "Ship", status: "pending" }] }]);
  });

  it("joins array tool_result content and flags errors", () => {
    const n = createClaudeNormalizer();
    const out = n({
      type: "user",
      parent_tool_use_id: null,
      message: { content: [{ type: "tool_result", tool_use_id: "t9", is_error: true, content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] },
    });
    expect(out).toEqual([{ type: "tool_end", id: "t9", output: "a\nb", isError: true }]);
  });

  it("reports an error result with its error text", () => {
    const n = createClaudeNormalizer();
    expect(n({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"], session_id: "s" })).toEqual([
      expect.objectContaining({ type: "result", isError: true, text: "boom", sessionId: "s" }),
    ]);
  });
});

describe("codex normalizer (real capture)", () => {
  it("turns a command run into session → text → tool → text → result", () => {
    const events = run(createCodexNormalizer(), fixture("codex-command.jsonl"));
    expect(events[0]).toEqual({ type: "session", id: "01a11bef-3a67-7130-a66a-0b86212522a5" });
    expect(events).toContainEqual({ type: "text", text: "I’ll run the command." });
    expect(events).toContainEqual({ type: "tool_start", id: "item_1", name: "Bash", input: { command: "echo tron-probe" } });
    expect(events).toContainEqual({ type: "tool_end", id: "item_1", output: "tron-probe", isError: false });
    expect(events.at(-1)).toMatchObject({ type: "result", text: "done", isError: false, sessionId: "01a11bef-3a67-7130-a66a-0b86212522a5" });
  });

  it("maps reasoning, file changes, todo lists and failures", () => {
    const n = createCodexNormalizer();
    expect(n({ type: "item.completed", item: { id: "r", type: "reasoning", text: "**Planning** steps" } })).toEqual([
      { type: "thought", text: "**Planning** steps" },
    ]);
    expect(n({ type: "item.completed", item: { id: "f", type: "file_change", changes: [{ path: "/p/a.ts", kind: "update" }], status: "completed" } })).toEqual([
      { type: "tool_start", id: "f", name: "file_change", input: { paths: ["/p/a.ts"] } },
      { type: "tool_end", id: "f", output: "update /p/a.ts", isError: false },
    ]);
    expect(n({ type: "item.updated", item: { id: "t", type: "todo_list", items: [{ text: "a", completed: true }, { text: "b", completed: false }] } })).toEqual([
      { type: "todos", todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] },
    ]);
    expect(n({ type: "turn.failed", error: { message: "rate limited" } })).toEqual([
      expect.objectContaining({ type: "result", isError: true, text: "rate limited" }),
    ]);
  });

  it("flags non-zero command exits as errors", () => {
    const n = createCodexNormalizer();
    n({ type: "item.started", item: { id: "c", type: "command_execution", command: "bash -lc 'false'", aggregated_output: "", exit_code: null, status: "in_progress" } });
    expect(n({ type: "item.completed", item: { id: "c", type: "command_execution", command: "bash -lc 'false'", aggregated_output: "", exit_code: 1, status: "failed" } })).toEqual([
      { type: "tool_end", id: "c", output: "(exit code 1)", isError: true },
    ]);
  });
});

describe("unwrapShellCommand", () => {
  it("strips codex's login-shell wrapper", () => {
    expect(unwrapShellCommand("/bin/zsh -lc 'echo tron-probe'")).toBe("echo tron-probe");
    expect(unwrapShellCommand("bash -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(unwrapShellCommand("ls -la")).toBe("ls -la");
  });
});
