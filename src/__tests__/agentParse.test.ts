import { describe, it, expect } from "vitest";
import {
  fixJsonEscapes,
  escapeNewlinesInStrings,
  normalizeToolKey,
  tryParseJson,
  coerceAction,
  parseAction,
} from "../services/ai/agent/parse";

/**
 * Characterization tests for the tool-call parsing stack.
 *
 * This logic previously lived inside the agent loop's closure and was
 * unreachable from a test, despite being the layer that keeps weak local
 * models usable. These pin the behavior that must survive the refactor.
 */

describe("fixJsonEscapes", () => {
  it("converts \\xHH escapes to \\u00HH so JSON.parse accepts them", () => {
    // Rewrites the escape sequence itself; the character appears only after parsing.
    expect(fixJsonEscapes(String.raw`{"c":"caf\xe9"}`)).toBe(String.raw`{"c":"caf\u00e9"}`);
    expect(JSON.parse(fixJsonEscapes(String.raw`{"c":"caf\xe9"}`)).c).toBe("café");
    expect(JSON.parse(fixJsonEscapes(String.raw`{"c":"a\x41b"}`)).c).toBe("aAb");
  });

  it("leaves text with no \\x escapes untouched", () => {
    expect(fixJsonEscapes('{"a":1}')).toBe('{"a":1}');
  });
});

describe("escapeNewlinesInStrings", () => {
  it("escapes newlines inside string values but not structural whitespace", () => {
    const out = escapeNewlinesInStrings('{\n  "content": "line1\nline2"\n}');
    expect(out).toContain("line1\\nline2");
    expect(JSON.parse(out).content).toBe("line1\nline2");
  });

  it("does not corrupt already-escaped sequences", () => {
    const src = '{"content":"a\\nb"}';
    expect(JSON.parse(escapeNewlinesInStrings(src)).content).toBe("a\nb");
  });

  it("repairs the multi-line write_file payload that plain JSON.parse rejects", () => {
    const raw = '{"tool":"write_file","path":"/tmp/x.py","content":"import os\nprint(1)\n"}';
    expect(() => JSON.parse(raw)).toThrow();
    expect(JSON.parse(escapeNewlinesInStrings(raw)).content).toBe("import os\nprint(1)\n");
  });
});

describe("normalizeToolKey", () => {
  it("unwraps a single-element array wrapper", () => {
    expect(normalizeToolKey([{ tool: "execute_command", command: "ls" }]))
      .toEqual({ tool: "execute_command", command: "ls" });
  });

  it("maps a tool name used as the top-level key with a string value", () => {
    expect(normalizeToolKey({ final_answer: "Done." }))
      .toEqual({ tool: "final_answer", content: "Done." });
  });

  it("maps command tools' string value to `command`, not `content`", () => {
    expect(normalizeToolKey({ execute_command: "ls -la" }))
      .toEqual({ tool: "execute_command", command: "ls -la" });
    expect(normalizeToolKey({ run_in_terminal: "npm run dev" }))
      .toEqual({ tool: "run_in_terminal", command: "npm run dev" });
  });

  it("flattens a tool name key with an object value", () => {
    expect(normalizeToolKey({ final_answer: { content: "Done." } }))
      .toEqual({ tool: "final_answer", content: "Done." });
  });

  it("maps gpt-oss's {cmd:[bash,-lc,...]} to execute_command using the last element", () => {
    expect(normalizeToolKey({ cmd: ["bash", "-lc", "echo hi"] }))
      .toEqual({ tool: "execute_command", command: "echo hi" });
    expect(normalizeToolKey({ cmd: "echo hi" }))
      .toEqual({ tool: "execute_command", command: "echo hi" });
  });

  it("infers a tool from bare arguments that carry no tool name", () => {
    expect(normalizeToolKey({ todos: [{ content: "step", status: "pending" }] }).tool)
      .toBe("todo_write");
  });

  it("leaves an already-named tool call alone", () => {
    const named = { tool: "read_terminal", lines: 50 };
    expect(normalizeToolKey(named)).toBe(named);
  });
});

describe("tryParseJson", () => {
  it("returns null for empty or whitespace-only text", () => {
    expect(tryParseJson("")).toBeNull();
    expect(tryParseJson("   \n ")).toBeNull();
  });

  it("parses a bare tool call directly", () => {
    expect(tryParseJson('{"tool":"execute_command","command":"ls"}'))
      .toEqual({ tool: "execute_command", command: "ls" });
  });

  it("extracts JSON from a markdown fence, with or without a language tag", () => {
    expect(tryParseJson('```json\n{"tool":"final_answer","content":"hi"}\n```').tool)
      .toBe("final_answer");
    expect(tryParseJson('```\n{"tool":"final_answer","content":"hi"}\n```').tool)
      .toBe("final_answer");
  });

  it("extracts JSON after a <|channel|>-style token wrapper", () => {
    expect(tryParseJson('<|channel|>final<|message|>{"tool":"final_answer","content":"hi"}').tool)
      .toBe("final_answer");
  });

  it("finds a tool call embedded in surrounding prose via the balanced scan", () => {
    const text = 'Sure, here you go:\n{"tool":"execute_command","command":"ls -la"}\nHope that helps.';
    expect(tryParseJson(text)).toEqual({ tool: "execute_command", command: "ls -la" });
  });

  it("skips a leading non-tool object and finds the real call after it", () => {
    const text = '{"note":"thinking"} then {"tool":"read_terminal","lines":40}';
    expect(tryParseJson(text)).toEqual({ tool: "read_terminal", lines: 40 });
  });

  it("repairs trailing commas", () => {
    expect(tryParseJson('{"tool":"final_answer","content":"hi",}').tool).toBe("final_answer");
  });

  it("repairs bare newlines inside a write_file payload", () => {
    const raw = '{"tool":"write_file","path":"/tmp/a.py","content":"import os\nprint(1)"}';
    const parsed = tryParseJson(raw);
    expect(parsed.tool).toBe("write_file");
    expect(parsed.content).toBe("import os\nprint(1)");
  });

  it("returns null for prose containing no JSON at all", () => {
    expect(tryParseJson("I think we should look at the config file first.")).toBeNull();
  });

  it("returns null on an unbalanced brace rather than hanging", () => {
    expect(tryParseJson('{"tool":"execute_command","command":"ls"')).toBeNull();
  });
});

