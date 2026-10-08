/**
 * Claude Code / Codex as agent providers. They run the user's installed CLI,
 * which carries its own Pro/Max or ChatGPT plan login — no API key, no base URL.
 */
export type CliAgentProvider = "claude-code" | "codex-cli";
export type CliKind = "claude" | "codex";

export interface CliMode {
  id: string;
  label: string;
  hint: string;
}

export interface CliAgentProviderInfo {
  kind: CliKind;
  label: string;
  shortLabel: string;
  /** "default" = whatever the CLI is configured to use (no --model flag). */
  models: string[];
  modes: CliMode[];
  defaultMode: string;
  installHint: string;
  loginHint: string;
}

export const CLI_AGENT_PROVIDERS: Record<CliAgentProvider, CliAgentProviderInfo> = {
  "claude-code": {
    kind: "claude",
    label: "Claude Code · Pro/Max plan",
    shortLabel: "Claude Code",
    models: ["default", "sonnet", "opus", "haiku"],
    modes: [
      { id: "default", label: "Ask me", hint: "Tron asks before edits and commands Claude Code doesn't already allow." },
      { id: "acceptEdits", label: "Accept edits", hint: "File edits apply automatically; commands still ask." },
      { id: "plan", label: "Plan only", hint: "Read-only: explores and proposes a plan, changes nothing." },
      { id: "auto", label: "Auto", hint: "Claude's safety classifier approves routine actions and asks about the rest." },
      { id: "bypassPermissions", label: "Bypass", hint: "Never asks. Only for throwaway environments." },
    ],
    defaultMode: "default",
    installHint: "Install Claude Code (claude.com/claude-code), then run `claude` once to sign in.",
    loginHint: "Run `claude` in a terminal and sign in with your Claude account.",
  },
  "codex-cli": {
    kind: "codex",
    label: "Codex · ChatGPT plan",
    shortLabel: "Codex",
    models: ["default"],
    modes: [
      { id: "read-only", label: "Read only", hint: "Reads files and runs read-only commands." },
      { id: "workspace-write", label: "Workspace write", hint: "Edits files in the pane's folder; no network access." },
      { id: "danger-full-access", label: "Full access", hint: "No sandbox. Only for throwaway environments." },
    ],
    defaultMode: "workspace-write",
    installHint: "Install the Codex CLI (github.com/openai/codex), then run `codex login`.",
    loginHint: "Run `codex login` in a terminal and sign in with ChatGPT.",
  },
};

export const CLI_AGENT_PROVIDER_IDS = Object.keys(CLI_AGENT_PROVIDERS) as CliAgentProvider[];

export function isCliAgentProvider(provider: string | undefined | null): provider is CliAgentProvider {
  return !!provider && provider in CLI_AGENT_PROVIDERS;
}

/** The configured mode if it belongs to this provider, else its default. */
export function resolveCliMode(provider: CliAgentProvider, mode?: string): string {
  const info = CLI_AGENT_PROVIDERS[provider];
  return mode && info.modes.some((m) => m.id === mode) ? mode : info.defaultMode;
}
