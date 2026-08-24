import { describe, it, expect } from "vitest";
import { aiService } from "../services/ai/index";
import type { AIConfig } from "../types";
import { AGENT_TOOLS } from "../services/ai/toolSchemas";

const AGENT_TOOL_COUNT = AGENT_TOOLS.length;

/**
 * End-to-end harness for `runAgent` with a scripted fake model. Stubs the
 * OpenAI-compatible stream (lmstudio provider) and the loop arbiter so the
 * whole guard/loop machinery runs for real against deterministic replies.
 * Every scenario here previously spun to `maxSteps` (fd5977963a.json).
 */
type Reply = string | Error;
type Msg = { role: string; content: unknown };
/** The two private LLM round-trips runAgent makes; stubbed per scenario. */
type OnToken = (token: string, thinking?: string) => void;
type Stubbable = {
  streamOpenAIChat: (
    provider: string, model: string, apiKey: string, messages: Msg[], onToken?: OnToken,
  ) => Promise<{ content: string; thinking: string }>;
  arbitrateAgentLoop: () => Promise<{ stuck: boolean; suggestion: string }>;
  markModelAsThinking: (provider: string, model: string) => void;
};
const svc = aiService as unknown as Stubbable;

const MAX_STEPS = 80;
const CFG: AIConfig = {
  provider: "lmstudio",
  model: "fake",
  baseUrl: "http://localhost:1234",
  maxAgentSteps: MAX_STEPS,
};

const TASK = "Create a flappy bird game on desktop and run it";
const FA_ECHO = '{"tool":"final_answer","content":"(API error)"}';
const FA_LAZY = '{"tool":"final_answer","content":"Done."}';
const LS = '{"tool":"execute_command","command":"ls"}';
const API_ERR = () => new Error("API Error: Engine protocol predict failed");
const exec = (cmd: string) => `{"tool":"execute_command","command":"${cmd}"}`;

let arbiterCalls = 0;

function scriptModel(replies: Reply[], arbiterStuck = true) {
  let calls = 0;
  svc.streamOpenAIChat = async () => {
    const r = replies[Math.min(calls, replies.length - 1)];
    calls++;
    if (r instanceof Error) throw r;
    return { content: r, thinking: "" };
  };
  arbiterCalls = 0;
  svc.arbitrateAgentLoop = async () => {
    arbiterCalls++;
    return { stuck: arbiterStuck, suggestion: "Try something else." };
  };
  return () => calls;
}

async function run(
  prompt = TASK,
  execImpl: (cmd: string) => Promise<string> = async () => "",
  thinkingEnabled = false,
) {
  const steps: Array<{ step: string; output: string }> = [];
  const result = await aiService.runAgent(
    prompt,
    execImpl,
    () => {},
    async () => "richardliao@mac ~ % ",
    (step, output) => steps.push({ step, output }),
    CFG,
    undefined,
    thinkingEnabled,
    undefined,
    undefined,
    { rawUserTask: prompt },
  );
  return { result, steps };
}

