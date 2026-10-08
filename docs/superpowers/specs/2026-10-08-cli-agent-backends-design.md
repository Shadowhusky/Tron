# CLI agent backends — Claude Code & Codex subscriptions

## Goal

Let a Tron pane use a Claude Pro/Max or ChatGPT plan as its agent, by driving
the user's installed `claude` / `codex` CLI in headless mode. Tron never reads,
copies or proxies OAuth tokens — the CLI keeps its own login, which is the
subscription-safe path (third-party OAuth reuse was banned/unsettled in 2026).
No new npm dependencies (the Claude Agent SDK ships a ~200MB native binary per
platform; we speak its stdio protocol directly instead).

## Providers

| Provider id   | Label                         | Drives                    |
|---------------|-------------------------------|---------------------------|
| `claude-code` | Claude Code · Pro/Max plan    | `claude -p` stream-json   |
| `codex-cli`   | Codex · ChatGPT plan          | `codex exec --json`       |

- `src/services/ai/cliAgent/providers.ts`: metadata, `isCliAgentProvider()`,
  model presets (`default` = CLI's own default, omit `--model`), mode lists.
- `AIConfig.cliMode` — claude permission mode `default` (Tron asks; default) |
  `acceptEdits` | `plan` | `auto` | `bypassPermissions`; codex sandbox
  `read-only` | `workspace-write` (default) | `danger-full-access`.

## Main process (`electron/ipc/cliAgent.ts`, core in `cliAgentCore.ts`)

`cliAgentCore.ts` imports only `node:*` so vitest covers it and
`server/handlers/cliAgentCore.ts` is a byte-identical mirror (a test asserts it).

- `cliAgent.detect` → `{claude, codex}` each `{path, version, loggedIn,
  authMethod}` or `null`. Binary + login PATH resolved once through
  `$SHELL -lic … </dev/null` (GUI Electron's PATH is truncated); the CLI is then
  spawned directly with that PATH — no interactive shell ever owns its stdin
  (rc-file prompts like oh-my-zsh's updater would eat the protocol). The email
  from `claude auth status` is never returned.
- `cliAgent.start {runId, kind, prompt, cwd, model?, mode, resumeId?, images?}`
  → args from a pure validated builder (enum modes, model `[\w.:/\[\]-]`,
  uuid resume ids; renderer strings never become flags).
  - claude: `-p --output-format stream-json --input-format stream-json
    --verbose --include-partial-messages --permission-prompt-tool stdio
    --permission-mode <m> [--model] [--resume <id>]`; stdin gets an
    `initialize` control_request then the user message (text + base64 image
    blocks) and stays open until `result` (permission answers go there).
  - codex: `exec --json --skip-git-repo-check -c sandbox_mode="<m>" [-m]
    [-i tmp…] [resume <id>] -`, prompt on stdin; images → temp files, removed
    on exit.
  - Events: `cliAgent.event {runId, message}` per JSON line; `{runId, exit,
    stderrTail}` at the end. Non-JSON lines are dropped.
- `cliAgent.respond {runId, response}` — writes ONLY a validated
  `control_response` to a claude run's stdin.
- `cliAgent.stop {runId}` → SIGINT, SIGTERM after 2s. All runs die on quit
  (Electron) / client disconnect (server). Gateway/SSH-only mode blocks all
  `cliAgent.*` channels.
- `cliAgent.complete {kind, prompt}` — one-shot, tool-less, 60s timeout:
  claude `-p --output-format json --model haiku --tools "" --restricted
  --strict-mcp-config --no-session-persistence`; codex `exec --json -s
  read-only --ephemeral` (last `agent_message`).

## Renderer

- `cliAgent/normalize.ts` — stateful normalizers turning claude messages /
  codex events into one `CliAgentEvent` union (session, thinking
  start/delta/end, thought, text delta, text, tool start/end, todos,
  permission, result, error). Sub-agent traffic (`parent_tool_use_id`) is
  dropped.
- `cliAgent/thread.ts` — pure `applyCliEvent(thread, event)` onto Tron's step
  vocabulary: `thinking`→`thought` (dropped when redacted/empty),
  `streaming_response`, intermediate text → `thought`, tools →
  `executing`→`executed`/`failed` (`"<label>\n---\n<output ≤2KB>"`, payload
  `{tool, toolUseId, …}`), TodoWrite / codex `todo_list` → `plan` payload
  `{tool:"todo_write", todos}`, result → `done`/`failed`.
- `cliAgent/runner.ts` — one run over IPC; permission events await the
  caller's prompt and answer with allow(updatedInput)/deny; abort → stop.
- `useAgentRunner.handleAgentRun` — ONE self-contained block before the image
  shortcut (the inline `runAgent` onUpdate callback is untouched). Reuses
  pendingCommand/permissionResolve/alwaysAllow, the stream throttle, the
  AbortController, interactions and tab-title generation. SSH panes are
  refused (the CLI runs locally). Prompt gets a compact preamble: cwd + last
  ~40 screen lines. The CLI session id is stored per pane
  (`AgentState.cliSession`, persisted) and resumed on follow-ups; clearing the
  thread drops it.
- `AIService` (additive only): CLI providers are always usable, list presets as
  models (capability `vision`), ghost text/placeholder return nothing, and
  `generateCommand` / `generateTabTitle` / `generateTabName` /
  `summarizeContext` go through `cliAgent.complete`.
- Settings + onboarding: "Subscriptions" provider group; status (version,
  signed-in, or install/login hint), model preset + custom, mode with a
  one-line explanation; no key/URL fields.

## Testing

Pure units (args builder, mirror equality, normalizers, thread reducer) driven
by trimmed real captures (`src/__tests__/fixtures/cli-agent/`). Live check in
an isolated Electron profile with one tiny prompt per provider + a resume.
