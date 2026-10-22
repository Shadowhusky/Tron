# Agent session log substrate + loop decomposition

Status: approved 2026-08-20
Scope: sub-project 1 of 5 (merged 1+2 per decision below)

## Background

Reviewing DeepSeek Harness (`deepseek-ai/deepseek-harness`, MIT, v0.1.0-rc.7)
for possible adoption established that it cannot replace Tron's agent core:
it is a Node-only Cordis plugin tree, its only embedding path
(`@deepseek-ai/dsh-sdk-client`, stdio JSON-RPC) has **no mid-turn cancel** and
**unimplemented approval flows**, its two LLM adapters are YAML-configured with
zero support for Ollama/LM Studio, and adopting it would discard ~57 call sites
of local-model and PTY hardening. Decision: take the *architecture*, not the
dependency.

The idea worth taking is dsh's session log: one append-only event log per run,
with what the model sees being a *projection* of it (`deriveMessages()`), under
the invariant "model-visible means logged".

## Problem

Three unsynchronized representations of one run:

| Representation | Shape | Consumer |
|---|---|---|
| `agentThread` | `AgentStep { step: string; output: string; payload?: any }` | overlay |
| `history` | `any[]`, mutated in place, destructively compacted at `index.ts:5963` | the model |
| six locals | `executedCommands`, `usedScaffold`, `wroteFiles`, `usedWebTools`, `terminalBusy`, `lastWriteDir` — 43 assignment sites | the guards |

None derives from another. `retract_thought` and `clear_streaming` exist purely
to reconcile the first two. `AgentContinuation` must enumerate all six locals by
hand to resume. The step vocabulary is a de-facto protocol: 21 types, three
producers, one 2,789-line consumer, no type.

`runAgent` is one ~3,900-line method taking 15 positional parameters, whose main
`for` body (`index.ts:2724`) is 3,270 lines.

## Key finding

The loop already has dsh's shape; it simply has no seams.

| dsh turn flow | Tron equivalent | Abs. lines |
|---|---|---|
| `agent/pre-step` | steering, circuit breaker, plan re-inject, check-in | 2728-2901 |
| `agent/request` + `llm/stream` | request, streaming, `<think>` interception | 2921 |
| (adapter) | parse / thinking-fallback / coerce / multi-tool | 3222-3602 |
| `tools/pre-execute` | loop detection + completion guards | 3629 |
| `tools/execute` | 17-branch dispatch | 3899 |
| `tools/post-execute` | counter resets, path resolution | 5001-5009 |

This is cutting our own code along joints it already has, not importing a
foreign architecture.

## Design

### Components

```
src/services/ai/agent/
  events.ts    SessionEvent union, SessionLog (append-only, per-run)
  derive.ts    deriveMessages(log, opts) -> provider messages
               deriveRunState(log)       -> the six flags
  preStep.ts   steering drain, circuit breaker, plan re-inject, check-in
  stream.ts    provider request, streaming, <think> interception,
               native-tools switching (NATIVE_TOOL_MODELS)
  parse.ts     parse -> thinking-fallback -> coerce -> multi-tool detect
  guards.ts    loop detection, completion guards, bounce-path bounds
  tools/       17 modules, (action, ctx) => ToolOutcome
  loop.ts      orchestrator (~150 lines)
```

`runAgent` remains in `index.ts` as a thin wrapper with today's signature;
`useAgentRunner` is untouched.

`parse.ts` and `guards.ts` are **pure** — `(input, state) -> decision`, no IO,
no emission. That purity is what makes characterization tests attachable.
`tools/*` receive an explicit `ctx` rather than closure variables.

### Data flow (one iteration)

```
preStep(log, inbox)                  -> appends events
deriveMessages(log)                  -> provider messages
stream(messages, cfg)                -> appends assistant chunks
parse(text)                          -> Action | ParseFailure
guards(action, deriveRunState(log))  -> Accept | Reject(reason) | Escalate
tools[action.tool](action, ctx)      -> ToolOutcome -> appended
```

`retract_thought` and `clear_streaming` disappear by construction: a failed
parse attempt's thinking never enters the log, and streaming is transient UI
state rather than log content. The adapter renders in-flight stream state
separately from committed events.

### Error handling

Behavior unchanged, relocated into named predicates: 3-strike API retry,
context-overflow fast-fail, LM Studio "peg-native format" native-tools switch,
force-resolve after 3 rejected `final_answer`s, `escalateStuck`, circuit-breaker
trips.

**Invariant:** every bounce path stays bounded, and all counters reset when a
non-terminal action is accepted for dispatch. `agentRunLoop.test.ts` verifies
this and remains the contract.

### Testing

1. Characterization tests written against current `index.ts` FIRST, covering
   paths with no direct coverage: native-tools switching, `inferToolFromShape`,
   `parseXmlToolCall`, `looksLikeToolCallText`, bounce bounds, circuit-breaker
   reset. Must pass unchanged after the refactor.
2. Unit tests per extracted module.
3. `agentRunLoop.test.ts` unmodified, green before and after.
4. Gate: `npm run lint && npm run build:react` + vitest. Playwright is skipped
   deliberately (it kills the live dev server on 3888).

### Out of scope

No changes to `useAgentRunner`, `AgentOverlay`, or the persisted `agentThread`
format. No durability, replay, or fork (sub-projects 4/5). Compaction relocates
but stays destructive (sub-project 3). No prompt or `agent.md` changes.

### Risks

- **`terminalBusy` may not be cleanly derivable** — 21 write sites, genuinely
  stateful (set by `run_in_terminal`, cleared by an idle `read_terminal`). If
  derivation is lossy, it becomes an explicit logged event rather than forced.
- **Big-bang with no intermediate shippable state**, a consequence of merging
  sub-projects 1 and 2. Mitigated by staging the work so lint/build/tests stay
  green at each stage, on a branch.

## Decisions taken

| Question | Choice |
|---|---|
| Adopt dsh itself? | No — harvest the architecture, not the dependency |
| Goal | Full program: log, compaction, replay, fork (this spec = foundation) |
| Decomposition | Merge sub-projects 1 and 2 into one spec |
| Structure | Phase modules + plain orchestrator (not dsh's waterfall hooks) |
| Safety net | Existing tests + characterization tests written first |

## Remaining sub-projects

3. Non-destructive compaction (compaction as re-projection)
4. Durable log + replay (`/log` successor)
5. Session fork at an event boundary
