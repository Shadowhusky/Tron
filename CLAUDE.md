# Tron — AI-Powered Terminal

Electron + React + TypeScript terminal application with AI-powered features.

## Architecture

```
src/
  constants/          # String constants (IPC channels, localStorage keys)
  types/index.ts      # Single source of truth for all shared types
  services/ai/        # AIService class — multi-provider (Ollama, LM Studio, OpenAI, Anthropic, Gemini, DeepSeek, Kimi, Qwen, GLM, MiniMax, OpenAI/Anthropic Compatible)
    index.ts          # Provider handling, streaming, agent loop (runAgent)
    agent.md          # Compact system prompt appended to agent instructions (keep concise — sent every call)
  hooks/              # Custom React hooks (useAgentRunner, useModels)
  utils/
    platform.ts           # Cross-platform path utilities (isWindows, extractFilename, abbreviateHome, etc.)
    commandClassifier.ts  # Command classification, smartQuotePaths(), isInteractiveCommand()
    terminalState.ts      # Terminal state classifier (idle/busy/server/input_needed), scaffold duplicate check, autoCd
    contextCleaner.ts     # ANSI stripping, output collapsing, truncation
    dangerousCommand.ts   # Dangerous command detection (rm -rf, sudo, git force-push, etc.)
    theme.ts              # Theme token registry, themeClass() helper
    motion.ts             # Shared framer-motion variants
  contexts/           # React contexts (Layout, Theme, History, Agent)
  components/
    layout/           # TabBar, SplitPane (recursive), TerminalPane, ContextBar, CloseConfirmModal
    ui/               # FeatureIcon
  features/
    terminal/         # Terminal.tsx (xterm.js), SmartInput.tsx
    agent/            # AgentOverlay.tsx
    settings/         # SettingsPane.tsx (per-provider config caching)
    onboarding/       # OnboardingWizard.tsx (theme + AI setup)
  App.tsx             # Root: providers + TabBar + workspace + close confirm modal
  main.tsx            # React entry point
  index.css           # Tailwind + scrollbar styles

electron/
  main.ts             # Window creation, app lifecycle, close interception
  ipc/
    terminal.ts       # PTY session management, exec, execInTerminal (sentinel-based), completions, history, /log handler, session file persistence
    config.ts         # Config/session IPC handlers (readSessions, writeSessions)
    system.ts         # Folder picker, shell:openPath, shell:openExternal
    ai.ts             # AI connection test — cloud providers validate config only (no API call), local providers ping endpoint
  preload.ts          # Context bridge with channel allowlist

server/               # Web mode (Express + WebSocket, no Electron)
  index.ts            # HTTP server + WS bridge
  handlers/           # Terminal, AI, system handlers (mirrors electron/ipc/)

e2e/                  # Playwright E2E test suite
  playwright.config.ts  # workers:1, 60s timeout, html+list reporters
  .env.test.example     # Template for test env vars
  fixtures/app.ts       # Electron launch fixture, page access, cleanup
  helpers/
    selectors.ts        # Centralized data-testid selectors
    wait.ts             # Terminal output wait, agent completion wait, localStorage helpers
  tests/                # 10 spec files (app-launch, tabs, terminal, smart-input, settings, onboarding, context-bar, agent, theme, keyboard)
```

## Key Patterns