describe("runAgent — API errors", () => {
  it("replays log fd5977963a: fails fast with the provider error instead of spinning BLOCKED", async () => {
    // Two engine errors, echoed final_answer, error, echo, error, echo forever.
    const calls = scriptModel([
      API_ERR(), API_ERR(), FA_ECHO,
      API_ERR(), FA_ECHO,
      API_ERR(), FA_ECHO,
      FA_ECHO,
    ]);
    const { result } = await run();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Engine protocol predict/);
    // err, err, echo(rejected), err → 3rd API error terminates.
    expect(calls()).toBe(4);
  });

  it("switches a model to native tool declarations on the first peg-native error, then retries with tools", async () => {
    const peg = () => new Error('API Error: Engine protocol predict stream returned an error: {"code":500,"message":"The model produced output that does not match the expected peg-native format","type":"server_error"}');
    const toolsSeen: Array<number | undefined> = [];
    const marked: string[] = [];
    const svcX = svc as unknown as { markModelNeedsNativeTools: (p: string, m: string) => void; isNativeToolsModel: (p: string, m: string) => boolean };
    const origMark = svcX.markModelNeedsNativeTools, origIs = svcX.isNativeToolsModel;
    svcX.markModelNeedsNativeTools = (p, m) => { marked.push(`${p}:${m}`); };
    svcX.isNativeToolsModel = () => false;
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    let n = 0;
    (svc as unknown as { streamOpenAIChat: (...a: unknown[]) => Promise<unknown> }).streamOpenAIChat = async (...a: unknown[]) => {
      toolsSeen.push((a[9] as unknown[] | undefined)?.length);
      n++;
      if (n === 1) throw peg(); // native call rejected: no tools declared yet
      // With tools declared the server hands back the call as agent JSON.
      if (n === 2) return { content: exec("echo hi"), thinking: "" };
      return { content: '{"tool":"final_answer","content":"Printed hi."}', thinking: "" };
    };
    const { result, steps } = await run("print hi", async () => "hi");
    expect(result.success).toBe(true);
    expect(toolsSeen).toEqual([undefined, AGENT_TOOL_COUNT, AGENT_TOOL_COUNT]);
    expect(marked).toEqual(["lmstudio:fake"]);
    expect(steps.some((s) => s.step === "failed" && /switching to native tool declarations/.test(s.output))).toBe(true);
    svcX.markModelNeedsNativeTools = origMark; svcX.isNativeToolsModel = origIs;
  });

  it("still gives up (with a hint) when the parse error persists even with tools declared", async () => {
    const peg = () => new Error('API Error: Engine protocol predict stream returned an error: {"code":500,"message":"The model produced output that does not match the expected peg-native format","type":"server_error"}');
    const svcX = svc as unknown as { markModelNeedsNativeTools: (p: string, m: string) => void; isNativeToolsModel: (p: string, m: string) => boolean };
    const origMark = svcX.markModelNeedsNativeTools, origIs = svcX.isNativeToolsModel;
    svcX.markModelNeedsNativeTools = () => {}; svcX.isNativeToolsModel = () => false;
    const calls = scriptModel([peg(), peg(), peg(), peg()]);
    const { result, steps } = await run();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/even with tools declared/);
    // 1 mode-switch attempt (not counted) + 3 counted API errors.
    expect(calls()).toBe(4);
    const retries = steps.filter((s) => s.step === "failed" && /retrying \(\d\/3\)/.test(s.output));
    expect(retries.length).toBe(2);
    svcX.markModelNeedsNativeTools = origMark; svcX.isNativeToolsModel = origIs;
  });

  it("does not let a bogus echoed parse reset the API-error counter", async () => {
    const calls = scriptModel([
      API_ERR(), FA_ECHO, API_ERR(), FA_ECHO, API_ERR(), FA_ECHO,
      API_ERR(), FA_ECHO, API_ERR(), FA_ECHO, API_ERR(), FA_ECHO,
    ]);
    const { result } = await run();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Engine protocol predict/);
    expect(calls()).toBe(5);
  });

  it("never pushes an '(API error)' turn into history for the model to echo", async () => {
    let seenPlaceholder = false;
    let n = 0;
    let done = false;
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    // Two errors, then a real command, then a final answer.
    svc.streamOpenAIChat = async (_p, _m, _k, messages) => {
      if (messages.some((m) => m.content === "(API error)" || /Error from API/.test(String(m.content)))) {
        seenPlaceholder = true;
      }
      n++;
      if (n <= 2) throw API_ERR();
      if (!done) { done = true; return { content: exec("echo hi"), thinking: "" }; }
      return { content: '{"tool":"final_answer","content":"Printed hi."}', thinking: "" };
    };
    const { result } = await run("print hi", async () => "hi");
    expect(seenPlaceholder).toBe(false);
    expect(result.success).toBe(true);
  });

  it("fails immediately on a context-overflow error instead of retrying it 3×", async () => {
    const calls = scriptModel([
      new Error('API Error: Engine protocol predict stream returned an error: {"code":500,"message":"Context size has been exceeded."}'),
    ]);
    const { result } = await run();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/context window/);
    expect(calls()).toBe(1);
  });

  it("intermittent API errors in a productive run do not accumulate to a failure", async () => {
    // err, cmd, err, cmd, err, cmd, err, cmd, final — 4 errors total but never 3 in a row.
    scriptModel([
      API_ERR(), exec("echo 1"),
      API_ERR(), exec("echo 2"),
      API_ERR(), exec("echo 3"),
      API_ERR(), exec("echo 4"),
      '{"tool":"final_answer","content":"Ran echo 1 through 4; all printed."}',
    ], false);
    const { result } = await run("run echo 1..4", async (c) => c.replace("echo ", ""));
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/echo 1 through 4/);
  });
});

