// --- AI Types ---

export interface AIConfig {
  provider: "ollama" | "openai" | "anthropic" | "gemini";
  model: string;
  apiKey?: string;
  baseUrl?: string;
  contextWindow?: number; // Max context chars, default 4000
}

export interface AIModel {
  name: string;
  provider: "ollama" | "openai" | "anthropic" | "gemini";
}

export interface AgentResult {
  success: boolean;
  message: string;
}

export interface AgentStep {
  step: string;
  output: string;
}

// --- Terminal & Layout Types ---

export interface TerminalSession {
  id: string; // PTY Session ID
  title: string;
  cwd?: string;
  aiConfig?: AIConfig;
}

export type SplitDirection = "horizontal" | "vertical";

export type LayoutNode =
  | { type: "leaf"; sessionId: string; contentType?: "terminal" | "settings" }
  | {
      type: "split";
      direction: SplitDirection;
      children: LayoutNode[];
      sizes: number[];
    };

export interface Tab {
  id: string;
  title: string;
  root: LayoutNode;
  activeSessionId: string | null; // Which session is active in this tab
}

export interface TerminalState {
  tabs: Tab[];
  activeTabId: string;
  sessions: Map<string, TerminalSession>;
}