describe("coerceAction", () => {
  it("never turns attempted XML tool-call text into a final answer (log d3f522fd6d)", () => {
    const xml = '<tool_call>\n<function=search_dir>\n<parameter=path>\n"/tmp"\n</parameter>\n</function>\n</tool_call>';
    const out = coerceAction(null, xml);
    expect(out).not.toBeNull();
    expect(out.tool).toBe("search_dir");
    expect(out.tool).not.toBe("final_answer");
  });

  it("parses a bracket-style call rather than answering with it", () => {
    expect(coerceAction(null, "[read_terminal(lines=50)]"))
      .toEqual({ tool: "read_terminal", lines: 50 });
  });

  it("recovers an unclosed bracket call rather than answering with it", () => {
    // The bracket parser tolerates the missing "]", so this recovers as a
    // tool call. What matters is that it is never a final_answer.
    expect(coerceAction(null, "[write_file")).toEqual({ tool: "write_file" });
  });

  it("returns null for XML tool-call text naming an UNKNOWN tool", () => {
    // parseXmlToolCall declines (unknown tool), and looksLikeToolCallText then
    // blocks coercion — forcing a parse retry instead of a bogus "done".
    expect(coerceAction(null, "<tool_call>\n<function=bogus_tool>\n")).toBeNull();
    expect(coerceAction(null, "</parameter> stray fragment")).toBeNull();
  });

  it("routes plain prose to final_answer and questions to ask_question", () => {
    expect(coerceAction(null, "All three tests now pass.")).toEqual({
      tool: "final_answer", content: "All three tests now pass.",
    });
    expect(coerceAction(null, "Which port should I use?").tool).toBe("ask_question");
    expect(coerceAction(null, "what is the target directory").tool).toBe("ask_question");
  });

  it("refuses to answer with prose longer than 500 chars", () => {
    expect(coerceAction(null, "x".repeat(600))).toBeNull();
  });

  it("infers the tool from a tool-less object's distinctive key", () => {
    expect(coerceAction({ command: "ls" }, "").tool).toBe("execute_command");
    expect(coerceAction({ question: "which one?" }, "").tool).toBe("ask_question");
  });

  it("keeps existing content when promoting a content-only object to final_answer", () => {
    expect(coerceAction({ content: "Finished the migration." }, "")).toEqual({
      tool: "final_answer", content: "Finished the migration.",
    });
  });

  it("accepts the non-standard answer keys small models use", () => {
    for (const key of ["answer", "response", "text", "message", "result", "reply", "output"]) {
      const out = coerceAction({ [key]: "Done." }, "");
      expect(out.tool, key).toBe("final_answer");
      expect(out.content, key).toBe("Done.");
    }
  });

  it("routes an `error` field to a question or an answer depending on wording", () => {
    expect(coerceAction({ error: "Could you clarify the path?" }, "").tool).toBe("ask_question");
    expect(coerceAction({ error: "Disk full." }, "").tool).toBe("final_answer");
  });
});

describe("parseAction (full pipeline)", () => {
  it("prefers content over reasoning text", () => {
    expect(parseAction('{"tool":"execute_command","command":"ls"}', '{"tool":"final_answer","content":"no"}'))
      .toEqual({ tool: "execute_command", command: "ls" });
  });

  it("falls back to reasoning text when content has no tool call", () => {
    expect(parseAction("Let me check.", '{"tool":"read_terminal","lines":20}'))
      .toEqual({ tool: "read_terminal", lines: 20 });
  });

  it("passes a plan through untouched", () => {
    const out = parseAction('{"_plan":{"steps":["a","b"]}}');
    expect(out._plan).toEqual({ steps: ["a", "b"] });
  });

  it("recovers qwen's bare {todos:[...]} leak as todo_write (live 2026-08-15)", () => {
    const out = parseAction('{"todos":[{"content":"Read the config","status":"in_progress"}]}');
    expect(out.tool).toBe("todo_write");
    expect(out.todos).toHaveLength(1);
  });

  it("recovers a lone todo ITEM as a 1-item plan, never a final answer", () => {
    const out = parseAction('{"content":"Read the config","status":"in_progress"}');
    expect(out.tool).toBe("todo_write");
    expect(out.tool).not.toBe("final_answer");
  });

  it("returns null when nothing usable can be recovered", () => {
    expect(parseAction("")).toBeNull();
    expect(parseAction('{"tool":"execute_command"')).toBeNull();
  });
});