describe("runAgent — final_answer / ask_question bounced by guards", () => {
  it("stops after the rejection cap and reports failure when no work was done", async () => {
    const calls = scriptModel([FA_LAZY]);
    const { result } = await run();
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/without doing any work/);
    expect(result.message).toContain("Done.");
    // 3 rejected attempts, 4th force-resolves.
    expect(calls()).toBe(4);
  });

  it("surfaces the model's answer after the cap when real work WAS done", async () => {
    // Runs a command, then keeps giving an answer the guards dislike
    // ("run X yourself" → REJECTED "Do NOT tell the user to run commands").
    const stubborn = '{"tool":"final_answer","content":"Please run npm start to launch it."}';
    const calls = scriptModel([exec("ls"), stubborn], false);
    const { result } = await run(TASK, async () => "index.html");
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/npm start/);
    expect(calls()).toBeLessThanOrEqual(6);
  });

  it("lets a repeatedly-rejected ask_question through after the cap", async () => {
    const ask = '{"tool":"ask_question","question":"Where should the game live?"}';
    const calls = scriptModel([ask]);
    const { result } = await run();
    expect(result.type).toBe("question");
    expect(calls()).toBe(4);
  });

  it("never runs loop detection (arbiter) for a repeated final_answer", async () => {
    scriptModel([FA_LAZY]);
    await run();
    expect(arbiterCalls).toBe(0);
  });
});

describe("runAgent — loop-blocked action re-emitted forever", () => {
  it("escalates to the user after 3 BLOCKED repeats instead of spinning to maxSteps", async () => {
    const calls = scriptModel([LS]);
    const { result } = await run(TASK, async () => "a b c");
    // 1: runs; 2: arbiter → LOOP DETECTED; 3,4: BLOCKED; 5: bounded → escalate.
    expect(result.type).toBe("question");
    expect(result.message).toMatch(/stuck repeating/);
    expect(calls()).toBe(5);
    expect(calls()).toBeLessThan(MAX_STEPS);
  });
});

describe("runAgent — circuit breaker", () => {
  it("escalates after repeated trips with no successful action in between", async () => {
    // Ten distinct guard-blocked commands (recursive ls without a target) — no
    // exact repetition, so only the guard counter can bound this.
    const cmds = ["ls -R .", "ls -R ..", "ls -R ~", "ls -R /", "ls -Ra .",
      "ls -Rl .", "ls -Rla .", "ls -Ral ..", "ls -Rl ~", "ls -Rl /"];
    const calls = scriptModel(cmds.map(exec), false);
    const { result } = await run(TASK);
    expect(result.type).toBe("question");
    expect(result.message).toMatch(/blocked actions/);
    // 3 blocks → trip 1 (reset), 3 → trip 2, 3 → trip 3 → escalate.
    expect(calls()).toBe(9);
  });

  it("a successful action between trips resets the trip count", async () => {
    const blocked = ["ls -R .", "ls -R ..", "ls -R ~", "ls -R /", "ls -Ra .", "ls -Rl ."];
    const replies = [
      ...blocked.slice(0, 3).map(exec), exec("echo ok"),
      ...blocked.slice(3, 6).map(exec), exec("echo ok2"),
      ...["ls -Rla .", "ls -Ral ..", "ls -Rl ~"].map(exec),
      '{"tool":"final_answer","content":"Listed what I could; done."}',
    ];
    scriptModel(replies, false);
    const { result } = await run(TASK, async () => "ok");
    // Never 3 consecutive trips → reaches the final answer normally.
    expect(result.type).toBe("success");
    expect(result.message).toMatch(/Listed what I could/);
  });
});

describe("runAgent — exhausted action shape re-tried with variations", () => {
  it("escalates instead of re-emitting STOP forever once the cumulative cap is crossed", async () => {
    // 40 distinct commands sharing a >50-char prefix → same coarse shape,
    // different exact keys, all succeed. Only the cumulative cap sees this.
    const prefix = "echo " + "a".repeat(60);
    const cmds = Array.from({ length: 40 }, (_, i) => exec(`${prefix}${i}`));
    const calls = scriptModel(cmds, false);
    const { result } = await run("print some a's", async () => "aaa");
    expect(result.type).toBe("question");
    // cap (12) + a few post-cap repeats — far short of the 40 the model would emit.
    expect(calls()).toBeLessThanOrEqual(16);
  });
});