- **Types**: All shared types live in `src/types/index.ts`. Import from there, not from services.
- **IPC Constants**: All channel names in `src/constants/ipc.ts`. Electron handlers use matching literals.
- **Storage Constants**: All localStorage keys in `src/constants/storage.ts`.
- **Theme**: Use `themeClass(resolvedTheme, { dark, light, modern })` from `src/utils/theme.ts` instead of nested ternaries.
- **Motion**: Shared framer-motion variants in `src/utils/motion.ts` — import from there, don't duplicate animation configs.
- **Component extraction**: `SplitPane` is a thin recursive router. Terminal leaf logic lives in `TerminalPane`. Agent orchestration lives in `useAgentRunner` hook.
- **Preload safety**: `electron/preload.ts` enforces channel allowlists — only whitelisted channels can be invoked/sent/received.
- **Provider config caching**: Settings stores per-provider configs (model, apiKey) in localStorage. Switching providers preserves previously entered credentials and auto-saves provider switch. Settings save propagates to all active sessions.
- **Provider helpers**: `providerUsesBaseUrl()` (ollama, lmstudio, openai-compat, anthropic-compat), `isAnthropicProtocol()`, `isProviderUsable()` in `ai/index.ts`.
- **Window close**: Electron intercepts close, sends `window.confirmClose` to renderer. Renderer shows themed modal. "Exit Without Saving" uses `discardPersistedLayout()` with file-based flag. `before-quit` (Cmd+Q) bypasses.
- **Session persistence**: Agent state (thread, overlay height, draft input, scroll position, thinking toggle) persisted to file via IPC (`readSessions`/`writeSessions`), not localStorage. `AgentStore.subscribeToSession("")` uses wildcard matching for the debounced save subscription. `flushSave()` called on both debounce timer and `beforeunload`/`confirmClose` for reliable persistence.
- **Cross-tab notifications**: Background agent completions show toast notifications in `App.tsx`, click to switch tab.
- **CORS**: `webSecurity: false` on BrowserWindow disables Chromium CORS enforcement — standard for Electron desktop apps with controlled content.
- **Image attachments**: SmartInput supports drag-and-drop, paste, and file picker for images. `AttachedImage` type. Vision models analyzed via `aiService.analyzeImages()`, bypassing agent loop.
- **Interactive commands in agent mode**: `isInteractiveCommand()` detects TUI/REPL/editor commands → routes to embedded terminal in TerminalPane instead of overlay exec.
- **Multiline input**: Multiline text in SmartInput auto-classifies as agent mode (shell commands are single-line).
- **Context modal**: ContextBar shows combined terminal history + agent thread activity. Clear button with confirmation clears both terminal history (`terminal.clearHistory` IPC) and agent thread. Summarize/clear buttons disabled when context is too short (< 100 chars).
- **Agent overlay scroll**: Auto-scroll uses double `requestAnimationFrame` so the TanStack virtualizer can re-measure before scrolling to true bottom. Permission buttons pinned with `shrink-0` — command display scrolls independently so buttons never get clipped.

## Agent System (`src/services/ai/index.ts`)

The agent loop (`runAgent`) drives multi-step task execution via tool calls:

### Tool Dispatch
- `execute_command` — sentinel-based exec via `execInTerminal` IPC, returns output. Guards: rejects interactive/scaffold commands (redirects to run_in_terminal). Only blocks duplicate scaffold commands (read-only commands like ls/cat safe to re-run).
- `run_in_terminal` — writes to PTY directly, sets `terminalBusy`. Agent must poll with `read_terminal`.
- `send_text` — sends keystrokes (arrow keys, Enter, Ctrl+C). Waits 1.5s then snapshots terminal for log.
- `read_terminal` — reads last N lines via `terminal.readHistory` IPC. Classifies terminal state (idle/busy/server/input_needed).
- `write_file` / `read_file` / `edit_file` — direct file ops via IPC.
- `ask_question` — returns `AgentContinuation` so conversation can resume after user response.
- `final_answer` — rejection filters: premature completion, unfinished work, delegation, error mentions (with user-reported-error bypass).

### Agent Environment Context
- `useAgentRunner.ts` constructs the `[ENVIRONMENT]` section with: CWD, system paths, system info (OS, arch, shell), and project files
- System info fetched via `terminal.getSystemInfo` IPC (platform, arch, shell name, OS release)
- The static system prompt in `ai/index.ts` no longer includes OS — it's in the dynamic environment section instead

### Safety Mechanisms
- **Loop detection**: Tracks recent actions; blocks after 3 consecutive identical calls or A→B→A→B alternation. Escalates to termination after 3 loop breaks.
- **Circuit breaker**: After 3 consecutive guard blocks, forces final_answer to prevent infinite loops.
- **Busy-state backoff**: Exponential wait (2s–8s) when terminal is busy. After 5 consecutive busy checks, forces agent to change approach.
- **Scaffold duplicate check**: `isDuplicateScaffold()` strips `cd` prefixes before comparing scaffold command prefixes. Only scaffold commands are blocked as duplicates.
- **Auto-cd**: `autoCdCommand()` prepends `cd <projectRoot> &&` for project commands (npm, yarn, etc.) but skips scaffold commands that create their own directories.
- **lastWriteDir tracking**: Tracks the shallowest (shortest) directory written to — approximates project root, not the last file's parent dir.
- **Parse fallback**: After 3 JSON parse failures, raw text becomes final_answer — but rejects text containing tool-call syntax (`<tool_call>`, `<function=`, `{"tool":`).
- **JSON repair**: `normalizeToolKey` unwraps array-wrapped tool calls (e.g. MiniMax). `escapeNewlinesInStrings` fixes bare newlines inside JSON string values (common in `write_file` with large content). Both applied as fallback parse steps.
- **Completions API fallback**: `isCompletionsModel()` detects non-chat models (codex, davinci). Routes to `/v1/completions` with `messagesToPrompt()` conversion. `parseOpenAIStream` handles both `choices[0].delta.content` (chat) and `choices[0].text` (completions) SSE formats.
- **Dangerous command detection**: `isDangerousCommand()` in `src/utils/dangerousCommand.ts` — pattern-based + heuristic detection for destructive commands (rm -rf, sudo, force-push, etc.). Used by agent permission system.
- **Progress reflection**: Every 8 steps, if no progress in 6+ steps, injects reflection prompt.
- **Context compaction**: Old tool results compressed after history exceeds 30 messages.
- **mentionsError filter**: Rejects final_answer that mentions errors without resolution words — but bypassed when user's prompt itself mentioned errors (`userMentionedError`).

