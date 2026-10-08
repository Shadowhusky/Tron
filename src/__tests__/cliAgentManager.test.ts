import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliAgentManager, type CliRunEvent, type LoginEnv } from "../../electron/ipc/cliAgentCore";

// A fake `claude` / `codex` that speaks just enough of each protocol: the
// prompt picks the scenario, and it logs what it was started with.
const FAKE_CLI = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const log = (extra) => fs.writeFileSync("fake-log.json", JSON.stringify({ args, apiKey: process.env.ANTHROPIC_API_KEY ?? null, ...extra }));
let buf = "";
if (args[0] === "exec") {
  process.stdin.on("data", (d) => (buf += d));
  process.stdin.on("end", () => {
    const images = args.flatMap((a, i) => (a === "--image" ? [args[i + 1]] : []));
    log({ prompt: buf, images: images.map((p) => ({ p, exists: fs.existsSync(p), mode: fs.statSync(p).mode & 0o777 })) });
    out({ type: "thread.started", thread_id: "t-1" });
    if (buf.includes("hang")) return setInterval(() => {}, 1000);
    out({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "done" } });
    out({ type: "turn.completed", usage: {} });
  });
} else {
  process.stdin.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onMessage(JSON.parse(line));
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
function onMessage(m) {
  if (m.type === "control_request" && m.request.subtype === "initialize") {
    return out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: {} } });
  }
  if (m.type === "user") {
    const text = m.message.content.find((c) => c.type === "text").text;
    log({ prompt: text });
    out({ type: "system", subtype: "init", session_id: "s-1", model: "fake" });
    if (text.includes("hang")) return setInterval(() => {}, 1000);
    if (text.includes("permission")) {
      return out({ type: "control_request", request_id: "perm-1", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "/x" } } });
    }
    return out({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "s-1" });
  }
  if (m.type === "control_response" && m.response.request_id === "perm-1") {
    out({ type: "result", subtype: "success", is_error: false, result: "permission:" + m.response.response.behavior, session_id: "s-1" });
  }
}
`;

let dir = "";
let fake = "";
let savedConfigDir: string | undefined;
let savedApiKey: string | undefined;

const env = (): LoginEnv => ({
  path: process.env.PATH || "",
  bins: { claude: { path: fake, viaShell: false }, codex: { path: fake, viaShell: false } },
});

/** Start a run and collect its events until exit. */
function runToExit(m: CliAgentManager, opts: Record<string, unknown>, owner?: string, onEvent?: (ev: CliRunEvent) => void) {
  const events: CliRunEvent[] = [];
  const exited = new Promise<CliRunEvent[]>((resolve) => {
    m.start({ cwd: dir, mode: "default", ...opts }, (ev) => {
      events.push(ev);
      onEvent?.(ev);
      if (ev.exit !== undefined) resolve(events);
    }, owner).catch(() => resolve(events));
  });
  return exited;
}

const readLog = () => JSON.parse(fs.readFileSync(path.join(dir, "fake-log.json"), "utf8"));

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tron-cli-test-"));
  fake = path.join(dir, "fake-cli");
  fs.writeFileSync(fake, FAKE_CLI, { mode: 0o755 });
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.CLAUDE_CONFIG_DIR = dir; // no .claude.json → nothing is trusted
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-leak";
});

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("CliAgentManager with a fake CLI", () => {
  it("runs a claude turn to its result and exits cleanly", async () => {
    const m = new CliAgentManager(async () => env());
    const events = await runToExit(m, { runId: "c1", kind: "claude", prompt: "hello" });
    const types = events.flatMap((e) => (e.message ? [(e.message as { type: string }).type] : []));
    expect(types).toEqual(["control_response", "system", "result"]);
    expect(events.at(-1)?.exit).toBe(0);
  });

  it("skips project settings in an untrusted folder, says so, and never leaks API keys", async () => {
    const m = new CliAgentManager(async () => env());
    const events = await runToExit(m, { runId: "c2", kind: "claude", prompt: "hello" });
    const log = readLog();
    expect(log.args.join(" ")).toContain("--setting-sources user");
    expect(log.apiKey).toBeNull();
    expect(events.some((e) => e.notice?.includes("isn't trusted"))).toBe(true);
  });

  it("loads project settings once Claude Code trusts the folder", async () => {
    fs.writeFileSync(path.join(dir, ".claude.json"), JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } }));
    try {
      const m = new CliAgentManager(async () => env());
      const events = await runToExit(m, { runId: "c3", kind: "claude", prompt: "hello" });
      expect(readLog().args).not.toContain("--setting-sources");
      expect(events.some((e) => e.notice)).toBe(false);
    } finally {
      fs.rmSync(path.join(dir, ".claude.json"));
    }
  });

  it("delivers a validated permission answer to the CLI", async () => {
    const m = new CliAgentManager(async () => env());
    const events = await runToExit(m, { runId: "c4", kind: "claude", prompt: "permission please" }, undefined, (ev) => {
      const msg = ev.message as { type?: string; request_id?: string } | undefined;
      if (msg?.type === "control_request") {
        m.respond({
          runId: "c4",
          response: { type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { behavior: "deny", message: "no" } } },
        });
      }
    });
    const result = events.find((e) => (e.message as { type?: string })?.type === "result")?.message as { result: string };
    expect(result.result).toBe("permission:deny");
  });

  it("stops a running turn", async () => {
    const m = new CliAgentManager(async () => env());
    const events = await runToExit(m, { runId: "c5", kind: "claude", prompt: "hang" }, undefined, (ev) => {
      if ((ev.message as { type?: string })?.type === "system") expect(m.stop("c5")).toBe(true);
    });
    expect(events.at(-1)?.exit).not.toBe(0);
    expect(m.respond({ runId: "c5", response: {} })).toBe(false);
  });

  it("cancels a run stopped before it has even spawned", async () => {
    fs.rmSync(path.join(dir, "fake-log.json"), { force: true });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const m = new CliAgentManager(async () => {
      await gate;
      return env();
    });
    const exited = runToExit(m, { runId: "c6", kind: "claude", prompt: "hello" });
    expect(m.stop("c6")).toBe(true);
    release();
    const events = await exited;
    expect(events).toEqual([{ runId: "c6", exit: null, stderrTail: "" }]);
    expect(fs.existsSync(path.join(dir, "fake-log.json"))).toBe(false);
  });

  it("writes codex images to a private temp dir and removes it afterwards", async () => {
    const m = new CliAgentManager(async () => env());
    const img = { base64: Buffer.from("png").toString("base64"), mediaType: "image/png" };
    await runToExit(m, { runId: "x1", kind: "codex", mode: "read-only", prompt: "look", images: [img] });
    const [image] = readLog().images;
    expect(image.exists).toBe(true);
    expect(image.mode).toBe(0o600);
    expect(fs.existsSync(path.dirname(image.p))).toBe(false);
  });

  it("stopAll(owner) only stops that owner's runs", async () => {
    const m = new CliAgentManager(async () => env());
    let started = 0;
    let bothStarted!: () => void;
    const ready = new Promise<void>((r) => (bothStarted = r));
    const onEvent = (ev: CliRunEvent) => {
      if ((ev.message as { type?: string })?.type === "system" && ++started === 2) bothStarted();
    };
    const a = runToExit(m, { runId: "a1", kind: "claude", prompt: "hang" }, "A", onEvent);
    const b = runToExit(m, { runId: "b1", kind: "claude", prompt: "hang" }, "B", onEvent);
    await ready;
    m.stopAll("A");
    await a;
    expect(m.stop("b1")).toBe(true); // B was still running
    await b;
  });

  it("explains a missing working directory instead of a spawn ENOENT", async () => {
    const m = new CliAgentManager(async () => env());
    await expect(
      m.start({ runId: "m1", kind: "claude", prompt: "x", cwd: path.join(dir, "gone"), mode: "default" }, () => {}),
    ).rejects.toThrow(/folder doesn't exist/);
  });

  it("re-resolves a CLI that was missing (installed after Tron started)", async () => {
    let calls = 0;
    const m = new CliAgentManager(async () => {
      calls++;
      return calls === 1 ? { path: "", bins: { claude: null, codex: null } } : env();
    });
    expect((await m.detect()).claude).toBeNull();
    const again = await m.detect(true);
    expect(again.claude?.path).toBe(fake);
  });
});
