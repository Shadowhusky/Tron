// --- AI Types ---

export type AIProvider = "ollama" | "lmstudio" | "openai" | "anthropic" | "gemini" | "deepseek" | "kimi" | "qwen" | "glm" | "minimax" | "openai-compat" | "anthropic-compat";

export interface AIConfig {
  provider: AIProvider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  contextWindow?: number; // Max context chars, default 4000
  maxAgentSteps?: number; // Max agent loop iterations, default 100
  favoritedModels?: string[]; // Array of explicitly starred model strings
}

export interface AIModel {
  name: string;
  provider: AIProvider;
  capabilities?: string[];
}

export interface AgentResult {
  success: boolean;
  message: string;
  type?: string;
  payload?: any;
}

export interface AgentStep {
  step: string;
  output: string;
  payload?: any;
}

export interface AttachedImage {
  base64: string;      // raw base64 data (no data: prefix)
  mediaType: string;   // image/jpeg, image/png, image/webp, image/gif
  name: string;        // original filename
}

// --- AI Behavior Types ---

export interface AIBehavior {
  ghostText: boolean;      // AI ghost text suggestions (default: true)
  autoDetect: boolean;     // Auto-detect input mode (default: true)
  adviceMode: boolean;     // Advice mode available (default: true)
  aiTabTitles: boolean;    // AI-generated tab titles (default: true)
  inputHints: boolean;     // Show mode/shortcut hints (default: true)
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
  aiBehavior?: AIBehavior;
}

// --- SSH Types ---

export type SSHAuthMethod = "password" | "key" | "agent";

export interface SSHConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;          // default 22
  username: string;
  authMethod: SSHAuthMethod;
  privateKeyPath?: string;
  password?: string;     // transient — only passed for connect, not persisted in plain text
  passphrase?: string;   // transient — for key passphrase
  saveCredentials?: boolean; // whether to persist password/passphrase
  fingerprint?: string;      // cached host key fingerprint
  lastConnected?: number;
}

export type SSHConnectionStatus = "connected" | "disconnected" | "connecting" | "reconnecting";

// --- Terminal & Layout Types ---

export interface TerminalSession {
  id: string; // PTY Session ID
  title: string;
  cwd?: string;
  aiConfig?: AIConfig;
  dirty?: boolean; // true once user has entered commands
  contextSummary?: string; // Auto-generated summary of older context
  contextSummarySourceLength?: number; // Length of the original text that was summarized
  sshProfileId?: string;  // If set, this is a remote SSH session
  interactions?: {
    role: "user" | "agent";
    content: string;
    timestamp: number;
  }[];
}

export type SplitDirection = "horizontal" | "vertical";

export type LayoutNode =
  | { type: "leaf"; sessionId: string; contentType?: "terminal" | "settings" | "ssh-connect" }
  | {
    type: "split";
    direction: SplitDirection;
    children: LayoutNode[];
    sizes: number[];
  };

export interface Tab {
  id: string;
  title: string;
  color?: string; // Optional color tag for the tab
  root: LayoutNode;
  activeSessionId: string | null; // Which session is active in this tab
}

export interface TerminalState {
  tabs: Tab[];
  activeTabId: string;
  sessions: Map<string, TerminalSession>;
}