### Terminal State Classification (`src/utils/terminalState.ts`)
- `idle` — shell prompt visible (`$`, `%`, `#`, `>` at end, plus Windows `PS C:\>` and `C:\>` patterns)
- `server` — dev server running (localhost, VITE ready, etc.)
- `input_needed` — password/confirmation prompts OR TUI menus (●○ radio buttons, ◆◇ prompts, box drawing chars)
- `busy` — process actively running (default fallback)

## Session Log (`/log` command)

- SmartInput intercepts `/log` via `onSlashCommand` prop (must be in SmartInputProps), TerminalPane orchestrates via IPC
- Handler in `electron/ipc/terminal.ts`: filters transient steps, structures each step with per-step terminal output
- Log format v2: each agentThread entry is structured — `separator` → `{ step, prompt }`, `executed`/`failed` → `{ step, command, terminalOutput }`, others → `{ step, content }`. No separate `terminalOutput` blob.
- Writes to `app.getPath("userData")/logs/{logId}.json` with 10-char hex ID
- Path copied to clipboard, shown as "system" step in AgentOverlay (teal border)
- AgentOverlay linkifies file paths (supports spaces via encodeURI/decodeURI)

## SmartInput Features

- **Mode detection**: Classifies input as command vs agent prompt. Multiline input auto-classifies as agent mode.
- **Advice mode**: Sends prompt + session context (CWD, last 30 lines of terminal history) to AI. System prompt instructs: give the command that DIRECTLY answers the question (not prerequisites/install steps), assume tools are installed. Response parsed into `COMMAND:` and `TEXT:` parts — command shown in code block with Edit/Run buttons, description shown separately. Tab accepts command into input, Enter runs it directly.
- **Slash commands**: `/log` intercepted before mode routing via `onSlashCommand` prop from TerminalPane. Any input starting with `/` is routed through this prop.
- **History**: Agent prompts tracked alongside commands; up/down arrow navigates without triggering completions dropdown
- **AI ghost text**: Generates inline suggestions when input is empty (idle prediction, 3s delay)
- **Smart path quoting**: `smartQuotePaths()` auto-wraps space-containing paths in command mode
- **Image attachments**: Drag-and-drop, paste, or file picker. Up to 5 images, 20MB each. Vision-capable models only.
- **Draft persistence**: Input text preserved across tab switches via AgentContext `draftInput`
- **Textarea**: Input is a `<textarea>` supporting multiline entry
- **Thinking toggle**: Shows in footer when model supports thinking; hides when agent overlay is visible (overlay has its own toggle)

## Build & Dev

```bash
npm run dev:react      # Start Vite dev server (renderer)
npm run dev            # Start full Electron + Vite dev
npm run build:react    # Build renderer (TypeScript check)
npm run build:electron # Build Electron main process
npm run lint           # ESLint
npm run test:e2e       # Run Playwright E2E tests (requires build first)
npm run test:e2e:headed # E2E tests with visible browser
```

## Conventions

