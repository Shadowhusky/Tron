import { describe, it, expect } from "vitest";
import electronCore from "../../electron/ipc/cliAgentCore.ts?raw";
import serverCore from "../../server/handlers/cliAgentCore.ts?raw";
import electronProtocol from "../../electron/ipc/cliAgentProtocol.ts?raw";
import serverProtocol from "../../server/handlers/cliAgentProtocol.ts?raw";
import {
  buildClaudeArgs,
  buildCodexArgs,
  buildClaudeUserMessage,
  buildCompleteArgs,
  extractCompletion,
  JsonLineSplitter,
  parseClaudeAuth,
  parseCodexLogin,
  parseVersion,
  validateControlResponse,
  validateStartOptions,
} from "../../electron/ipc/cliAgentProtocol";

const UUID = "3b47dd9c-dbe3-47a7-a9a9-9ec2f3a84362";

describe("validateStartOptions", () => {
  const base = { runId: "r1", kind: "claude", prompt: "hi", cwd: "/tmp/x", mode: "default" };

  it("accepts a minimal claude run", () => {
    expect(validateStartOptions(base)).toMatchObject({ kind: "claude", prompt: "hi", cwd: "/tmp/x", mode: "default" });
  });

  it("rejects unknown kinds and modes that don't belong to the kind", () => {
    expect(() => validateStartOptions({ ...base, kind: "bash" })).toThrow();
    expect(() => validateStartOptions({ ...base, mode: "workspace-write" })).toThrow();
    expect(() => validateStartOptions({ ...base, kind: "codex", mode: "acceptEdits" })).toThrow();
  });

  it("rejects models that could smuggle flags", () => {
    expect(() => validateStartOptions({ ...base, model: "--dangerously-skip-permissions" })).toThrow();
    expect(() => validateStartOptions({ ...base, model: "sonnet; rm -rf ~" })).toThrow();
    expect(validateStartOptions({ ...base, model: "claude-sonnet-5-5[1m]" }).model).toBe("claude-sonnet-5-5[1m]");
  });

  it("only accepts uuid resume ids", () => {
    expect(validateStartOptions({ ...base, resumeId: UUID }).resumeId).toBe(UUID);
    expect(() => validateStartOptions({ ...base, resumeId: "--continue" })).toThrow();
  });

  it("requires an absolute cwd", () => {
    expect(() => validateStartOptions({ ...base, cwd: "relative/dir" })).toThrow();
    expect(validateStartOptions({ ...base, cwd: "C:\\code\\api" }).cwd).toBe("C:\\code\\api");
  });

  it("accepts only image attachments with a known media type", () => {
    const img = { base64: "aGk=", mediaType: "image/png" };
    expect(validateStartOptions({ ...base, images: [img] }).images).toEqual([img]);
    expect(() => validateStartOptions({ ...base, images: [{ base64: "aGk=", mediaType: "text/html" }] })).toThrow();
  });
});

describe("buildClaudeArgs", () => {
  it("runs headless stream-json with Tron answering permission prompts", () => {
    const args = buildClaudeArgs({ mode: "default" });
    expect(args.slice(0, 1)).toEqual(["-p"]);
    expect(args.join(" ")).toContain("--output-format stream-json --input-format stream-json --verbose");
    expect(args).toContain("--include-partial-messages");
    expect(args.join(" ")).toContain("--permission-prompt-tool stdio");
    expect(args.join(" ")).toContain("--permission-mode default");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--resume");
  });

  it("omits --model for the CLI default and passes others", () => {
    expect(buildClaudeArgs({ mode: "plan", model: "default" })).not.toContain("--model");
    expect(buildClaudeArgs({ mode: "plan", model: "sonnet" }).join(" ")).toContain("--model sonnet");
  });

  it("resumes a session", () => {
    expect(buildClaudeArgs({ mode: "acceptEdits", resumeId: UUID }).join(" ")).toContain(`--resume ${UUID}`);
  });
});

describe("buildCodexArgs", () => {
  it("runs exec --json with the sandbox and the prompt on stdin", () => {
    const args = buildCodexArgs({ mode: "workspace-write" });
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
    expect(args.join(" ")).toContain('-c sandbox_mode="workspace-write"');
    expect(args.slice(-2)).toEqual(["--", "-"]);
  });

  it("puts images and model before the end-of-options marker", () => {
    const args = buildCodexArgs({ mode: "read-only", model: "gpt-5", imagePaths: ["/tmp/a.png", "/tmp/b.png"] });
    const dash = args.indexOf("--");
    expect(args.indexOf("-m")).toBeLessThan(dash);
    expect(args.filter((a) => a === "--image")).toHaveLength(2);
    expect(args.lastIndexOf("--image")).toBeLessThan(dash);
  });

  it("resumes through the resume subcommand with the id after --", () => {
    const args = buildCodexArgs({ mode: "workspace-write", resumeId: UUID });
    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args.slice(-3)).toEqual(["--", UUID, "-"]);
  });
});

