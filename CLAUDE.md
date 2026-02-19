# Tron — AI-Powered Terminal

Electron + React + TypeScript terminal application with AI-powered features.

## Architecture

```
src/
  constants/          # String constants (IPC channels, localStorage keys)
  types/index.ts      # Single source of truth for all shared types
  services/ai/        # AIService class — multi-provider (Ollama, LM Studio, OpenAI, Anthropic, Gemini, DeepSeek, Kimi, Qwen, GLM, OpenAI/Anthropic Compatible)
    index.ts          # Provider handling, streaming, agent loop (runAgent)
    agent.md          # Compact system prompt appended to agent instructions (keep concise — sent every call)
  hooks/              # Custom React hooks (useAgentRunner)
  utils/
    commandClassifier.ts  # Command classification, smartQuotePaths(), isInteractiveCommand()
    terminalState.ts      # Terminal state classifier (idle/busy/server/input_needed), scaffold duplicate check, autoCd
    contextCleaner.ts     # ANSI stripping, output collapsing, truncation
    theme.ts              # Theme token registry, themeClass() helper
    motion.ts             # Shared framer-motion variants
  contexts/           # React contexts (Layout, Theme, History, Agent)
  components/
    layout/           # TabBar, SplitPane (recursive), TerminalPane, ContextBar
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
    ai.ts             # AI connection test for all providers (Ollama, LM Studio, Anthropic-compat, OpenAI-compat, cloud)
  preload.ts          # Context bridge with channel allowlist

server/               # Web mode (Express + WebSocket, no Electron)
  index.ts            # HTTP server + WS bridge
  handlers/           # Terminal, AI, system handlers (mirrors electron/ipc/)
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
- **Session persistence**: Agent state (thread, overlay height, draft input) persisted to file via IPC (`readSessions`/`writeSessions`), not localStorage. Survives across sessions.
- **Cross-tab notifications**: Background agent completions show toast notifications in `App.tsx`, click to switch tab.
- **Image attachments**: SmartInput supports drag-and-drop, paste, and file picker for images. `AttachedImage` type. Vision models analyzed via `aiService.analyzeImages()`, bypassing agent loop.
- **Interactive commands in agent mode**: `isInteractiveCommand()` detects TUI/REPL/editor commands → routes to embedded terminal in TerminalPane instead of overlay exec.
- **Multiline input**: Multiline text in SmartInput auto-classifies as agent mode (shell commands are single-line).

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

### Safety Mechanisms
- **Loop detection**: Tracks recent actions; blocks after 3 consecutive identical calls or A→B→A→B alternation. Escalates to termination after 3 loop breaks.
- **Circuit breaker**: After 3 consecutive guard blocks, forces final_answer to prevent infinite loops.
- **Busy-state backoff**: Exponential wait (2s–8s) when terminal is busy. After 5 consecutive busy checks, forces agent to change approach.
- **Scaffold duplicate check**: `isDuplicateScaffold()` strips `cd` prefixes before comparing scaffold command prefixes. Only scaffold commands are blocked as duplicates.
- **Auto-cd**: `autoCdCommand()` prepends `cd <projectRoot> &&` for project commands (npm, yarn, etc.) but skips scaffold commands that create their own directories.
- **lastWriteDir tracking**: Tracks the shallowest (shortest) directory written to — approximates project root, not the last file's parent dir.
- **Parse fallback**: After 3 JSON parse failures, raw text becomes final_answer — but rejects text containing tool-call syntax (`<tool_call>`, `<function=`, `{"tool":`).
- **Progress reflection**: Every 8 steps, if no progress in 6+ steps, injects reflection prompt.
- **Context compaction**: Old tool results compressed after history exceeds 30 messages.
- **mentionsError filter**: Rejects final_answer that mentions errors without resolution words — but bypassed when user's prompt itself mentioned errors (`userMentionedError`).

### Terminal State Classification (`src/utils/terminalState.ts`)
- `idle` — shell prompt visible (`$`, `%`, `#`, `>` at end)
- `server` — dev server running (localhost, VITE ready, etc.)
- `input_needed` — password/confirmation prompts OR TUI menus (●○ radio buttons, ◆◇ prompts, box drawing chars)
- `busy` — process actively running (default fallback)

## Session Log (`/log` command)

- SmartInput intercepts `/log`, TerminalPane orchestrates via IPC
- Handler in `electron/ipc/terminal.ts`: reads sessionHistory, strips ANSI/sentinels, filters transient steps, strips secrets/images
- Writes to `app.getPath("userData")/logs/{logId}.json` with 10-char hex ID
- Path copied to clipboard, shown as "system" step in AgentOverlay (teal border)
- AgentOverlay linkifies file paths (supports spaces via encodeURI/decodeURI)

## SmartInput Features

- **Mode detection**: Classifies input as command vs agent prompt. Multiline input auto-classifies as agent mode.
- **Slash commands**: `/log` intercepted before mode routing via `onSlashCommand` prop
- **History**: Agent prompts tracked alongside commands; up/down arrow navigates without triggering completions dropdown
- **AI ghost text**: Generates inline suggestions when input is empty (idle prediction, 3s delay)
- **Smart path quoting**: `smartQuotePaths()` auto-wraps space-containing paths in command mode
- **Image attachments**: Drag-and-drop, paste, or file picker. Up to 5 images, 20MB each. Vision-capable models only.
- **Draft persistence**: Input text preserved across tab switches via AgentContext `draftInput`
- **Textarea**: Input is a `<textarea>` supporting multiline entry

## Build & Dev

```bash
npm run dev:react     # Start Vite dev server (renderer)
npm run dev           # Start full Electron + Vite dev
npm run build:react   # Build renderer (TypeScript check)
npm run build:electron # Build Electron main process
npm run lint          # ESLint
```

## Conventions

- React 19 JSX transform — no need to `import React` unless using `React.FC`, `React.useRef`, etc.
- Tailwind CSS for all styling (no CSS modules)
- Three themes: dark, light, modern (+ system auto-detect)
- `resolvedTheme` (never raw `theme`) for visual decisions — `theme` can be `"system"`
- Agent supports all configured providers (Ollama, LM Studio, OpenAI, Anthropic, Gemini, DeepSeek, Kimi, Qwen, GLM, OpenAI Compatible, Anthropic Compatible)
- Per-provider API URLs defined in `CLOUD_PROVIDERS` (ai/index.ts) and mirrored in `PROVIDER_URLS` (electron/ipc/ai.ts, server/handlers/ai.ts) — keep in sync
- Settings provider dropdown organized into Local / Cloud / Custom optgroups
- `agent.md` is appended to the agent system prompt — keep it compact (< 10 lines) since it's sent on every LLM call
- `AgentOverlay` uses `summarizeCommand()` for human-readable step titles and `describeStreamingContent()` for live streaming labels (write_file, read_file, edit_file supported)
- Agent exec uses `execInTerminal` IPC — runs command in visible PTY with sentinel-based completion detection and display buffering to strip internal markers

## Workflow

- After finishing a feature or batch of fixes, commit and push **without** Claude as co-author
- Update `CLAUDE.md` periodically to reflect new architecture, patterns, and conventions as the codebase evolves
