# Tron — AI-Powered Terminal

Electron + React + TypeScript terminal application with AI-powered features.

## Architecture

```
src/
  constants/          # String constants (IPC channels, localStorage keys)
  types/index.ts      # Single source of truth for all shared types
  services/
    ai/               # AIService class — multi-provider streaming, agent loop (runAgent)
      index.ts        # Provider handling, streaming, tool dispatch, safety mechanisms
      agent.md        # Compact system prompt appended to agent instructions (keep concise — sent every call)
    mode.ts           # TronMode singleton (local/gateway/demo) and predicates
    ws-bridge.ts      # WebSocket IPC bridge for web mode, modeReady promise
    demo-bridge.ts    # Mock IPC handlers for demo mode (no server)
  hooks/              # Custom React hooks (useAgentRunner, useModels, useHotkey)
  utils/
    platform.ts           # Cross-platform path utilities (isWindows, extractFilename, abbreviateHome, etc.)
    commandClassifier.ts  # Command classification (case-insensitive), smartQuotePaths(), isInteractiveCommand()
    terminalState.ts      # Terminal state classifier (idle/busy/server/input_needed), scaffold duplicate check, autoCd
    contextCleaner.ts     # ANSI stripping, output collapsing, truncation
    dangerousCommand.ts   # Dangerous command detection (rm -rf, sudo, git force-push, etc.)
    theme.ts              # Theme token registry, themeClass() helper
    motion.ts             # Shared framer-motion variants
  contexts/           # React contexts (Layout, Theme, History, Agent)
  components/
    layout/           # TabBar, SplitPane (recursive), TerminalPane, ContextBar, CloseConfirmModal, NotificationOverlay, SavedTabsModal, EmptyState
    ui/               # Modal, FolderPickerModal, FeatureIcon, SpotlightOverlay
  features/
    terminal/         # Terminal.tsx (xterm.js), SmartInput.tsx
    agent/            # AgentOverlay.tsx, TokenHeatBar.tsx
    settings/         # SettingsPane.tsx (per-provider config caching)
    ssh/              # SSHConnectModal.tsx, SSHStatusBadge.tsx
    onboarding/       # OnboardingWizard.tsx (theme + AI setup)
  App.tsx             # Root: providers + TabBar + workspace + close confirm modal
  main.tsx            # React entry point
  index.css           # Tailwind + scrollbar styles

electron/
  main.ts             # Window creation, app lifecycle, close interception
  ipc/
    terminal.ts       # PTY session management, exec, execInTerminal (sentinel-based), completions, history, /log handler, session file persistence
    ssh.ts            # SSH session adapter (PtyLike interface over ssh2), profile persistence, IPC handlers
    config.ts         # Config/session IPC handlers (readSessions, writeSessions)
    system.ts         # Folder picker, shell:openPath, shell:openExternal
    ai.ts             # AI connection test — cloud providers validate config only (no API call), local providers ping endpoint
  preload.ts          # Context bridge with channel allowlist

server/               # Web mode (Express + WebSocket, no Electron)
  index.ts            # HTTP server + WS bridge + mode routing (local/gateway)
  handlers/
    terminal.ts       # Terminal session handlers (mirrors electron/ipc/terminal.ts)
    ssh.ts            # SSH session adapter for web mode (same PtyLike interface)
    ai.ts             # AI connection test handler

e2e/                  # Playwright E2E test suite
  playwright.config.ts  # workers:1, 60s timeout, html+list reporters
  fixtures/app.ts       # Electron launch fixture, page access, cleanup
  helpers/              # selectors.ts, wait.ts
  tests/                # 10 spec files
```

## Key Patterns

