/**
 * Normalizes the two CLI protocols into one event stream:
 * - Claude Code `-p --output-format stream-json --include-partial-messages`
 * - Codex `exec --json`
 * Shapes verified against live captures (src/__tests__/fixtures/cli-agent/).
 */
import type { AgentTodo } from "../../../types";

export type CliAgentEvent =
  | { type: "session"; id: string; model?: string }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; text: string }
  | { type: "thinking_end" }
  /** A complete reasoning summary (codex) — no streaming. */
  | { type: "thought"; text: string }
  | { type: "text_delta"; text: string }
  /** A complete assistant text block. */
  | { type: "text"; text: string }
  | { type: "tool_start"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_end"; id: string; output: string; isError: boolean }
  | { type: "todos"; todos: AgentTodo[] }
  | { type: "permission"; requestId: string; tool: string; input: Record<string, unknown>; description?: string }
  /** The CLI withdrew a permission request (e.g. the tool call was cancelled). */
  | { type: "permission_cancel"; requestId: string }
  /** Informational line, not an error (e.g. codex reconnecting). */
  | { type: "notice"; text: string }
  | { type: "result"; text: string; isError: boolean; sessionId?: string; costUsd?: number; usage?: Record<string, unknown> }
  | { type: "error"; message: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);

function toTodos(raw: unknown): AgentTodo[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t) => t && typeof t.content === "string")
    .map((t) => ({ content: t.content, status: TODO_STATUSES.has(t.status) ? t.status : "pending" }));
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

export function createClaudeNormalizer() {
  // content-block index → type, for the current streamed message
  let blockTypes: Record<number, string> = {};
  let sessionId: string | undefined;

  return (raw: unknown): CliAgentEvent[] => {
    const m = (raw ?? {}) as Json;
    if (m.parent_tool_use_id) return []; // sub-agent internals
    switch (m.type) {
      case "system":
        if (m.subtype === "init" && typeof m.session_id === "string") {
          sessionId = m.session_id;
          return [{ type: "session", id: m.session_id, model: m.model }];
        }
        return [];
      case "stream_event": {
        const e = (m.event ?? {}) as Json;
        if (e.type === "message_start") blockTypes = {};
        if (e.type === "content_block_start") {
          blockTypes[e.index] = e.content_block?.type;
          return e.content_block?.type === "thinking" ? [{ type: "thinking_start" }] : [];
        }
        if (e.type === "content_block_delta") {
          const d = (e.delta ?? {}) as Json;
          if (d.type === "thinking_delta" && d.thinking) return [{ type: "thinking_delta", text: d.thinking }];
          if (d.type === "text_delta" && d.text) return [{ type: "text_delta", text: d.text }];
          return [];
        }
        if (e.type === "content_block_stop" && blockTypes[e.index] === "thinking") return [{ type: "thinking_end" }];
        return [];
      }
      case "assistant": {
        const out: CliAgentEvent[] = [];
        for (const b of (m.message?.content ?? []) as Json[]) {
          if (b.type === "text" && b.text) out.push({ type: "text", text: b.text });
          else if (b.type === "tool_use" && b.name === "TodoWrite") out.push({ type: "todos", todos: toTodos(b.input?.todos) });
          else if (b.type === "tool_use") out.push({ type: "tool_start", id: b.id, name: b.name, input: b.input ?? {} });
        }
        return out;
      }
      case "user": {
        const content = m.message?.content;
        if (!Array.isArray(content)) return [];
        return content
          .filter((b: Json) => b.type === "tool_result")
          .map((b: Json) => ({ type: "tool_end", id: b.tool_use_id, output: toolResultText(b.content), isError: !!b.is_error }));
      }
      case "control_request": {
        const r = (m.request ?? {}) as Json;
        if (r.subtype !== "can_use_tool") return [];
        return [{ type: "permission", requestId: m.request_id, tool: r.tool_name, input: r.input ?? {}, description: r.description }];
      }
      case "control_cancel_request":
        return typeof m.request_id === "string" ? [{ type: "permission_cancel", requestId: m.request_id }] : [];
      case "result": {
        const errText = Array.isArray(m.errors) ? m.errors.join("; ") : "";
        return [{
          type: "result",
          text: (typeof m.result === "string" ? m.result : "") || errText,
          isError: !!m.is_error,
          sessionId: m.session_id ?? sessionId,
          costUsd: typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined,
          usage: m.usage,
        }];
      }
      default:
        return [];
    }
  };
}