- React 19 JSX transform — no need to `import React` unless using `React.FC`, `React.useRef`, etc.
- Tailwind CSS for all styling (no CSS modules)
- Three themes: dark, light, modern (+ system auto-detect)
- `resolvedTheme` (never raw `theme`) for visual decisions — `theme` can be `"system"`
- Agent supports all configured providers (Ollama, LM Studio, OpenAI, Anthropic, Gemini, DeepSeek, Kimi, Qwen, GLM, MiniMax, OpenAI Compatible, Anthropic Compatible). Non-chat models (codex, davinci) auto-route to `/v1/completions`.
- Per-provider API URLs defined in `CLOUD_PROVIDERS` (ai/index.ts). Test connection in `electron/ipc/ai.ts` and `server/handlers/ai.ts` — cloud providers validate config only (no API call), local providers ping endpoint
- Settings provider dropdown organized into Local / Cloud / Custom optgroups
- `agent.md` is appended to the agent system prompt — keep it compact (< 10 lines) since it's sent on every LLM call
- `AgentOverlay` uses `summarizeCommand()` for human-readable step titles and `describeStreamingContent()` for live streaming labels (write_file, read_file, edit_file supported)
- Agent exec uses `execInTerminal` IPC — runs command in visible PTY with sentinel-based completion detection and display buffering to strip internal markers

## Cross-Platform (Windows) Support

- **Platform utility**: `src/utils/platform.ts` provides `isWindows()`, `extractFilename()`, `extractDirectory()`, `isAbsolutePath()`, `abbreviateHome()`, `isPathLikeToken()` — used throughout renderer code
- **Shell detection**: Windows tries `pwsh.exe` → `powershell.exe` → `cmd.exe` fallback chain (both `electron/ipc/terminal.ts` and `server/handlers/terminal.ts`)
- **Sentinels**: Unix uses `printf "__TRON_DONE_..."`, Windows uses `Write-Host "__TRON_DONE_..."` — all sentinel stripping handles both patterns
- **Prompt detection**: `terminalState.ts` and `contextCleaner.ts` recognize `PS C:\path>` (PowerShell) and `C:\path>` (cmd) prompts
- **Path handling**: `commandClassifier.ts` recognizes Windows paths (`C:\`, `.\\`, `..\\`); `AgentOverlay` linkifies Windows paths and splits on `[\\/]`
- **Home abbreviation**: `abbreviateHome()` handles `/Users/x` (macOS), `/home/x` (Linux), `C:\Users\x` (Windows) — used in `ContextBar` and `TerminalPane`
- **Window creation**: `electron/main.ts` uses `vibrancy`/`titleBarStyle: "hiddenInset"` on macOS; `titleBarStyle: "hidden"` + `titleBarOverlay` + `backgroundMaterial: "mica"` on Windows. TabBar has left spacer (macOS traffic lights) and right spacer (Windows overlay buttons).
- **CWD detection**: `getCwdForPid` uses `lsof` on macOS, `/proc/PID/cwd` on Linux, `Get-CimInstance Win32_Process` on Windows
- **System info IPC**: `terminal.getSystemInfo` exposes OS platform, arch, shell name — used in agent environment context. Mirrored in both `electron/ipc/terminal.ts` and `server/handlers/terminal.ts`.
- **Project file listing**: Uses `Get-ChildItem` on Windows, `find` on Unix (in `useAgentRunner.ts`)
- **AI headers**: `jsonHeaders()` and `anthropicHeaders()` helpers in `ai/index.ts` ensure consistent auth headers across all providers
- **Test connection**: Returns `{ success, error? }` with detailed error messages (HTTP status, network errors). SettingsPane shows error details below the test button.

## E2E Testing

- **Framework**: Playwright with Electron launch fixture (`e2e/fixtures/app.ts`)
- **Test isolation**: Each test run creates a unique `TRON_TEST_PROFILE` directory; `electron/main.ts` sets `app.setPath("userData", ...)` when the env var is set
- **Onboarding bypass**: Tests inject `tron_configured` + `tron_tutorial_completed` into localStorage and reload
- **Selectors**: All testable elements use `data-testid` attributes, centralized in `e2e/helpers/selectors.ts`
- **10 spec files**: app-launch, tab-management, terminal, smart-input, settings, onboarding, context-bar, agent (requires `TEST_PROVIDER`), theme, keyboard
- **Serial execution**: `workers: 1` — Electron tests share one app instance per spec
- **Model fetching**: `useAllConfiguredModels` uses `staleTime: Infinity` + `refetchOnMount: false` — only refetches on explicit `invalidateModels()` (Settings Save). Prevents redundant API calls on tab creation and page refresh

## Workflow

- After finishing a feature or batch of fixes, commit and push **without** Claude as co-author
- Update `CLAUDE.md` periodically to reflect new architecture, patterns, and conventions as the codebase evolves