describe("runAgent — reasoning models the app didn't know about", () => {
  it("streams reasoning_content live and marks the model as thinking even with the toggle off (log 52e887da4e)", async () => {
    const marked: string[] = [];
    const origMark = svc.markModelAsThinking;
    svc.markModelAsThinking = (p, m) => { marked.push(`${p}:${m}`); };
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    let n = 0;
    svc.streamOpenAIChat = async (_p, _m, _k, _msgs, onToken) => {
      n++;
      if (n === 1) {
        // Harmony-style model: a long analysis phase before any content.
        for (const piece of ["We need", " a plan.", " Use write_file."]) onToken?.("", piece);
        onToken?.(exec("echo hi"));
        return { content: exec("echo hi"), thinking: "We need a plan. Use write_file." };
      }
      return { content: '{"tool":"final_answer","content":"Printed hi."}', thinking: "" };
    };
    const { result, steps } = await run("print hi", async () => "hi", false);
    expect(result.success).toBe(true);
    const thinkingStreams = steps.filter((s) => s.step === "streaming_thinking").map((s) => s.output);
    expect(thinkingStreams.length).toBeGreaterThan(0);
    expect(thinkingStreams.at(-1)).toBe("We need a plan. Use write_file.");
    // Reasoning is also captured/logged, not dropped, when the toggle is off.
    expect(steps.some((s) => s.step === "thinking_complete")).toBe(true);
    expect(marked).toEqual(["lmstudio:fake"]);
    svc.markModelAsThinking = origMark;
  });

  it("retracts a half-finished thinking entry when the attempt dies mid-stream — and only then", async () => {
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    let n = 0;
    svc.streamOpenAIChat = async (_p, _m, _k, _msgs, onToken) => {
      n++;
      if (n === 1) { onToken?.("", "Let me think"); throw API_ERR(); } // reasoning, then engine error
      if (n === 2) throw API_ERR(); // error before any token
      return { content: '{"tool":"final_answer","content":"Nothing to do."}', thinking: "" };
    };
    const { steps } = await run("say hi", async () => "", false);
    const kinds = steps.map((s) => s.step).filter((k) => ["streaming_thinking", "retract_thought", "failed"].includes(k));
    // attempt 1: streamed → retracted → failed(retry 1); attempt 2: no stream → no retract → failed(retry 2)
    expect(kinds).toEqual(["streaming_thinking", "retract_thought", "failed", "failed"]);
  });
});

describe("runAgent — bare tool arguments from tool-trained models (qwen live 2026-08-15)", () => {
  // qwen3.8-27b streams its native function-call ARGUMENTS as the message text,
  // with no {"tool":...} wrapper. Previously: {"todos":[...]} was unparseable
  // (5 silent retries per step) and a lone todo item was coerced into a bogus
  // final_answer that the completion guards rejected forever.
  const BARE_TODOS =
    '{"todos":[{"content":"Create a self-contained HTML Flappy Bird game","status":"in_progress"},' +
    '{"content":"Verify the file was written correctly","status":"pending"},' +
    '{"content":"Open it in the default browser","status":"pending"}]}';

  it("dispatches a bare {todos:[...]} as todo_write with zero parse retries", async () => {
    const calls = scriptModel([
      BARE_TODOS,
      exec("touch /tmp/flappy.html"),
      '{"tool":"final_answer","content":"Created the game and opened it."}',
    ], false);
    const { result, steps } = await run(TASK, async () => "");
    expect(result.success).toBe(true);
    const plan = steps.find((s) => s.step === "plan");
    expect(plan?.output).toContain("Create a self-contained HTML Flappy Bird game");
    // One call per scripted reply — a parse failure would have re-called the model.
    expect(calls()).toBe(3);
    expect(steps.filter((s) => s.step === "retract_thought")).toHaveLength(0);
  });

  it("treats a lone todo ITEM as a plan fragment, not a bogus final_answer", async () => {
    // Old behavior: {"content":...,"status":"in_progress"} → final_answer with
    // no work done → rejected 3× → run fails. New: 1-item todo_write (the
    // dispatcher rejects it as noise with guidance) and the run recovers.
    const calls = scriptModel([
      '{"content":"Create flappy bird HTML game file","status":"in_progress"}',
      exec("touch /tmp/flappy.html"),
      '{"tool":"final_answer","content":"Created the file."}',
    ], false);
    const { result } = await run(TASK, async () => "");
    expect(result.success).toBe(true);
    expect(calls()).toBe(3);
  });

  it("still lets a bare {content} object surface as an answer", async () => {
    const calls = scriptModel([
      exec("echo hi"),
      '{"content":"Ran echo; it printed hi."}',
    ], false);
    const { result } = await run("print hi", async () => "hi");
    expect(result.success).toBe(true);
    expect(result.message).toBe("Ran echo; it printed hi.");
    expect(calls()).toBe(2);
  });
});

