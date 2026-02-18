# Tron — AI-Powered Terminal

Electron + React + TypeScript terminal application with AI-powered features.

## Architecture

```
src/
  constants/          # String constants (IPC channels, localStorage keys)
  types/index.ts      # Single source of truth for all shared types
  services/ai/        # AIService class — multi-provider (Ollama, OpenAI, Anthropic, Gemini, DeepSeek, Kimi, Qwen, GLM)
  hooks/              # Custom React hooks (useAgentRunner)
  utils/              # Pure utilities (commandClassifier, theme helper, motion variants)
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
    terminal.ts       # PTY session management, exec, completions, history
    system.ts         # Folder picker
    ai.ts             # AI connection test for all providers
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
- **Provider config caching**: Settings stores per-provider configs (model, apiKey) in localStorage. Switching providers preserves previously entered credentials. Settings save propagates to all active sessions.
- **Window close**: Electron intercepts close, sends `window.confirmClose` to renderer. Renderer shows themed modal. `before-quit` (Cmd+Q) bypasses.

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
- Agent supports all configured providers (Ollama, OpenAI, Anthropic, Gemini, DeepSeek, Kimi, Qwen, GLM)
- Per-provider API URLs defined in `CLOUD_PROVIDERS` (ai/index.ts) and mirrored in `PROVIDER_URLS` (electron/ipc/ai.ts, server/handlers/ai.ts) — keep in sync