describe("buildClaudeUserMessage", () => {
  it("sends image blocks before the text", () => {
    const msg = buildClaudeUserMessage("look", [{ base64: "aGk=", mediaType: "image/png" }]);
    expect(msg.type).toBe("user");
    expect(msg.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "aGk=" } },
      { type: "text", text: "look" },
    ]);
  });
});

describe("validateControlResponse", () => {
  const allow = {
    type: "control_response",
    response: { subtype: "success", request_id: "abc", response: { behavior: "allow", updatedInput: { command: "ls" } } },
  };

  it("passes through an allow answer", () => {
    expect(validateControlResponse(allow)).toEqual(allow);
  });

  it("passes through a deny answer", () => {
    const deny = { type: "control_response", response: { subtype: "success", request_id: "abc", response: { behavior: "deny", message: "User denied" } } };
    expect(validateControlResponse(deny)).toEqual(deny);
  });

  it("rejects anything else — the renderer must not inject arbitrary stdin", () => {
    expect(validateControlResponse({ type: "user", message: { role: "user", content: "rm -rf" } })).toBeNull();
    expect(validateControlResponse({ ...allow, response: { ...allow.response, response: { behavior: "maybe" } } })).toBeNull();
    expect(validateControlResponse({ type: "control_request", request_id: "x", request: { subtype: "interrupt" } })).toBeNull();
  });

  it("strips unexpected keys", () => {
    const out = validateControlResponse({ ...allow, extra: 1, response: { ...allow.response, extra: 2 } });
    expect(out).toEqual(allow);
  });
});

describe("JsonLineSplitter", () => {
  it("parses JSON lines across chunk boundaries and skips non-JSON noise", () => {
    const s = new JsonLineSplitter();
    expect(s.push('rc noise\n{"a":')).toEqual([]);
    expect(s.push('1}\n{"b":2}\n{"c"')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(s.push(":3}\n")).toEqual([{ c: 3 }]);
  });

  it("flushes a final line without a newline", () => {
    const s = new JsonLineSplitter();
    s.push('{"x":1}');
    expect(s.flush()).toEqual([{ x: 1 }]);
  });
});

describe("detection parsing", () => {
  it("parses both CLIs' version output", () => {
    expect(parseVersion("2.1.294 (Claude Code)\n")).toBe("2.1.294");
    expect(parseVersion("codex-cli 0.160.1\n")).toBe("0.160.1");
    expect(parseVersion("garbage")).toBeNull();
  });

  it("reads claude auth status without exposing the account email", () => {
    const out = parseClaudeAuth(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "me@example.com" }));
    expect(out).toEqual({ loggedIn: true, authMethod: "claude.ai" });
    expect(parseClaudeAuth("not json")).toEqual({ loggedIn: false, authMethod: null });
  });

  it("reads codex login status", () => {
    expect(parseCodexLogin("Logged in using ChatGPT\n", 0)).toEqual({ loggedIn: true, authMethod: "ChatGPT" });
    expect(parseCodexLogin("Not logged in\n", 1)).toEqual({ loggedIn: false, authMethod: null });
  });
});

describe("one-shot completion", () => {
  it("runs claude tool-less, without user settings or session files", () => {
    const args = buildCompleteArgs("claude").join(" ");
    expect(args).toContain("-p --output-format json --model haiku");
    expect(args).toContain('--tools ');
    expect(buildCompleteArgs("claude")).toContain("");
    expect(args).toContain("--restricted");
    expect(args).toContain("--no-session-persistence");
  });

  it("runs codex read-only and ephemeral", () => {
    const args = buildCompleteArgs("codex");
    expect(args.join(" ")).toContain("exec --json --skip-git-repo-check -s read-only --ephemeral");
    expect(args.slice(-2)).toEqual(["--", "-"]);
  });

  it("extracts the answer text", () => {
    expect(extractCompletion("claude", JSON.stringify({ type: "result", result: " ls -la ", is_error: false }))).toBe("ls -la");
    const codex = [
      '{"type":"thread.started","thread_id":"x"}',
      '{"type":"item.completed","item":{"id":"i0","type":"agent_message","text":"first"}}',
      '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"final"}}',
      '{"type":"turn.completed"}',
    ].join("\n");
    expect(extractCompletion("codex", codex)).toBe("final");
    expect(extractCompletion("claude", JSON.stringify({ type: "result", result: "boom", is_error: true }))).toBeNull();
  });
});

describe("server mirror", () => {
  it("server/handlers keeps byte-identical copies of the CLI agent modules", () => {
    expect(serverProtocol).toBe(electronProtocol);
    expect(serverCore).toBe(electronCore);
  });
});
