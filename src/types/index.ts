// --- AI Types ---

export type AIProvider = "ollama" | "lmstudio" | "openai" | "anthropic" | "gemini" | "deepseek" | "kimi" | "qwen" | "glm" | "minimax" | "openai-compat" | "anthropic-compat";

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

export interface AttachedImage {
  base64: string;      // raw base64 data (no data: prefix)
  mediaType: string;   // image/jpeg, image/png, image/webp, image/gif
  name: string;        // original filename
}

// --- Config Types ---

export interface HotkeyMap {
  openSettings: string;
  toggleOverlay: string;
  stopAgent: string;
  clearTerminal: string;
  clearAgent: string;
  modeCommand: string;
  modeAdvice: string;
  modeAgent: string;
  modeAuto: string;
  forceAgent: string;
  [key: string]: string;
}

export interface TronConfig {
  ai?: AIConfig;
  providerConfigs?: Record<string, { model?: string; apiKey?: string; baseUrl?: string }>;
  theme?: string;
  viewMode?: string;
  configured?: boolean;
  hotkeys?: HotkeyMap;
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