describe("runAgent — mid-run steering", () => {
  it("injects posted steering messages before the next LLM call and emits a steered step", async () => {
    const SID = "sess-steer-test";
    let calls = 0;
    let steeredTurn: string | null = null;
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    (svc as unknown as { streamOpenAIChat: (...a: unknown[]) => Promise<unknown> }).streamOpenAIChat = async (...a: unknown[]) => {
      const messages = a[3] as Msg[];
      calls++;
      if (calls === 1) {
        // User steers while the model is "working" on the first step
        aiService.postSteeringMessage(SID, "Actually make the bird blue");
        return { content: exec("echo hi"), thinking: "" };
      }
      const injected = messages.find(
        (m) => m.role === "user" && String(m.content).includes("Actually make the bird blue"),
      );
      steeredTurn = injected ? String(injected.content) : null;
      return { content: '{"tool":"final_answer","content":"Done — blue bird."}', thinking: "" };
    };

    const steps: Array<{ step: string; output: string }> = [];
    const result = await aiService.runAgent(
      "make a flappy bird game",
      async () => "hi",
      () => {},
      async () => "richardliao@mac ~ % ",
      (step, output) => steps.push({ step, output }),
      CFG,
      undefined,
      false,
      undefined,
      undefined,
      { rawUserTask: "make a flappy bird game", sessionId: SID },
    );
    expect(result.success).toBe(true);
    expect(steeredTurn).toContain("[USER UPDATE");
    expect(steps.some((s) => s.step === "steered" && s.output === "Actually make the bird blue")).toBe(true);
  });

  it("takeSteeringMessages drains once and stale messages are cleared at run start", async () => {
    const SID = "sess-steer-stale";
    aiService.postSteeringMessage(SID, "late message");
    expect(aiService.takeSteeringMessages(SID)).toEqual(["late message"]);
    expect(aiService.takeSteeringMessages(SID)).toEqual([]);

    // A message left over from a dead run must not leak into the next run
    aiService.postSteeringMessage(SID, "stale from previous run");
    const calls = scriptModel(['{"tool":"final_answer","content":"Quick answer to a question."}'], false);
    const steps: Array<{ step: string; output: string }> = [];
    await aiService.runAgent(
      "just answer: what is 2+2?",
      async () => "",
      () => {},
      async () => "richardliao@mac ~ % ",
      (step, output) => steps.push({ step, output }),
      CFG,
      undefined,
      false,
      undefined,
      undefined,
      { rawUserTask: "just answer: what is 2+2?", sessionId: SID },
    );
    expect(calls()).toBeGreaterThan(0);
    expect(steps.some((s) => s.step === "steered")).toBe(false);
  });
});

describe("runAgent — XML tool calls in plain text (log d3f522fd6d)", () => {
  it("dispatches a Hermes-style XML tool call instead of ending 'done' with raw XML", async () => {
    const XML_CALL =
      "<tool_call>\n<function=execute_command>\n<parameter=command>\necho hi\n</parameter>\n</function>\n</tool_call>";
    const executed: string[] = [];
    const calls = scriptModel([
      XML_CALL,
      '{"tool":"final_answer","content":"Printed hi."}',
    ], false);
    const { result, steps } = await run("print hi", async (cmd) => {
      executed.push(cmd);
      return "hi";
    });
    expect(result.success).toBe(true);
    expect(result.message).toBe("Printed hi.");
    expect(executed).toContain("echo hi");
    // The XML must never surface as a completion answer
    expect(steps.some((s) => s.step === "done" && s.output.includes("<tool_call>"))).toBe(false);
    expect(calls()).toBe(2);
  });

  it("retries instead of answering when tool-call-like text is malformed beyond parsing", async () => {
    // Unknown tool name → XML parse fails → must NOT be coerced into final_answer
    const BAD_XML = "<tool_call>\n<function=do_magic>\n<parameter=x>\n1\n</parameter>\n</tool_call>";
    const calls = scriptModel([
      BAD_XML,
      exec("echo ok"),
      '{"tool":"final_answer","content":"Ran it."}',
    ], false);
    const { result, steps } = await run("do the thing", async () => "ok");
    expect(result.success).toBe(true);
    expect(steps.some((s) => s.step === "done" && s.output.includes("<tool_call>"))).toBe(false);
    expect(calls()).toBe(3); // one silent retry, then real work
  });
});

