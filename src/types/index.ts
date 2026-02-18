// --- AI Types ---

export type AIProvider = "ollama" | "openai" | "anthropic" | "gemini" | "deepseek" | "kimi" | "qwen" | "glm";

export interface AIConfig {
  provider: AIProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  contextWindow?: number; // Max context chars, default 4000
  maxAgentSteps?: number; // Max agent loop iterations, default 100
}

export interface AIModel {
  name: string;
  provider: AIProvider;
  capabilities?: string[];
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
  dirty?: boolean; // true once user has entered commands
  contextSummary?: string; // Auto-generated summary of older context
  contextSummarySourceLength?: number; // Length of the original text that was summarized
  interactions?: {
    role: "user" | "agent";
    content: string;
    timestamp: number;
  }[];
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