/** Codex runs commands as `/bin/zsh -lc '<cmd>'` — show just `<cmd>`. */
export function unwrapShellCommand(command: string): string {
  const m = command.match(/^\S*\b(?:ba|z|da|fi|k)?sh\s+-l?c\s+'([\s\S]*)'$/);
  return m ? m[1].replace(/'\\''/g, "'") : command;
}

export function createCodexNormalizer() {
  let sessionId: string | undefined;
  let lastMessage = "";
  const started = new Set<string>();

  const startOnce = (id: string, name: string, input: Record<string, unknown>): CliAgentEvent[] => {
    if (started.has(id)) return [];
    started.add(id);
    return [{ type: "tool_start", id, name, input }];
  };

  return (raw: unknown): CliAgentEvent[] => {
    const e = (raw ?? {}) as Json;
    const item = (e.item ?? {}) as Json;
    switch (e.type) {
      case "thread.started":
        sessionId = e.thread_id;
        return [{ type: "session", id: e.thread_id }];
      case "item.started":
      case "item.updated":
      case "item.completed": {
        const done = e.type === "item.completed";
        switch (item.type) {
          case "agent_message":
            if (!done || !item.text) return [];
            lastMessage = item.text.trim();
            return [{ type: "text", text: lastMessage }];
          case "reasoning":
            return done && item.text ? [{ type: "thought", text: item.text.trim() }] : [];
          case "command_execution": {
            const start = startOnce(item.id, "Bash", { command: unwrapShellCommand(item.command ?? "") });
            if (!done) return start;
            const failed = typeof item.exit_code === "number" && item.exit_code !== 0;
            const output = (item.aggregated_output ?? "").replace(/\n$/, "") || (failed ? `(exit code ${item.exit_code})` : "");
            return [...start, { type: "tool_end", id: item.id, output, isError: failed }];
          }
          case "file_change": {
            const changes = (item.changes ?? []) as Json[];
            const start = startOnce(item.id, "file_change", { paths: changes.map((c) => c.path) });
            if (!done) return start;
            const output = changes.map((c) => `${c.kind ?? "update"} ${c.path}`).join("\n");
            return [...start, { type: "tool_end", id: item.id, output, isError: item.status === "failed" }];
          }
          case "web_search": {
            const start = startOnce(item.id, "WebSearch", { query: item.query ?? "" });
            return done ? [...start, { type: "tool_end", id: item.id, output: "", isError: false }] : start;
          }
          case "mcp_tool_call": {
            const start = startOnce(item.id, `mcp:${item.server}.${item.tool}`, item.arguments ?? {});
            if (!done) return start;
            const output = item.error?.message ?? (typeof item.result === "string" ? item.result : JSON.stringify(item.result ?? ""));
            return [...start, { type: "tool_end", id: item.id, output, isError: item.status === "failed" }];
          }
          case "todo_list":
            return [{
              type: "todos",
              todos: ((item.items ?? []) as Json[]).map((t) => ({ content: String(t.text ?? ""), status: t.completed ? "completed" : "pending" })),
            }];
          case "error":
            return done ? [{ type: "error", message: String(item.message ?? "Unknown error") }] : [];
          default:
            return [];
        }
      }
      case "turn.completed": {
        const text = lastMessage;
        lastMessage = "";
        return [{ type: "result", text, isError: false, sessionId, usage: e.usage }];
      }
      case "turn.failed":
        return [{ type: "result", text: String(e.error?.message ?? "Codex turn failed"), isError: true, sessionId }];
      case "error": {
        const message = String(e.message ?? "Codex error");
        // Transient stream retries ("Reconnecting… 2/5") aren't failures.
        return /^Reconnecting/i.test(message) ? [{ type: "notice", text: message }] : [{ type: "error", message }];
      }
      default:
        return [];
    }
  };
}
