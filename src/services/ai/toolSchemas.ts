/**
 * Native function-calling declarations for the agent's tools.
 *
 * Tron's agent protocol is "one JSON object per turn" in the message text.
 * Tool-trained models served by LM Studio (Harmony/gpt-oss-style) answer
 * with a NATIVE tool call instead; without declared tools LM Studio's parser
 * rejects it (500 "does not match the expected peg-native format") and the
 * whole reply is lost. Declaring the same tools lets the server parse the
 * call and stream `tool_calls` deltas, which `ToolCallAssembler` folds back
 * into the exact `{"tool":…}` JSON the rest of the loop already understands —
 * so nothing downstream (parser, guards, history) changes.
 */

type JsonSchema = Record<string, unknown>;

export type OpenAITool = {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
};

const str = (description: string): JsonSchema => ({ type: "string", description });

const tool = (
  name: string,
  description: string,
  properties: Record<string, JsonSchema>,
  required: string[] = Object.keys(properties),
): OpenAITool => ({
  type: "function",
  function: {
    name,
    description,
    parameters: { type: "object", properties, required },
  },
});

/** Every agent tool, with the SAME parameter names the JSON protocol uses. */
export const AGENT_TOOLS: OpenAITool[] = [
  tool("execute_command", "Run ONE non-interactive shell command and get its output.", {
    command: str("The shell command"),
  }),
  tool("run_in_terminal", "Run a long-lived or interactive command in the terminal (dev servers, REPLs, TUIs).", {
    command: str("The shell command"),
  }),
  tool("send_text", "Send raw keystrokes to the terminal (e.g. \\r, \\x03, arrow keys).", {
    text: str("Keystrokes to send"),
    description: str("What the keystrokes do"),
  }, ["text"]),
  tool("read_terminal", "Read the last N lines of terminal output.", {
    lines: { type: "integer", description: "How many lines (default 50)" },
  }, []),
  tool("write_file", "Write a whole file (parent directories are created).", {
    path: str("Absolute path"),
    content: str("Full file content"),
  }),
  tool("read_file", "Read a file.", { path: str("Absolute path") }),
  tool("edit_file", "Replace an exact text span in a file.", {
    path: str("Absolute path"),
    search: str("Exact text to find"),
    replace: str("Replacement text"),
  }),
  tool("list_dir", "List a directory.", { path: str("Absolute path") }),
  tool("search_dir", "Search file contents under a directory.", {
    path: str("Absolute path"),
    query: str("Text or regex to search for"),
  }),
  tool("web_search", "Search the web.", { query: str("Search query") }),
  tool("web_fetch", "Fetch a web page as plain text.", { url: str("Page URL") }),
  tool("todo_write", "Publish or update the task checklist (re-emit the full list).", {
    todos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content: str("Step description"),
          status: { type: "string", enum: ["pending", "in_progress", "completed"] },
        },
        required: ["content", "status"],
      },
    },
  }),
  tool("remember", "Store a short note for later in this session.", { content: str("The note") }),
  tool("read_skill", "Expand a listed skill's full guidance.", { name: str("Skill name") }),
  tool("get_recent_blocks", "Get the last N command/output blocks from the terminal.", {
    n: { type: "integer", description: "How many blocks" },
  }, []),
  tool("ask_question", "Ask the user a question and wait for the answer.", {
    question: str("The question"),
  }),
  tool("final_answer", "Finish the task with a summary of what was done.", {
    content: str("Summary for the user"),
  }),
];

export const AGENT_TOOL_NAMES: string[] = AGENT_TOOLS.map((t) => t.function.name);

/**
 * Accumulates streamed `tool_calls` deltas and renders them as the agent's
 * `{"tool":NAME,...args}` JSON. `push()` returns the text to stream to the UI
 * for that delta (a JSON prefix on the first fragment, then the raw argument
 * fragments minus their opening brace) so progress is visible while a long
 * payload (e.g. a whole file) is still being generated. `text()` returns the
 * final, well-formed JSON — one object per call, newline-separated.
 */
export class ToolCallAssembler {
  private calls: Array<{ name: string; args: string; opened: boolean }> = [];

  get size(): number {
    return this.calls.length;
  }

  push(delta: { index?: number; function?: { name?: string; arguments?: string } }): string {
    const i = delta.index ?? 0;
    while (this.calls.length <= i) this.calls.push({ name: "", args: "", opened: false });
    const call = this.calls[i];
    let out = "";
    if (delta.function?.name) {
      const first = !call.name;
      call.name += delta.function.name;
      if (first) out += `${i > 0 ? "\n" : ""}{"tool":${JSON.stringify(call.name)},`;
    }
    if (delta.function?.arguments) {
      call.args += delta.function.arguments;
      let frag = delta.function.arguments;
      if (!call.opened) {
        const brace = frag.indexOf("{");
        if (brace >= 0) {
          frag = frag.slice(brace + 1);
          call.opened = true;
        }
      }
      out += frag;
    }
    return out;
  }

  text(): string {
    return this.calls
      .filter((c) => c.name)
      .map((c) => {
        let args: Record<string, unknown> = {};
        try {
          const parsed = c.args.trim() ? JSON.parse(c.args) : {};
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
        } catch {
          // Truncated/invalid arguments — keep the raw text so the loop's
          // tolerant parser (and its retry path) sees what the model sent.
          return `{"tool":${JSON.stringify(c.name)},${c.args.replace(/^\s*\{/, "")}`;
        }
        // Some models echo "tool" inside the arguments — the declared name wins.
        const rest = { ...args };
        delete rest.tool;
        return JSON.stringify({ tool: c.name, ...rest });
      })
      .join("\n");
  }
}