describe("runAgent — planning is no longer forced (log 39172cb246)", () => {
  it("does not demand a plan during ordinary multi-step work", async () => {
    // Six substantive tool calls, no todo_write. The old loop injected
    // "[plan check] … Your NEXT response MUST be a todo_write call" at 5
    // steps, which is what turned small tasks into 4-item checklists.
    const pushed: string[] = [];
    let n = 0;
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    (svc as unknown as { streamOpenAIChat: (...a: unknown[]) => Promise<unknown> }).streamOpenAIChat =
      async (...a: unknown[]) => {
        for (const m of a[3] as Msg[]) {
          if (m.role === "user") pushed.push(String(m.content));
        }
        n++;
        if (n <= 6) return { content: exec(`echo step${n}`), thinking: "" };
        return { content: '{"tool":"final_answer","content":"Done."}', thinking: "" };
      };
    const { result } = await run("do a few things", async () => "ok");
    expect(result.success).toBe(true);
    expect(pushed.some((m) => m.includes("[plan check]"))).toBe(false);
    expect(pushed.some((m) => /NEXT response MUST be a todo_write/i.test(m))).toBe(false);
  });

  it("offers — never demands — a course correction on a genuinely long run", async () => {
    const pushed: string[] = [];
    let n = 0;
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    (svc as unknown as { streamOpenAIChat: (...a: unknown[]) => Promise<unknown> }).streamOpenAIChat =
      async (...a: unknown[]) => {
        for (const m of a[3] as Msg[]) {
          if (m.role === "user") pushed.push(String(m.content));
        }
        n++;
        if (n <= 14) return { content: exec(`echo s${n}`), thinking: "" };
        return { content: '{"tool":"final_answer","content":"Done."}', thinking: "" };
      };
    const { result } = await run("a genuinely long task", async () => "ok");
    expect(result.success).toBe(true);
    const checkIn = pushed.find((m) => m.includes("[check-in]"));
    expect(checkIn).toBeTruthy();
    // Advisory, not an order — and it must offer answering as an option.
    expect(checkIn).toMatch(/just carry on/i);
    expect(checkIn).not.toMatch(/MUST/);
  });

  it("tells a 1-item plan to just do the work, without inviting padding to 3", async () => {
    const pushed: string[] = [];
    let n = 0;
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    (svc as unknown as { streamOpenAIChat: (...a: unknown[]) => Promise<unknown> }).streamOpenAIChat =
      async (...a: unknown[]) => {
        for (const m of a[3] as Msg[]) {
          if (m.role === "user") pushed.push(String(m.content));
        }
        n++;
        if (n === 1) {
          return { content: '{"tool":"todo_write","todos":[{"content":"Check the weather","status":"in_progress"}]}', thinking: "" };
        }
        if (n === 2) return { content: exec("curl wttr.in"), thinking: "" };
        return { content: '{"tool":"final_answer","content":"It is sunny."}', thinking: "" };
      };
    const { result } = await run("whats todays weather", async () => "sunny");
    expect(result.success).toBe(true);
    const msg = pushed.find((m) => m.includes("1-item plan"));
    expect(msg).toBeTruthy();
    expect(msg).toMatch(/just do/i);
    expect(msg).toMatch(/do not pad/i);
  });
});