- **Types**: All shared types live in `src/types/index.ts`. Import from there, not from services.
- **IPC Constants**: All channel names in `src/constants/ipc.ts`. Electron handlers use matching literals.
- **Storage Constants**: All localStorage keys in `src/constants/storage.ts`.
- **Theme**: Use `themeClass(resolvedTheme, { dark, light, modern })` from `src/utils/theme.ts` instead of nested ternaries.
- **Motion**: Shared framer-motion variants in `src/utils/motion.ts` — import from there, don't duplicate animation configs.
- **Component extraction**: `SplitPane` is a thin recursive router. Terminal leaf logic lives in `TerminalPane`. Agent orchestration lives in `useAgentRunner` hook.
- **Preload safety**: `electron/preload.ts` enforces channel allowlists — only whitelisted channels can be invoked/sent/received.
- **Provider config caching**: Settings stores per-provider configs (model, apiKey) in localStorage. Switching providers preserves previously entered credentials and auto-saves provider switch.
- **Provider helpers**: `providerUsesBaseUrl()`, `isAnthropicProtocol()`, `isProviderUsable()` in `ai/index.ts`.
- **Window close**: Electron intercepts close, sends `window.confirmClose` to renderer. "Exit Without Saving" uses `discardPersistedLayout()` with file-based flag. `before-quit` (Cmd+Q) bypasses.
- **Session persistence**: Agent state (thread, overlay height, draft input, scroll position, thinking toggle) persisted to file via IPC (`readSessions`/`writeSessions`), not localStorage.
- **SSH transparency**: SSH sessions implement the `PtyLike` interface (same as node-pty). Terminal handlers check `sshSessionIds.has(sessionId)` to branch between local PTY and SSH-specific logic. Renderer code works identically for both.
- **SSH agent file ops**: For SSH sessions, `write_file`/`read_file`/`edit_file`/`list_dir`/`search_dir` tools fallback to shell commands executed over SSH instead of direct file IPC.
- **SSH profiles**: Saved in `app.getPath("userData")/ssh-profiles/profiles.json` (Electron) or `~/.tron/ssh-profiles.json` (server mode).
- **Terminal reconnection**: On page refresh, PTY sessions survive in the main process (Electron) or server (web mode, 24h grace). LayoutContext detects reconnection (`newId === oldId`), sets `TerminalSession.reconnected = true`. Terminal.tsx skips `getHistory`, shows a loading overlay (skeleton lines + blinking cursor) for 1s, does a SIGWINCH bounce-resize (cols-1 → cols) to force TUI redraw behind the overlay, then fades out with 500ms ease-out transition. Outgoing data is suppressed during bounce to prevent DSR corruption. ResizeObserver resizes are deferred until settled. Backend reconnect handlers must NOT resize the PTY — the renderer controls resize timing.
- **Terminal loading overlay**: All terminal mounts show a themed loading overlay (braille spinner) for 1.5s to mask flicker from history replay and initial rendering. Overlay fades out via `transition-opacity duration-300 ease-out`.
- **Terminal scroll guard**: Prevents scroll-to-top on click/tap. When user interacts with the terminal, xterm focuses its hidden textarea causing the browser to auto-scroll. A temporary scroll listener (300ms after mousedown/touchstart/textarea focus) reverts any jump >50px. Covers both mouse and touch.
- **Terminal scroll-to-bottom button**: Tracks scroll position via `term.onScroll()` + `term.onLineFeed()` (xterm API, not DOM scroll events — DOM events don't fire for `term.scrollLines()` used by touch handler). When user scrolls up >40px from bottom, a floating pill button appears in TerminalPane (outside Terminal's `contain: strict` boundary, z-20). Clicking dispatches `tron:scrollTermToBottom` window event → Terminal listens and calls `term.scrollToBottom()`.
- **Mobile terminal optimizations**: Touch devices get 1000-line scrollback (vs default), history truncated to last 20KB on load, 250ms resize debounce (vs 100ms desktop). Virtual keyboard open/close suppresses fit() via VisualViewport API — one clean resize after 500ms settle. Container dimension tracking (`lastContainerW`/`lastContainerH`) prevents ResizeObserver → fit() → ResizeObserver feedback loops.
- **Mobile paste**: Context menu paste uses fallback chain: (1) Electron clipboard image IPC, (2) `navigator.clipboard.readText()`, (3) server-side clipboard IPC, (4) temporary textarea element for manual paste (10s timeout, auto-submits on paste event or Enter).
- **Session eviction**: Server caps at 20 concurrent PTY sessions (`MAX_SESSIONS`). When exceeded, oldest session is killed (FIFO). History is persisted to disk before eviction so reconnect can still restore it. Creation order tracked in `sessionCreationOrder` array, cleaned up on all exit/close paths.
- **No backdrop-blur on overlays**: Never use `backdrop-blur` on modal/overlay backdrops — it causes visible lag on Electron and low-end devices. Use opaque or semi-transparent backgrounds (`bg-black/50`) instead. `backdrop-blur` is acceptable on persistent UI elements (e.g. tab bar, context bar) but not on transient overlays.
- **Modal component**: Use `<Modal>` from `src/components/ui/Modal.tsx` for all modal dialogs. Provides consistent theming (`bg-black/70` backdrop, `rounded-2xl` panel, theme-aware borders), `fadeScale`/`overlay` animation, and `onClose` backdrop click. Accepts `maxWidth`, `zIndex`, `testId` props. Pass content as children.
- **Cross-tab notifications**: `AgentContext` tracks `activeSessionIdsForNotifs` (a `Set<string>` of all session IDs in the active tab's layout tree). Notifications are only created when a session finishes outside the active tab. `NotificationOverlay` also applies a display-time filter as a safety net. In agent view mode (`fullHeight`), command execution toasts in `AgentOverlay` are suppressed since steps are already fully visible.
- **Agent view mode SmartInput**: SmartInput always starts in auto-detect mode (`isAuto=true`), even in agent view mode. The auto-detect classifier routes simple commands (`ls`, `cd`, `git status`) directly to PTY instead of through the AI agent loop. The default fallback mode is "agent" when `defaultAgentMode=true`.
- **Context menu in Electron**: `TerminalPane.handleContextMenu` no longer blocks on `isElectronApp()` — custom context menu (Copy, Paste, Ask Agent, Split) works in both Electron and web mode. `e.preventDefault()` suppresses the OS right-click menu.
- **Update modal session dismiss**: `App.tsx` uses `updateDismissedRef` to suppress the update modal after user clicks "Later" for the rest of the session. Reset via `tron:manual-update-check` custom event (dispatched by Settings "Check for Updates" button).

## Deployment Modes

| Mode | Server | Terminal | Env/Flag |
|------|--------|----------|----------|
| `local` | Express + WS | Local PTY + SSH | Default |
| `gateway` | Express + WS | SSH only | `TRON_MODE=gateway` or `--gateway` |
| `demo` | None (static) | Simulated | Auto when WS unreachable |

- **Gateway mode**: Blocks `terminal.create`, `file.*`, `log.saveSessionLog` channels. Terminal channels with sessionId must be SSH sessions. SSH-only flag (`TRON_SSH_ONLY`) defaults true in gateway.
- **Demo mode**: `ws-bridge.ts` installs `demo-bridge.ts` mock handlers on connection failure. Typewriter terminal effect with canned output.
- Server sends `{ type: "mode", mode, sshOnly }` on WS connect. Client awaits `modeReady` before rendering.
- **AI proxy**: `/api/ai-proxy/*` routes forward browser requests to AI providers (cloud and local) via the server, avoiding CORS and auth issues. Uses `express.raw()` to forward body bytes as-is. Only allows `http:`/`https:` schemes (SSRF prevention). No host restriction — supports both local and cloud providers.

## Context System (`src/components/layout/ContextBar.tsx`)

- **Context composition**: `[cwd: ...]` header + stripped terminal history + agent thread activity. Polled every 3s.
- **Auto-summarize**: Triggers at 90% context capacity. Waits for terminal idle AND agent not running before starting. Claims `isAgentRunning` so user prompts are queued during summarization. Shows `summarizing` → `summarized` steps in agent overlay. After success, clears old terminal history — only summary + new output going forward. Re-triggers if effective context grows past 90% again. Toast bubble floats up from context ring on completion.
- **No "Reset to raw"**: After summarization, old raw context is dropped. The summary is the new baseline; future output appends naturally.
- **Model switcher**: Inline model picker with search, favorites, per-provider grouping.
- **FolderPickerModal**: Web-mode fallback for CWD folder selection (ContextBar) and SSH key browsing (SSHConnectModal). Uses `file.listDir` IPC to browse the server filesystem. Supports `mode="directory"` and `mode="file"`. Parent navigation disabled at filesystem root.

## Tab Management (`src/components/layout/TabBar.tsx`)

- **Context menu**: Right-click or long-press. Rename, color dot, duplicate, save to remote, compact move (← Move →), close, close all tabs.
- **Save/Load tabs**: "Save to Remote" (context menu) saves full tab state (terminal history, agent thread, config) to disk as a one-shot snapshot. "Load Saved Tab" opens the `SavedTabsModal` to browse and restore saved tabs. No live sync — save is explicit, load creates a fresh tab. Duplicate names get `(1)`, `(2)` suffixes automatically.
- **Close All Tabs**: Requires `window.confirm` dialog. Closes all tabs sequentially.
- **Reorder**: Drag-and-drop via `framer-motion` `Reorder.Group`. Touch devices use long-press context menu instead.

## Agent System (`src/services/ai/index.ts`)

The agent loop (`runAgent`) drives multi-step task execution via tool calls:

### Tool Dispatch
- `execute_command` — sentinel-based exec via `execInTerminal` IPC, returns output. Rejects interactive/scaffold commands.
- `run_in_terminal` — writes to PTY directly, sets `terminalBusy`. Agent must poll with `read_terminal`.
- `send_text` — sends keystrokes (arrow keys, Enter, Ctrl+C).
- `read_terminal` — reads last N lines. Classifies terminal state (idle/busy/server/input_needed). Uses exponential backoff (500ms→4s). Consecutive reads merge into single UI entry via `"read_terminal"` step type.
- `write_file` / `read_file` / `edit_file` / `list_dir` / `search_dir` — file ops via IPC (or shell commands over SSH).
- `ask_question` — returns `AgentContinuation` for conversation resumption.
- `final_answer` — rejection filters: premature completion, unfinished work, error mentions.

### Safety Mechanisms
- **Loop detection**: Blocks after 3 consecutive identical calls or A→B→A→B alternation. Escalates after 3 breaks.
- **Circuit breaker**: After 3 consecutive guard blocks, forces final_answer.
- **Busy-state backoff**: Exponential wait (2s–8s) when terminal is busy. After 5 checks, forces approach change.
- **Server detection**: When `identicalReadCount >= 1` with server state, blocks further writes and forces final_answer.
- **Parse error hiding**: Parse failures silently retry (up to 3x) without showing in agent overlay. After 3 failures, raw text becomes final_answer.
- **Dangerous command detection**: Pattern-based + heuristic detection. Double-confirm for destructive operations. Permission request is pinned at bottom of the overlay (`shrink-0 max-h-[50%]`), thread history remains scrollable above it.
- **Progress reflection**: Every 8 steps, if no progress in 6+ steps, injects reflection prompt.
- **Context compaction**: Old tool results compressed after history exceeds 30 messages.
- **Auto-cd**: Platform-aware (`&&` on Unix, `;` on Windows). Skips scaffold commands.
- **Smarter TUI detection**: Pre-flight TUI checks in `run_in_terminal` and `execute_command` skip `detectTuiProgram()` when terminal is idle (`classifyTerminalOutput` returns `"idle"`). Prevents false positives from stale TUI artifacts (box-drawing chars, "claude", vim tildes) in scrollback after TUI has exited. Same gate in `read_terminal` handler.
- **Agent task focus**: Prior interactions truncated to 80 chars each (6 most recent, not 10) in `useAgentRunner.ts`. Task boundary header strengthened: `[CURRENT TASK — focus ONLY on this, ignore all prior tasks above]`. `agent.md` includes `TASK FOCUS` directive.

### Terminal State Classification (`src/utils/terminalState.ts`)
- `idle` — shell prompt visible (`$`, `%`, `#`, `>`, `PS C:\>`, `C:\>`)
- `server` — dev server running (localhost, VITE ready, etc.)
- `input_needed` — password/confirmation prompts or TUI menus
- `busy` — process actively running (default fallback)

## SmartInput Features

- **Mode detection**: Auto, Command, Advice, Agent. Multiline auto-classifies as agent.
- **Advice mode**: AI suggests a single command with explanation. Tab accepts, Enter runs.
- **Slash commands**: `/log` exports agent thread to structured JSON.
- **AI ghost text**: Inline suggestions after 3s inactivity.
- **Image attachments**: Drag-and-drop, paste (capture phase listener to intercept before xterm's `stopPropagation`), or file picker (vision models).
- **Mode cycling**: `Ctrl+Shift+M` (configurable in Settings > Shortcuts).
- **Readline hotkeys**: `Ctrl+U` (kill line before cursor), `Ctrl+K` (kill after), `Ctrl+A` (home), `Ctrl+E` (end), `Ctrl+W` (delete word back).
- **Dynamic footer**: Hotkey hints read from config via `formatHotkey()`.
- **Race-safe mode detection**: Enter handler re-classifies synchronously to prevent stale mode from async PATH checks when typing fast.
- **Completion cancellation on send**: Enter handler calls `cancelPendingCompletions()` to clear debounced IPC and reset `latestInputRef`, preventing stale async completions from re-showing the popover after send.
- **AI placeholder stale guard**: The placeholder timer callback checks `inputRef.current?.value?.trim()` before setting `aiPlaceholder`, and the effect clears `aiPlaceholder` when value becomes non-empty.

## Build & Dev

```bash
npm run dev              # Full Electron + Vite dev
npm run dev:web          # Web mode dev (Express + WS + Vite)
npm run build:react      # Build renderer (TypeScript check)
npm run build:electron   # Build Electron main process
npm run build:web        # Build web mode (server + client)
npm run lint             # ESLint
npm run test:e2e         # Playwright E2E tests
```

## Releasing

```bash
npm run release:mac      # Build + publish macOS (dmg + zip)
npm run release:win      # Build + publish Windows (nsis exe)
npm run release:linux    # Build + publish Linux (AppImage + deb)
npm run release:all      # All platforms in sequence
```

All `release:*` scripts use `--publish always` which automatically uploads artifacts **and** the `latest-mac.yml` / `latest.yml` / `latest-linux.yml` files to the GitHub release. These yml files are required by `electron-updater` for auto-update checks — without them, the in-app updater can't find new versions.

### Packaging details (`electron-builder.yml`)

- **asar + asarUnpack**: The app is packaged as `app.asar`, but `dist-server/**`, `dist-react/**`, `node_modules/**`, and `package.json` are extracted to `app.asar.unpacked/`. This is required because the embedded web server runs as a forked child process with `ELECTRON_RUN_AS_NODE=1` (plain Node.js, no asar support). It needs real filesystem access to `dist-server` (server code), `dist-react` (static files for browsers), `node_modules` (all dependencies including transitive ones), and `package.json` (`"type": "module"` for ESM).
- **Cross-platform native modules**: macOS builds use `@electron/rebuild` to compile native modules (`node-pty`, `cpu-features`). Windows and Linux builds use `--config.npmRebuild=false` because node-gyp cannot cross-compile from macOS. `node-pty` ships prebuilt binaries in `prebuilds/` for Windows; Linux builds include the macOS binary but node-pty falls back to prebuilds at runtime.
- **afterSign hook** (`build/afterSign.cjs`): Re-signs macOS `.app` bundles with `--deep` for ad-hoc builds. Checks `context.packager.platform.name` (not `process.platform`) to skip non-macOS targets when cross-compiling.
- **app-update.yml** (`build/app-update.yml`): Copied to `Contents/Resources/` via `extraResources`. Contains the GitHub publish config that `electron-updater` reads at runtime. This is needed because `electron-builder --dir` builds don't auto-generate it.

## Conventions

- React 19 JSX transform — no `import React` unless using `React.FC`, `React.useRef`, etc.
- Tailwind CSS for all styling (no CSS modules)
- Three themes: dark, light, modern (+ system auto-detect). Use `resolvedTheme` (never raw `theme`).
- `agent.md` is appended to the agent system prompt — keep it compact since it's sent every LLM call.
- Agent exec uses `execInTerminal` IPC with sentinel-based completion detection.
- Console output stripped in production builds via Vite esbuild `drop: ['console', 'debugger']`.
- All keyboard shortcuts configurable via `HotkeyMap` in ConfigContext. `formatHotkey()` for display.

## Cross-Platform (Windows) Support

- **Shell detection**: Windows tries `pwsh.exe` → `powershell.exe` → `cmd.exe` fallback chain.
- **Sentinels**: Unix uses `printf`, Windows uses `Write-Host`. All stripping handles both.
- **Command chaining**: `autoCdCommand()` uses `;` on Windows, `&&` on Unix.
- **Prompt detection**: Recognizes `PS C:\path>` (PowerShell) and `C:\path>` (cmd).
- **Path handling**: Recognizes Windows paths (`C:\`, `.\\`). `abbreviateHome()` handles all OS patterns.
- **Window chrome**: macOS uses vibrancy/hiddenInset. Windows uses titleBarOverlay + Mica.

## E2E Testing

- Playwright with Electron launch fixture (`e2e/fixtures/app.ts`)
- Test isolation via unique `TRON_TEST_PROFILE` directories
- 12 spec files: app-launch, tabs, terminal, smart-input, settings, onboarding, context-bar, agent, theme, model-favorites, keyboard, saved-tabs, web-mode
- Serial execution (`workers: 1`)

## Workflow

- After finishing a feature or batch of fixes, commit and push **without** Claude as co-author
- Update `CLAUDE.md` periodically to reflect new architecture, patterns, and conventions
- To release: bump version with `npm version patch/minor`, commit, tag, push. **Before building packages**, run the full test suite: `npm run lint && npm run build:react && npm run test:e2e` (E2E tests run against the production build). Only after all tests pass, run `source .env && GH_TOKEN=$(gh auth token) npm run release:mac` (macOS needs `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` from `.env` for notarization), then `GH_TOKEN=$(gh auth token) npm run release:win && GH_TOKEN=$(gh auth token) npm run release:linux`. Then `gh release edit vX.Y.Z --draft=false --latest` to publish.
- Update website after release: edit `tron-website/src/release.json` (version + asset URLs) and `tron-website/index.html` (`softwareVersion` in JSON-LD), commit, push. Cloudflare Pages auto-deploys. The `fetch-release.mjs` script can auto-fetch from GitHub API but only works after the release is published (not draft).
- To re-release same version (e.g. hotfix): delete the GitHub release (`gh release delete vX.Y.Z --yes`), delete and re-create the tag (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z && git tag vX.Y.Z && git push origin vX.Y.Z`), then run the release commands again.
