# Tron

Self-hosted AI-powered terminal. Run shells, use local or cloud LLMs (Ollama, OpenAI, Claude), and get agent-assisted commands from your desktop.

---

## Prerequisites

- **Node.js** 18+ and npm
- **Ollama** (optional, for local AI): [ollama.ai](https://ollama.ai) — install and run `ollama pull <model>` for models like `llama3` or `mistral`
- For cloud AI: OpenAI or Anthropic API key

---

## Install

```bash
git clone <repo-url>
cd tron
npm install
```

---

## Run

| Command | Description |
|--------|-------------|
| `npm run dev` | Development (Electron + Vite). Default port 5173. |
| `PORT=3000 npm run dev` | Development on port 3000. |
| `npm run build` | Production build and Electron app package. |

---

## Usage

### Terminal

- **New tab:** `Cmd+T` (Mac) / `Ctrl+T` (Windows/Linux)
- **Close pane/tab:** `Cmd+W` / `Ctrl+W`
- **Split vertical:** `Cmd+D` / `Ctrl+D`
- **Split horizontal:** `Cmd+Shift+D` / `Ctrl+Shift+D`

### Input modes (SmartInput)

| Mode | Shortcut | Use |
|------|----------|-----|
| Command | `Cmd+1` | Type shell commands; Tab for completions, history. |
| Advice | `Cmd+2` | Ask AI for command suggestions or explanations. |
| Agent | `Cmd+3` | Ask agent to run commands (Ollama only, beta). |

### Settings

- **Open:** `Cmd+,` / `Ctrl+,` or gear icon in the UI.
- **AI:** Choose provider (Ollama, OpenAI, Anthropic), model, and API key (for cloud). For Ollama, ensure the service is running and the chosen model is pulled.

---

## Tech

Electron, React, Vite, xterm.js, Tailwind. AI: Ollama (local), OpenAI, Anthropic (cloud).
