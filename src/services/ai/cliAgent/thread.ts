/**
 * Folds normalized CLI events into Tron's agent-thread step vocabulary so
 * AgentOverlay renders a Claude Code / Codex run like a built-in one.
 * Pure — only ever looks at the current run (steps after the last separator).
 */
import type { AgentStep } from "../../../types";
import type { CliAgentEvent } from "./normalize";

const MAX_TOOL_OUTPUT = 2000;

type Input = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Tron tool key — drives the status bar labels and overlay icons. */
function toolKey(name: string): string {
  switch (name) {
    case "Bash": return "execute_command";
    case "Read": return "read_file";
    case "Write": return "write_file";
    case "Edit": case "MultiEdit": case "NotebookEdit": case "file_change": return "edit_file";
    case "Grep": case "Glob": return "search_dir";
    case "LS": return "list_dir";
    case "WebSearch": case "WebFetch": return "web_search";
    case "Task": case "Agent": return "agent";
    default: return name;
  }
}

function filePath(input: Input): string {
  return str(input.file_path) || str(input.notebook_path) || str(input.path);
}

function describeStart(name: string, input: Input): string {
  switch (name) {
    case "Bash": return str(input.command);
    case "Read": return `Reading file: ${filePath(input)}`;
    case "Write": return `Writing file: ${filePath(input)}`;
    case "Edit": case "MultiEdit": case "NotebookEdit": return `Editing file: ${filePath(input)}`;
    case "file_change": return `Editing files: ${((input.paths as string[]) ?? []).join(", ")}`;
    case "Grep": return `Searching '${str(input.pattern)}' in: ${str(input.path) || "."}`;
    case "Glob": return `Finding files: ${str(input.pattern)}`;
    case "LS": return `Listing directory: ${str(input.path)}`;
    case "WebSearch": return `Searching web: ${str(input.query)}`;
    case "WebFetch": return `Fetching: ${str(input.url)}`;
    case "Task": case "Agent": return `Sub-agent: ${str(input.description)}`;
    default: {
      const args = JSON.stringify(input);
      return `${name}${args && args !== "{}" ? ` ${args.length > 80 ? args.slice(0, 80) + "…" : args}` : ""}`;
    }
  }
}

function describeDone(name: string, input: Input): string {
  switch (name) {
    case "Read": return `Read file: ${filePath(input)}`;
    case "Write": return `Wrote file: ${filePath(input)}`;
    case "Edit": case "MultiEdit": case "NotebookEdit": return `Edited file: ${filePath(input)}`;
    case "file_change": return `Edited files: ${((input.paths as string[]) ?? []).join(", ")}`;
    default: return describeStart(name, input);
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (${text.length - MAX_TOOL_OUTPUT} more chars truncated)`;
}

function runStart(thread: AgentStep[]): number {
  for (let i = thread.length - 1; i >= 0; i--) if (thread[i].step === "separator") return i + 1;
  return 0;
}

function lastIndexInRun(thread: AgentStep[], match: (s: AgentStep) => boolean): number {
  const from = runStart(thread);
  for (let i = thread.length - 1; i >= from; i--) if (match(thread[i])) return i;
  return -1;
}

function withoutStreaming(thread: AgentStep[]): AgentStep[] {
  const from = runStart(thread);
  if (!thread.slice(from).some((s) => s.step === "streaming")) return thread;
  return [...thread.slice(0, from), ...thread.slice(from).filter((s) => s.step !== "streaming")];
}

/** Close an open thinking block: keep it as a thought, or drop it when the
 *  model's reasoning was redacted (Claude streams empty thinking deltas). */
function closeThinking(thread: AgentStep[]): AgentStep[] {
  const i = lastIndexInRun(thread, (s) => s.step === "thinking");
  if (i < 0) return thread;
  const text = thread[i].output.trim();
  const next = [...thread];
  if (text) next[i] = { step: "thought", output: text };
  else next.splice(i, 1);
  return next;
}

export function applyCliEvent(thread: AgentStep[], ev: CliAgentEvent): AgentStep[] {
  switch (ev.type) {
    case "thinking_start":
      return thread.at(-1)?.step === "thinking" ? thread : [...thread, { step: "thinking", output: "" }];
    case "thinking_delta": {
      const i = lastIndexInRun(thread, (s) => s.step === "thinking");
      if (i < 0) return [...thread, { step: "thinking", output: ev.text }];
      const next = [...thread];
      next[i] = { step: "thinking", output: next[i].output + ev.text };
      return next;
    }
    case "thinking_end":
      return closeThinking(thread);
    case "thought":
      return ev.text ? [...thread, { step: "thought", output: ev.text }] : thread;
    case "text_delta": {
      const last = thread.at(-1);
      if (last?.step === "streaming") return [...thread.slice(0, -1), { step: "streaming", output: last.output + ev.text }];
      return [...thread, { step: "streaming", output: ev.text }];
    }
    case "text": {
      const cleaned = withoutStreaming(thread);
      const text = ev.text.trim();
      return text ? [...cleaned, { step: "thought", output: text }] : cleaned;
    }
    case "tool_start":
      return [
        ...closeThinking(withoutStreaming(thread)),
        {
          step: "executing",
          output: describeStart(ev.name, ev.input),
          payload: {
            tool: toolKey(ev.name),
            toolUseId: ev.id,
            cliTool: ev.name,
            input: ev.input,
            ...(ev.name === "Bash" ? { command: str(ev.input.command) } : {}),
            ...(filePath(ev.input) ? { path: filePath(ev.input) } : {}),
            ...(str(ev.input.query) ? { query: str(ev.input.query) } : {}),
            ...(str(ev.input.url) ? { url: str(ev.input.url) } : {}),
          },
        },
      ];
    case "tool_end": {
      const i = lastIndexInRun(thread, (s) => s.step === "executing" && s.payload?.toolUseId === ev.id);
      if (i < 0) return thread;
      const s = thread[i];
      const label = describeDone(s.payload.cliTool, s.payload.input ?? {});
      const next = [...thread];
      next[i] = {
        step: ev.isError ? "failed" : "executed",
        output: ev.output ? `${label}\n---\n${truncate(ev.output)}` : label,
        payload: s.payload,
      };
      return next;
    }
    case "todos":
      return [...withoutStreaming(thread), { step: "plan", output: "", payload: { tool: "todo_write", todos: ev.todos } }];
    case "result": {
      const cleaned = closeThinking(withoutStreaming(thread));
      const text = ev.text.trim() || (ev.isError ? "Task failed" : "Done");
      if (ev.isError) return [...cleaned, { step: "failed", output: text }];
      const last = cleaned.at(-1);
      if (last?.step === "thought" && last.output === text) return [...cleaned.slice(0, -1), { step: "done", output: text }];
      return [...cleaned, { step: "done", output: text }];
    }
    case "error":
      return [...thread, { step: "error", output: ev.message }];
    default:
      return thread;
  }
}
