# Tron — AI-Powered Terminal

Electron + React + TypeScript terminal application with AI-powered features.

## Architecture

```
src/
  constants/          # String constants (IPC channels, localStorage keys)
  types/index.ts      # Single source of truth for all shared types
  services/ai/        # AIService class — multi-provider (Ollama, OpenAI, Anthropic)
  hooks/              # Custom React hooks (useAgentRunner)
  utils/              # Pure utilities (commandClassifier, theme helper)
  contexts/           # React contexts (Layout, Theme, History, Agent)
  components/
    layout/           # TabBar, SplitPane (recursive), TerminalPane, ContextBar
    ui/               # FeatureIcon
  features/
    terminal/         # Terminal.tsx (xterm.js), SmartInput.tsx
    agent/            # AgentOverlay.tsx
    settings/         # SettingsPane.tsx
    onboarding/       # OnboardingWizard.tsx
  App.tsx             # Root: providers + TabBar + workspace
  main.tsx            # React entry point
  index.css           # Tailwind + scrollbar styles

electron/
  main.ts             # Slim orchestrator: window creation + app lifecycle
  ipc/
    terminal.ts       # PTY session management, exec, completions, history
    system.ts         # macOS permissions (FDA check, chmod)
    ai.ts             # AI connection test proxy
  preload.ts          # Context bridge with channel allowlist
```

## Key Patterns

- **Types**: All shared types live in `src/types/index.ts`. Import from there, not from services.
- **IPC Constants**: All channel names in `src/constants/ipc.ts`. Electron handlers use matching literals.
- **Storage Constants**: All localStorage keys in `src/constants/storage.ts`.
- **Theme**: Use `themeClass(resolvedTheme, { dark, light, modern })` from `src/utils/theme.ts` instead of nested ternaries.
- **Component extraction**: `SplitPane` is a thin recursive router. Terminal leaf logic lives in `TerminalPane`. Agent orchestration lives in `useAgentRunner` hook.
- **Preload safety**: `electron/preload.ts` enforces channel allowlists — only whitelisted channels can be invoked/sent/received.

## Build & Dev

```bash
npm run dev:react     # Start Vite dev server (renderer)
npm run dev           # Start full Electron + Vite dev
npm run build:react   # Build renderer (TypeScript check)
npm run lint          # ESLint
```

## Conventions

- React 19 JSX transform — no need to `import React` unless using `React.FC`, `React.useRef`, etc.
- Tailwind CSS for all styling (no CSS modules)
- Three themes: dark, light, modern (+ system auto-detect)
- `resolvedTheme` (never raw `theme`) for visual decisions — `theme` can be `"system"`
- Agent mode only supports Ollama currently (beta)