describe("runAgent — blocked web search (log 39172cb246)", () => {
  it("stops searching and is pointed at web_fetch when every backend is blocked", async () => {
    const prevWindow = (globalThis as Record<string, unknown>).window;
    const searched: string[] = [];
    (globalThis as Record<string, unknown>).window = {
      dispatchEvent() {},
      electron: {
        ipcRenderer: {
          invoke: async (channel: string, arg: { query?: string }) => {
            if (channel === "web.search") {
              searched.push(arg.query || "");
              // Every backend rate-limited — the live 2026-08-18 state.
              return { results: [], failure: "blocked", error: "All search backends are rate-limited or blocked." };
            }
            if (channel === "web.fetch") {
              return { content: '{"current_condition":[{"temp_C":"23","weatherDesc":[{"value":"Overcast"}]}]}' };
            }
            return {};
          },
        },
      },
    };
    try {
      const pushed: string[] = [];
      let n = 0;
      svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
      (svc as unknown as { streamOpenAIChat: (...a: unknown[]) => Promise<unknown> }).streamOpenAIChat =
        async (...a: unknown[]) => {
          for (const m of a[3] as Msg[]) {
            if (m.role === "user") pushed.push(String(m.content));
          }
          n++;
          if (n === 1) return { content: '{"tool":"web_search","query":"london weather today"}', thinking: "" };
          // The desired reaction: give up on search, fetch a known URL.
          if (n === 2) return { content: '{"tool":"web_fetch","url":"https://wttr.in/?format=j1"}', thinking: "" };
          return { content: '{"tool":"final_answer","content":"Overcast, 23C."}', thinking: "" };
        };
      const { result, steps } = await run("whats todays weather", async () => "");
      expect(result.success).toBe(true);
      expect(searched).toEqual(["london weather today"]);

      const guidance = pushed.find((m) => m.includes("UNAVAILABLE"));
      expect(guidance).toBeTruthy();
      // The old code told it to reformulate — that's what burned two turns.
      expect(guidance).not.toMatch(/Reformulate/i);
      expect(guidance).toMatch(/web_fetch/);
      // The UI must not claim "no results" when the service is down.
      expect(steps.some((s) => /Web search unavailable/.test(s.output))).toBe(true);
      expect(steps.some((s) => /no results for/.test(s.output))).toBe(false);
    } finally {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  });
});

describe("runAgent — a malformed tool call must not kill the run (log ddb57d1bbd)", () => {
  it("recovers when execute_command arrives with no command field", async () => {
    // Live crash: qwen3.8 emitted execute_command without `command`, and
    // `action.command.split(/;|&&/)` threw
    // "Cannot read properties of undefined (reading 'split')".
    // The throw escaped runAgent entirely, so the whole run ended after a
    // single successful step.
    const executed: string[] = [];
    let n = 0;
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    (svc as unknown as { streamOpenAIChat: (...a: unknown[]) => Promise<unknown> }).streamOpenAIChat =
      async () => {
        n++;
        if (n === 1) return { content: exec("which cargo"), thinking: "" };
        if (n === 2) return { content: '{"tool":"execute_command"}', thinking: "" };
        if (n === 3) return { content: exec("which brew"), thinking: "" };
        return { content: '{"tool":"final_answer","content":"Toolchain checked."}', thinking: "" };
      };
    const { result, steps } = await run("check the toolchain", async (cmd) => {
      executed.push(cmd);
      return "not found";
    });

    // The run must survive and finish.
    expect(result.success).toBe(true);
    expect(result.message).toBe("Toolchain checked.");
    // It must keep working AFTER the malformed call, not stop at step 1.
    expect(executed).toEqual(["which cargo", "which brew"]);
    // And it must never surface a raw JS TypeError to the user.
    expect(steps.some((s) => /Cannot read properties of undefined/.test(s.output))).toBe(false);
  });

  it("recovers when run_in_terminal arrives with no command field", async () => {
    let n = 0;
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    (svc as unknown as { streamOpenAIChat: (...a: unknown[]) => Promise<unknown> }).streamOpenAIChat =
      async () => {
        n++;
        if (n === 1) return { content: '{"tool":"run_in_terminal"}', thinking: "" };
        if (n === 2) return { content: exec("echo ok"), thinking: "" };
        return { content: '{"tool":"final_answer","content":"Done."}', thinking: "" };
      };
    const { result } = await run("do a thing", async () => "ok");
    expect(result.success).toBe(true);
  });

  it("tells the model exactly which argument was missing", async () => {
    const pushed: string[] = [];
    let n = 0;
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    (svc as unknown as { streamOpenAIChat: (...a: unknown[]) => Promise<unknown> }).streamOpenAIChat =
      async (...a: unknown[]) => {
        for (const m of a[3] as Msg[]) if (m.role === "user") pushed.push(String(m.content));
        n++;
        if (n === 1) return { content: '{"tool":"write_file","path":"/tmp/x.txt"}', thinking: "" };
        return { content: '{"tool":"final_answer","content":"ok"}', thinking: "" };
      };
    await run("write a file", async () => "");
    const err = pushed.find((m) => m.includes("tool_use_error"));
    expect(err).toBeTruthy();
    expect(err).toMatch(/content/);
  });
});

describe("runAgent — per-step error boundary", () => {
  /** readTerminal throws on the first N calls, then behaves. execute_command
   *  reads terminal state internally, so this injects an unexpected throw on
   *  a path that has no inner try — exactly where log ddb57d1bbd died. */
  function runWithFlakyRead(replies: string[], failFirst: number) {
    let n = 0;
    let reads = 0;
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    (svc as unknown as { streamOpenAIChat: (...a: unknown[]) => Promise<unknown> }).streamOpenAIChat =
      async () => ({ content: replies[Math.min(n++, replies.length - 1)], thinking: "" });
    const steps: Array<{ step: string; output: string }> = [];
    return aiService
      .runAgent(
        "check things then finish",
        async () => "ok",
        () => {},
        async () => {
          reads++;
          if (reads <= failFirst) {
            throw new TypeError("Cannot read properties of undefined (reading 'split')");
          }
          return "richardliao@mac ~ % ";
        },
        (step, output) => steps.push({ step, output }),
        CFG,
        undefined,
        false,
        undefined,
        undefined,
        { rawUserTask: "check things then finish" },
      )
      .then((result) => ({ result, steps }));
  }

  it("survives an internal throw and still completes the task", async () => {
    const { result, steps } = await runWithFlakyRead(
      [exec("which cargo"), exec("which brew"), '{"tool":"final_answer","content":"Checked the toolchain."}'],
      1,
    );
    expect(result.success).toBe(true);
    expect(result.message).toBe("Checked the toolchain.");
    // Surfaced, not silently swallowed.
    expect(steps.some((s) => s.step === "failed" && /Internal error/.test(s.output))).toBe(true);
    // And never shown to the user as a bare JS stack noise.
    expect(steps.some((s) => s.step === "error")).toBe(false);
  });

  it("is bounded — a persistently broken path stops instead of spinning", async () => {
    const { result, steps } = await runWithFlakyRead([exec("which cargo")], Number.MAX_SAFE_INTEGER);
    // It terminates (escalating to the user counts) rather than running to
    // maxSteps, and the internal-error path is capped.
    expect(result).toBeTruthy();
    expect(steps.filter((s) => /Internal error/.test(s.output)).length).toBeLessThanOrEqual(3);
    expect(steps.length).toBeLessThan(40); // maxSteps is 80
  });
});

describe("runAgent — read_history recall (log ddb57d1bbd)", () => {
  const OLD_TASK =
    "Create a tui (terminal ui) program that shows the allocation of current machine's storage" +
    "(what files/folder take how many storage space etc..), be easy to use, clean ui, lightwieght, lightnign fast";

  function runContinue(conversation: Array<{ role: string; content: string }>, replies: string[]) {
    let n = 0;
    svc.arbitrateAgentLoop = async () => ({ stuck: false, suggestion: "" });
    const seen: string[] = [];
    (svc as unknown as { streamOpenAIChat: (...a: unknown[]) => Promise<unknown> }).streamOpenAIChat =
      async (...a: unknown[]) => {
        for (const m of a[3] as Msg[]) if (m.role === "user") seen.push(String(m.content));
        return { content: replies[Math.min(n++, replies.length - 1)], thinking: "" };
      };
    const steps: Array<{ step: string; output: string }> = [];
    return aiService
      .runAgent(
        "continue",
        async () => "ok",
        () => {},
        async () => "richardliao@mac ~ % ",
        (step, output) => steps.push({ step, output }),
        CFG,
        undefined,
        false,
        undefined,
        undefined,
        { rawUserTask: "continue", conversation },
      )
      .then((result) => ({ result, steps, seen }));
  }

  it("hands the agent the full earlier task, not a clipped prefix", async () => {
    const { result, seen, steps } = await runContinue(
      [
        { role: "user", content: OLD_TASK },
        { role: "agent", content: "cargo is not installed." },
      ],
      [
        '{"tool":"read_history"}',
        exec("cargo --version"),
        '{"tool":"final_answer","content":"Resuming the storage TUI."}',
      ],
    );
    expect(result.success).toBe(true);
    const recalled = seen.find((m) => m.includes("CONVERSATION HISTORY"));
    expect(recalled).toBeTruthy();
    // The whole instruction, including the tail the 80-char clip destroyed.
    expect(recalled).toContain("lightnign fast");
    expect(recalled).toContain("clean ui");
    expect(steps.some((s) => /Recalled \d+ earlier turn/.test(s.output))).toBe(true);
  });

  it("filters to matching turns when given a query", async () => {
    const { seen } = await runContinue(
      [
        { role: "user", content: "set up a postgres database" },
        { role: "agent", content: "postgres is running on 5432." },
        { role: "user", content: OLD_TASK },
      ],
      ['{"tool":"read_history","query":"storage"}', exec("echo hi"), '{"tool":"final_answer","content":"ok"}'],
    );
    const recalled = seen.find((m) => m.includes("CONVERSATION HISTORY"));
    expect(recalled).toContain("storage");
    expect(recalled).not.toContain("postgres");
  });

  it("says so plainly when there is nothing to recall", async () => {
    const { seen } = await runContinue(
      [],
      ['{"tool":"read_history"}', exec("echo hi"), '{"tool":"final_answer","content":"done"}'],
    );
    expect(seen.some((m) => /No earlier conversation is recorded/.test(m))).toBe(true);
  });

  it("reports a miss without derailing the run", async () => {
    const { result, seen } = await runContinue(
      [{ role: "user", content: "build a website" }],
      ['{"tool":"read_history","query":"kubernetes"}', exec("echo hi"), '{"tool":"final_answer","content":"done"}'],
    );
    expect(result.success).toBe(true);
    expect(seen.some((m) => /found no earlier turn matching/.test(m))).toBe(true);
  });
});
