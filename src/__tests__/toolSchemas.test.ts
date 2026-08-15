import { describe, it, expect } from "vitest";
import { AGENT_TOOLS, AGENT_TOOL_NAMES, ToolCallAssembler } from "../services/ai/toolSchemas";
import { aiService } from "../services/ai/index";

describe("AGENT_TOOLS declarations", () => {
  it("cover every tool the agent loop dispatches, once each", () => {
    expect(new Set(AGENT_TOOL_NAMES).size).toBe(AGENT_TOOL_NAMES.length);
    expect(AGENT_TOOL_NAMES).toEqual([
      "execute_command", "run_in_terminal", "send_text", "read_terminal",
      "write_file", "read_file", "edit_file", "list_dir", "search_dir",
      "web_search", "web_fetch",
      "todo_write", "remember", "read_skill", "get_recent_blocks",
      "ask_question", "final_answer",
    ]);
  });

  it("are valid OpenAI function declarations with object parameters", () => {
    for (const t of AGENT_TOOLS) {
      expect(t.type).toBe("function");
      expect(t.function.parameters).toMatchObject({ type: "object" });
      const params = t.function.parameters as { properties: Record<string, unknown>; required: string[] };
      for (const r of params.required) expect(params.properties).toHaveProperty(r);
    }
  });
});

describe("ToolCallAssembler", () => {
  it("streams a JSON prefix then argument fragments, and renders well-formed agent JSON", () => {
    const a = new ToolCallAssembler();
    const out =
      a.push({ index: 0, function: { name: "write_file", arguments: "" } }) +
      a.push({ index: 0, function: { arguments: '{"path": "/tmp/a' } }) +
      a.push({ index: 0, function: { arguments: '.html", "content": "<h1>hi</h1>"}' } });
    expect(out).toBe('{"tool":"write_file","path": "/tmp/a.html", "content": "<h1>hi</h1>"}');
    expect(JSON.parse(a.text())).toEqual({ tool: "write_file", path: "/tmp/a.html", content: "<h1>hi</h1>" });
  });

  it("handles empty arguments and an echoed 'tool' key", () => {
    const a = new ToolCallAssembler();
    a.push({ index: 0, function: { name: "read_terminal", arguments: "{}" } });
    expect(JSON.parse(a.text())).toEqual({ tool: "read_terminal" });
    const b = new ToolCallAssembler();
    b.push({ index: 0, function: { name: "list_dir", arguments: '{"tool":"list_dir","path":"/"}' } });
    expect(JSON.parse(b.text())).toEqual({ tool: "list_dir", path: "/" });
  });

  it("keeps truncated arguments as raw text instead of throwing", () => {
    const a = new ToolCallAssembler();
    a.push({ index: 0, function: { name: "write_file", arguments: '{"path":"/x", "content":"unfinished' } });
    expect(a.text()).toBe('{"tool":"write_file","path":"/x", "content":"unfinished');
  });

  it("renders parallel calls one per line so the loop's multi-tool guard sees them", () => {
    const a = new ToolCallAssembler();
    a.push({ index: 0, function: { name: "read_file", arguments: '{"path":"/a"}' } });
    a.push({ index: 1, function: { name: "read_file", arguments: '{"path":"/b"}' } });
    expect(a.text().split("\n").map((l) => JSON.parse(l))).toEqual([
      { tool: "read_file", path: "/a" },
      { tool: "read_file", path: "/b" },
    ]);
  });
});

function sse(chunks: unknown[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
const delta = (d: Record<string, unknown>) => ({ choices: [{ index: 0, delta: d, finish_reason: null }] });

describe("parseOpenAIStream with native tool_calls", () => {
  const parse = (aiService as unknown as {
    parseOpenAIStream: (r: Response, onToken?: (t: string, th?: string) => void) => Promise<{ content: string; thinking: string }>;
  }).parseOpenAIStream.bind(aiService);

  it("returns the tool call as agent JSON and streams progress tokens", async () => {
    const tokens: string[] = [];
    const res = await parse(
      sse([
        delta({ role: "assistant", reasoning_content: "Let's do todo_write." }),
        delta({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "todo_write", arguments: "" } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"todos":[{"content":"Write game","status":"pending"}' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: ']}' } }] }),
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]),
      (t, th) => { if (t) tokens.push(t); if (th) tokens.push(`<th>${th}`); },
    );
    expect(res.thinking).toBe("Let's do todo_write.");
    expect(JSON.parse(res.content)).toEqual({ tool: "todo_write", todos: [{ content: "Write game", status: "pending" }] });
    expect(tokens[0]).toBe("<th>Let's do todo_write.");
    expect(tokens.slice(1).join("")).toBe('{"tool":"todo_write","todos":[{"content":"Write game","status":"pending"}]}');
  });

  it("prefers plain content when the model wrote JSON in the message text", async () => {
    const res = await parse(sse([delta({ content: '{"tool":"final_answer","content":"done"}' })]));
    expect(res.content).toBe('{"tool":"final_answer","content":"done"}');
  });
});
