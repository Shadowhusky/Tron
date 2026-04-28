import type {
  AIConfig,
  AIModel,
  AIProvider,
  AgentResult as BaseAgentResult,
  AttachedImage,
} from "../../types";
import { STORAGE_KEYS } from "../../constants/storage";
import {
  classifyTerminalOutput,
  detectTuiProgram,
  describeKeys as describeKeysUtil,
  autoCdCommand,
  attemptTuiExit,
  type TerminalState,
} from "../../utils/terminalState";
import agentPrompt from "./agent.md?raw";
import DEFAULT_MODELS from "../../constants/models.json";

export interface AgentContinuation {
  history: any[];
  executedCommands: string[];
  usedScaffold: boolean;
  wroteFiles: boolean;
  usedWebTools?: boolean;
  lastWriteDir: string;
  terminalBusy: boolean;
  /** Active plan published via todo_write — survives ask_question pauses. */
  agentTodos?: import("../../types").AgentTodo[];
  /** Memory entries published via remember() — survives across turns. */
  agentMemory?: string[];
}

// Extend AgentResult locally if not updating types.d.ts yet, or assume it's there
interface AgentResult extends BaseAgentResult {
  type?: "success" | "failure" | "question";
  continuation?: AgentContinuation;
}

export type { AIConfig, AIModel, AgentResult };

// ---------------------------------------------------------------------------
// Provider Configuration — all OpenAI-compatible providers share one handler
// ---------------------------------------------------------------------------

interface ProviderInfo {
  chatUrl: string;
  defaultModels: string[];
  /** Placeholder model name for settings input */
  placeholder: string;
  label: string;
  /** URL to fetch live model list (undefined = no live fetch) */
  modelsUrl?: string | ((apiKey: string) => string);
  /** Auth header style: "bearer" (default) or "anthropic" */
  authStyle?: "bearer" | "anthropic";
  /** Filter/sort raw model objects from API response. Returns model ID strings. */
  filterModels?: (models: any[]) => string[];
}

const CLOUD_PROVIDERS: Record<string, ProviderInfo> = {
  openai: {
    chatUrl: "https://api.openai.com/v1/chat/completions",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).openai || [],
    placeholder: "gpt-5.2",
    label: "OpenAI",
    modelsUrl: "https://api.openai.com/v1/models",
    filterModels: (models) =>
      models
        .filter((m) => (m.id.startsWith("gpt") || m.id.startsWith("o")) &&
          !/(audio|realtime|tts|transcribe|embedding)/i.test(m.id))
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .map((m) => m.id),
  },
  anthropic: {
    chatUrl: "https://api.anthropic.com/v1/messages",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).anthropic || [],
    placeholder: "claude-sonnet-4-6",
    label: "Anthropic",
    modelsUrl: "https://api.anthropic.com/v1/models",
    authStyle: "anthropic",
    filterModels: (models) =>
      models
        .filter((m) => m.type === "model" && m.id?.includes("claude"))
        .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
        .map((m) => m.id),
  },
  gemini: {
    chatUrl:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).gemini || [],
    placeholder: "gemini-2.5-flash",
    label: "Gemini (Google)",
    modelsUrl: (apiKey) => `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
    filterModels: (models) =>
      models
        .filter((m) => m.name?.includes("gemini"))
        .sort((a, b) => (b.name || "").localeCompare(a.name || ""))
        .map((m) => (m.name || "").replace("models/", "")),
  },
  deepseek: {
    chatUrl: "https://api.deepseek.com/chat/completions",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).deepseek || [],
    placeholder: "deepseek-chat",
    label: "DeepSeek",
    modelsUrl: "https://api.deepseek.com/models",
    filterModels: (models) =>
      models.sort((a, b) => (b.created || 0) - (a.created || 0)).map((m) => m.id),
  },
  kimi: {
    chatUrl: "https://api.moonshot.ai/v1/chat/completions",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).kimi || [],
    placeholder: "kimi-k2.5",
    label: "Kimi (Moonshot)",
    modelsUrl: "https://api.moonshot.ai/v1/models",
    filterModels: (models) =>
      models
        .filter((m) => {
          const id = (m.id || "").toLowerCase();
          if (id.includes("vision") || /\d{4}-\d{2}-\d{2}/.test(id)) return false;
          return id.includes("kimi") || id.includes("moonshot");
        })
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .map((m) => m.id),
  },
  qwen: {
    chatUrl:
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).qwen || [],
    placeholder: "qwen3.5-plus",
    label: "Qwen (Alibaba)",
    modelsUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    filterModels: (models) =>
      models
        .filter((m) => {
          const id = (m.id || "").toLowerCase();
          if (/(audio|realtime|asr|tts|omni|vl|vd|image|mt-|character|livetranslate|s2s|captioner)/i.test(id)) return false;
          if (/\d{4}-\d{2}-\d{2}/.test(id) || /-\d{4}$/.test(id)) return false;
          return id.includes("qwen");
        })
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .map((m) => m.id),
  },
  glm: {
    chatUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).glm || [],
    placeholder: "glm-5",
    label: "GLM (Zhipu)",
    modelsUrl: "https://open.bigmodel.cn/api/paas/v4/models",
    filterModels: (models) =>
      models
        .filter((m) => {
          const id = (m.id || "").toLowerCase();
          if (/\d{4}-\d{2}-\d{2}/.test(id)) return false;
          return id.includes("glm");
        })
        .sort((a, b) => (b.created || 0) - (a.created || 0))
        .map((m) => m.id),
  },
  minimax: {
    chatUrl: "https://api.minimax.io/v1/text/chatcompletion_v2",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).minimax || [],
    placeholder: "MiniMax-M2.5",
    label: "MiniMax",
    // MiniMax has no /v1/models API — uses static defaults only
  },
  lmstudio: {
    chatUrl: "http://127.0.0.1:1234/v1/chat/completions",
    defaultModels: [],
    placeholder: "loaded-model",
    label: "LM Studio (Local)",
  },
  "openai-compat": {
    chatUrl: "",
    defaultModels: [],
    placeholder: "model-name",
    label: "OpenAI Compatible",
  },
  "anthropic-compat": {
    chatUrl: "",
    defaultModels: [],
    placeholder: "model-name",
    label: "Anthropic Compatible",
  },
};

/** Get the provider info, or undefined if not a known cloud provider. */
export function getCloudProvider(provider: string): ProviderInfo | undefined {
  return CLOUD_PROVIDERS[provider];
}

/** Get all cloud provider entries for settings UI. */
export function getCloudProviderList(): { id: string; info: ProviderInfo }[] {
  return Object.entries(CLOUD_PROVIDERS).map(([id, info]) => ({ id, info }));
}

/** True for providers that use a user-supplied baseUrl (local or custom). */
export function providerUsesBaseUrl(provider: string): boolean {
  return (
    provider === "ollama" ||
    provider === "lmstudio" ||
    provider === "openai-compat" ||
    provider === "anthropic-compat"
  );
}

/** True for providers that speak the Anthropic Messages API protocol. */
export function isAnthropicProtocol(provider: string): boolean {
  return provider === "anthropic" || provider === "anthropic-compat";
}

/** Check if a provider has enough configuration to be usable. */
export function isProviderUsable(
  provider: string,
  cfg: { apiKey?: string; baseUrl?: string },
): boolean {
  if (provider === "ollama" || provider === "lmstudio") return true;
  if (provider === "openai-compat" || provider === "anthropic-compat")
    return !!cfg.baseUrl;
  return !!cfg.apiKey; // Cloud providers need apiKey
}

function isOpenAICompatible(provider: string): boolean {
  return (
    !isAnthropicProtocol(provider) &&
    provider !== "ollama" &&
    (provider in CLOUD_PROVIDERS || provider === "lmstudio")
  );
}

/** Strip potential API keys/tokens from error messages before displaying to user. */
function sanitizeError(msg: string): string {
  // Strip patterns like <ak-xxx>, sk-xxx, key-xxx, Bearer xxx (partial tokens)
  return msg
    .replace(/<[a-z]{2,4}-[a-zA-Z0-9]{10,}>/g, "<***>")
    .replace(/\b(sk|ak|key|pat|ghp|gho|glpat|xoxb|xoxp)-[a-zA-Z0-9]{10,}\b/g, "$1-***");
}

/**
 * Detect models that require OpenAI's Responses API (/v1/responses).
 * GPT-5+ codex models and standalone codex-* models are Responses-only.
 */
/** Runtime cache: models that need the Responses API (learned from API errors). */
const responsesModelCache = new Set<string>();

function isResponsesModel(model: string): boolean {
  return responsesModelCache.has(model.toLowerCase());
}

/**
 * Detect models that need the legacy /v1/completions endpoint
 * instead of /v1/chat/completions.
 * Only matches truly legacy models (davinci, babbage).
 */
function isCompletionsModel(model: string): boolean {
  const lower = model.toLowerCase();
  if (isResponsesModel(lower)) return false;
  return lower.includes("davinci") || lower.includes("babbage");
}

/** Convert chat messages array into a single prompt string for the completions API. */
function messagesToPrompt(messages: any[]): string {
  return messages
    .map((m) => {
      if (m.role === "system") return m.content;
      if (m.role === "user") return `User: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`;
      if (m.role === "assistant") return `Assistant: ${m.content}`;
      return m.content;
    })
    .join("\n\n");
}

/**
 * Convert chat messages into Responses API format.
 * System messages → `instructions` string, everything else → `input` array.
 */
function messagesToResponsesInput(messages: any[]): { instructions: string; input: any[] } {
  const systemParts: string[] = [];
  const input: any[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
    } else {
      input.push({ role: m.role, content: m.content });
    }
  }
  return { instructions: systemParts.join("\n\n"), input };
}

/**
 * In web mode (WS bridge), route ALL AI fetch requests through the server's
 * HTTP proxy to avoid CORS issues (cloud providers like Anthropic block
 * browser-origin requests). Electron mode uses native fetch directly.
 */
function proxyFetch(url: string, init?: RequestInit): Promise<Response> {
  // Only proxy in web mode (WS bridge exposes fetchModels, Electron preload does not)
  const isWebMode = !!(window as any).electron?.ipcRenderer?.fetchModels;
  if (!isWebMode) return fetch(url, init);

  try {
    const parsed = new URL(url);
    const proxyPath = `/api/ai-proxy${parsed.pathname}${parsed.search}`;
    const headers = new Headers(init?.headers as HeadersInit);
    headers.set("X-Target-Base", `${parsed.protocol}//${parsed.host}`);
    return fetch(proxyPath, { ...init, headers });
  } catch {
    return fetch(url, init);
  }
}

/** Resolve the Anthropic Messages API URL for anthropic or anthropic-compat. */
function getAnthropicChatUrl(provider: string, baseUrl?: string): string {
  if (provider === "anthropic-compat" && baseUrl) {
    const url = baseUrl.replace(/\/+$/, "");
    return url.endsWith("/v1/messages") ? url : `${url}/v1/messages`;
  }
  return "https://api.anthropic.com/v1/messages";
}

class AIService {
  private config: AIConfig = {
    provider: "ollama",
    model: "llama3",
    baseUrl: "http://localhost:11434",
  };

  constructor() {
    this.loadConfig();
  }

  private loadConfig() {
    const stored = localStorage.getItem(STORAGE_KEYS.AI_CONFIG);
    if (stored) {
      this.config = { ...this.config, ...JSON.parse(stored) };
    }
    // Non-baseUrl providers must never use a baseUrl (Ollama's localhost leaks via
    // JSON.stringify stripping undefined values — on reload the default
    // "http://localhost:11434" survives the merge).
    if (!providerUsesBaseUrl(this.config.provider)) {
      this.config.baseUrl = undefined;
    }

    // If current provider isn't properly configured, auto-switch to first usable one
    if (!isProviderUsable(this.config.provider, this.config)) {
      let providerConfigs: Record<
        string,
        { model?: string; apiKey?: string; baseUrl?: string }
      > = {};
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.PROVIDER_CONFIGS);
        if (raw) providerConfigs = JSON.parse(raw);
      } catch { }

      let found = false;
      for (const [id, cfg] of Object.entries(providerConfigs)) {
        if (isProviderUsable(id, cfg) && cfg.model) {
          this.config.provider = id as AIProvider;
          this.config.model = cfg.model;
          this.config.apiKey = cfg.apiKey;
          this.config.baseUrl = providerUsesBaseUrl(id)
            ? cfg.baseUrl
            : undefined;
          found = true;
          break;
        }
      }
      if (!found) {
        this.config.provider = "ollama";
        this.config.model = "";
        this.config.baseUrl = "http://localhost:11434";
        this.config.apiKey = undefined;
      }
      localStorage.setItem(STORAGE_KEYS.AI_CONFIG, JSON.stringify(this.config));
    }
  }

  saveConfig(config: Partial<AIConfig>) {
    this.config = { ...this.config, ...config };
    // Keep localStorage as fast cache for synchronous init on next load
    localStorage.setItem(STORAGE_KEYS.AI_CONFIG, JSON.stringify(this.config));
    // File-based persistence handled by the caller via ConfigContext.updateConfig()
  }

  /** Mark a model as having thinking capability (detected at runtime via thinking tags). */
  markModelAsThinking(provider: string, model: string): void {
    const key = `${provider}:${model}`;
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.DETECTED_THINKING_MODELS);
      const set: string[] = raw ? JSON.parse(raw) : [];
      if (set.includes(key)) return;
      set.push(key);
      localStorage.setItem(STORAGE_KEYS.DETECTED_THINKING_MODELS, JSON.stringify(set));
      // Notify listeners so UI updates capabilities immediately (no refresh needed)
      window.dispatchEvent(new CustomEvent("tron:thinkingModelDetected", { detail: { provider, model } }));
    } catch { /* non-critical */ }
  }

  /** Check if a model was detected as having thinking capability at runtime. */
  isDetectedThinkingModel(provider: string, model: string): boolean {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.DETECTED_THINKING_MODELS);
      if (!raw) return false;
      const set: string[] = JSON.parse(raw);
      return set.includes(`${provider}:${model}`);
    } catch { return false; }
  }

  /** Build JSON headers for OpenAI-compatible APIs, optionally including Bearer auth. */
  private jsonHeaders(apiKey?: string): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) h.Authorization = `Bearer ${apiKey}`;
    return h;
  }

  /** Build JSON headers for Anthropic APIs, optionally including x-api-key. */
  private anthropicHeaders(apiKey?: string): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (apiKey) h["x-api-key"] = apiKey;
    return h;
  }

  getConfig() {
    return this.config;
  }

  async getModelCapabilities(
    modelName: string,
    baseUrl?: string,
    provider?: string,
    apiKey?: string,
  ): Promise<string[]> {
    const effectiveApiKey = apiKey ?? this.config.apiKey;

    // LM Studio: fetch capabilities from /api/v1/models
    if (provider === "lmstudio") {
      try {
        const url = (baseUrl || "http://127.0.0.1:1234").replace(/\/+$/, "");
        const headers: Record<string, string> = {};
        if (effectiveApiKey)
          headers.Authorization = `Bearer ${effectiveApiKey}`;
        const response = await proxyFetch(`${url}/api/v1/models`, { headers });
        if (!response.ok) return [];
        const data = await response.json();
        const allModels: any[] = data.models || data.data || [];
        const model = allModels.find(
          (m: any) => (m.key || m.id || m.name) === modelName,
        );
        if (model?.capabilities) {
          const caps: string[] = [];
          if (model.capabilities.vision) caps.push("vision");
          if (model.capabilities.trained_for_tool_use) caps.push("tools");
          if (model.capabilities.reasoning || model.capabilities.thinking)
            caps.push("thinking");
          return caps;
        }
        // Fallback: check model name/key for thinking indicators
        const key = (model?.key || model?.id || modelName || "").toLowerCase();
        if (/\b(think|reason|r1|qwq)\b/.test(key)) {
          return ["thinking"];
        }
        return [];
      } catch {
        return [];
      }
    }

    // Ollama: fetch from /api/show
    if (provider === "ollama" || !provider) {
      const url = baseUrl || this.config.baseUrl || "http://localhost:11434";
      try {
        const response = await proxyFetch(`${url}/api/show`, {
          method: "POST",
          headers: this.jsonHeaders(effectiveApiKey),
          body: JSON.stringify({ model: modelName }),
        });
        if (!response.ok) return [];
        const data = await response.json();

        // Prefer authoritative capabilities array from newer Ollama versions
        if (data.capabilities && Array.isArray(data.capabilities)) {
          return data.capabilities.filter((c: string) => c !== "completion");
        }

        // Fallback: infer from model_info and template (older Ollama)
        const capabilities: string[] = [];
        const modelInfo = data.model_info || {};
        const template = data.template || "";
        const parameters = data.parameters || "";

        if (
          template.includes("<think>") ||
          template.includes("thinking") ||
          parameters.includes("think")
        ) {
          capabilities.push("thinking");
        }

        const projectorKeys = Object.keys(modelInfo).filter(
          (k) =>
            k.includes("vision") ||
            k.includes("projector") ||
            k.includes("mmproj"),
        );
        if (projectorKeys.length > 0) {
          capabilities.push("vision");
        }

        if (
          template.includes("<tool_call>") ||
          template.includes("tools") ||
          template.includes("<function")
        ) {
          capabilities.push("tools");
        }

        return capabilities;
      } catch (e) {
        console.warn(`Failed to fetch capabilities for ${modelName}`, e);
        return [];
      }
    }

    // Cloud providers: infer capabilities from known model names
    const modelLower = (modelName || "").toLowerCase();

    // Models that support reasoning/thinking via reasoning_content or extended_thinking
    const thinkingModels = [
      /\bdeepseek-reasoner\b/,   // DeepSeek R1
      /\bkimi-k2/,               // Kimi K2 series
      /\bqwq\b/,                 // Qwen QwQ reasoning
      /\bqwen.*think/,           // Qwen thinking variants
      /\bglm.*reason/,           // GLM reasoning
    ];
    const caps: string[] = [];
    if (thinkingModels.some((p) => p.test(modelLower))) {
      caps.push("thinking");
    }

    // Vision-capable cloud models
    const visionModels = [
      /\bgpt-4o\b/, /\bgpt-5/, /\bgpt-4\.1/,  // OpenAI vision models
      /\bclaude-(opus|sonnet|haiku)-4/, /\bclaude-sonnet-4/, /\bclaude-opus-4/,  // Anthropic vision
      /\bgemini/,                               // Gemini all support vision
      /\bkimi-k2/,                              // Kimi K2 vision
    ];
    if (visionModels.some((p) => p.test(modelLower))) {
      caps.push("vision");
    }

    // Merge runtime-detected thinking capability
    if (!caps.includes("thinking") && this.isDetectedThinkingModel(provider || this.config.provider, modelName)) {
      caps.push("thinking");
    }

    return caps;
  }

  async getModels(
    baseUrl?: string,
    providerOverride?: string,
    apiKey?: string,
  ): Promise<AIModel[]> {
    const provider = providerOverride || this.config.provider;
    const effectiveApiKey = apiKey ?? this.config.apiKey;

    // Ollama
    if (provider === "ollama" || !provider) {
      try {
        const url = baseUrl || this.config.baseUrl || "http://localhost:11434";
        const headers: Record<string, string> = {};
        if (effectiveApiKey)
          headers.Authorization = `Bearer ${effectiveApiKey}`;
        const response = await proxyFetch(`${url}/api/tags`, { headers });
        if (response.ok) {
          const data = await response.json();
          return (data.models || []).map((m: any) => ({
            name: m.name,
            provider: "ollama" as const,
          }));
        }
      } catch (e) {
        console.warn("Failed to fetch Ollama models", e);
      }
      return [];
    }

    // LM Studio
    if (provider === "lmstudio") {
      try {
        const url = (
          baseUrl ||
          this.config.baseUrl ||
          "http://127.0.0.1:1234"
        ).replace(/\/+$/, "");
        const lmsHeaders: Record<string, string> = {};
        if (effectiveApiKey)
          lmsHeaders.Authorization = `Bearer ${effectiveApiKey}`;
        const response = await proxyFetch(`${url}/api/v1/models`, {
          headers: lmsHeaders,
        });
        if (response.ok) {
          const data = await response.json();
          const allLmModels: any[] = data.models || data.data || [];
          return allLmModels
            .filter((m: any) => !m.type || m.type === "llm")
            .map((m: any) => {
              const caps: string[] = [];
              if (m.capabilities?.vision) caps.push("vision");
              if (m.capabilities?.trained_for_tool_use) caps.push("tools");
              return {
                name: m.key || m.id || m.name,
                provider: "lmstudio" as const,
                capabilities: caps.length > 0 ? caps : undefined,
              };
            });
        }
      } catch (e) {
        console.warn("Failed to fetch LM Studio models", e);
      }
      return [];
    }

    // OpenAI Compatible
    if (provider === "openai-compat") {
      if (!baseUrl) return [];
      try {
        const url = baseUrl.replace(/\/+$/, "");
        const headers: Record<string, string> = {};
        if (effectiveApiKey)
          headers.Authorization = `Bearer ${effectiveApiKey}`;
        const response = await proxyFetch(`${url}/v1/models`, { headers });
        if (response.ok) {
          const data = await response.json();
          return (data.data || []).map((m: any) => ({
            name: m.id || m.name,
            provider: "openai-compat" as const,
          }));
        }
      } catch (e) {
        console.warn("Failed to fetch OpenAI-compatible models", e);
      }
      return [];
    }

    // Anthropic Compatible
    if (provider === "anthropic-compat") {
      if (!baseUrl) return [];
      try {
        const url = baseUrl.replace(/\/+$/, "");
        const headers = this.anthropicHeaders(effectiveApiKey);
        const response = await proxyFetch(`${url}/v1/models`, { headers });
        if (response.ok) {
          const data = await response.json();
          return (data.data || []).map((m: any) => ({
            name: m.id || m.name,
            provider: "anthropic-compat" as const,
          }));
        }
      } catch (e) {
        console.warn("Failed to fetch Anthropic-compatible models", e);
      }
      return [];
    }

    // Cloud providers — try live fetch, fall back to static defaults
    if (effectiveApiKey) {
      const info = CLOUD_PROVIDERS[provider];
      if (info) {
        // Try live model list if provider has a modelsUrl
        if (info.modelsUrl) {
          try {
            const url = typeof info.modelsUrl === "function"
              ? info.modelsUrl(effectiveApiKey)
              : info.modelsUrl;
            const headers: Record<string, string> = {};
            if (info.authStyle === "anthropic") {
              headers["x-api-key"] = effectiveApiKey;
              headers["anthropic-version"] = "2023-06-01";
            } else {
              // Gemini uses key in URL, skip auth header for it
              if (typeof info.modelsUrl !== "function") {
                headers.Authorization = `Bearer ${effectiveApiKey}`;
              }
            }
            const response = await proxyFetch(url, { headers });
            if (response.ok) {
              const data = await response.json();
              const rawModels = data.data || data.models || [];
              const filtered = info.filterModels
                ? info.filterModels(rawModels)
                : rawModels.map((m: any) => m.id || m.name);
              if (filtered.length > 0) {
                return filtered.map((name: string) => ({
                  name,
                  provider: provider as AIProvider,
                }));
              }
            }
          } catch {
            // Fall through to static defaults
          }
        }
        // Fallback: static model list from models.json
        return info.defaultModels.map((name) => ({
          name,
          provider: provider as AIProvider,
        }));
      }
    }

    return [];
  }

  /**
   * Fetch models from ALL configured providers (for ContextBar popover).
   * Delegates to getModels() per provider to avoid duplicating fetch logic.
   */
  async getAllConfiguredModels(
    externalProviderConfigs?: Record<string, { model?: string; apiKey?: string; baseUrl?: string }>,
  ): Promise<AIModel[]> {
    let providerConfigs: Record<
      string,
      { model?: string; apiKey?: string; baseUrl?: string }
    > = externalProviderConfigs ?? {};
    if (!externalProviderConfigs) {
      // Fallback to localStorage cache if no external configs provided
      try {
        const raw = localStorage.getItem(STORAGE_KEYS.PROVIDER_CONFIGS);
        if (raw) providerConfigs = JSON.parse(raw);
      } catch { }
    }

    // Only include providers that are properly configured
    const activeProvider = this.config.provider;
    const providersToCheck = new Set<string>();
    if (isProviderUsable(activeProvider, this.config)) {
      providersToCheck.add(activeProvider);
    }

    for (const [id, cfg] of Object.entries(providerConfigs)) {
      if (isProviderUsable(id, cfg)) {
        providersToCheck.add(id);
      }
    }

    // Gather models from each configured provider via getModels()
    const fetches = Array.from(providersToCheck).map(async (provider) => {
      const cached = providerConfigs[provider];
      const baseUrl =
        cached?.baseUrl ||
        (provider === activeProvider ? this.config.baseUrl : undefined);
      const apiKey =
        cached?.apiKey ||
        (provider === activeProvider ? this.config.apiKey : undefined);

      const models = await this.getModels(baseUrl, provider, apiKey);

      // Enrich Ollama models with capabilities (sequential to avoid spam)
      if (provider === "ollama") {
        const url = baseUrl || this.config.baseUrl || "http://localhost:11434";
        for (const m of models) {
          try {
            m.capabilities = await this.getModelCapabilities(
              m.name,
              url,
              "ollama",
              apiKey,
            );
          } catch { }
        }
      }

      return models;
    });

    const results = await Promise.allSettled(fetches);
    const models: AIModel[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        models.push(...result.value);
      }
    }
    // Merge runtime-detected thinking capability into model list
    for (const m of models) {
      if (!m.capabilities?.includes("thinking") && this.isDetectedThinkingModel(m.provider, m.name)) {
        m.capabilities = [...(m.capabilities || []), "thinking"];
      }
    }
    return models;
  }

  async summarizeContext(history: string, level: "brief" | "moderate" | "detailed" = "moderate"): Promise<string> {
    const { provider, model, apiKey, baseUrl } = this.config;
    const charLimit = level === "brief"
      ? Math.round(history.length * 0.3)
      : level === "moderate"
        ? Math.round(history.length * 0.5)
        : Math.round(history.length * 0.7);
    const prompt = `Summarize the following terminal session history into at most ${charLimit} characters (~${level === "brief" ? "30" : level === "moderate" ? "50" : "70"}% of original length). Retain key actions, file changes, errors, and current state. Omit repetitive output and verbose logs.\n\n${history}`;

    try {
      if (provider === "ollama") {
        const response = await proxyFetch(
          `${baseUrl || "http://localhost:11434"}/api/generate`,
          {
            method: "POST",
            headers: this.jsonHeaders(apiKey),
            body: JSON.stringify({ model, prompt, stream: false }),
          },
        );
        if (!response.ok) throw new Error(`Ollama: ${response.status}`);
        const data = await response.json();
        return data.response?.trim() || history;
      }

      const summaryMaxTokens = level === "brief" ? 500 : level === "moderate" ? 1000 : 2000;

      if (
        isAnthropicProtocol(provider) &&
        (apiKey || provider === "anthropic-compat")
      ) {
        const response = await proxyFetch(getAnthropicChatUrl(provider, baseUrl), {
          method: "POST",
          headers: this.anthropicHeaders(apiKey),
          body: JSON.stringify({
            model,
            max_tokens: summaryMaxTokens,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const data = await response.json();
        return data.content?.[0]?.text?.trim() || history;
      }

      // OpenAI-compatible providers (openai, deepseek, kimi, gemini, glm, lmstudio, openai-compat)
      if (
        isOpenAICompatible(provider) &&
        (apiKey || providerUsesBaseUrl(provider))
      ) {
        const result = await this.openAIChatSimple(
          provider,
          model,
          apiKey || "",
          [{ role: "user", content: prompt }],
          summaryMaxTokens,
          providerUsesBaseUrl(provider) ? baseUrl : undefined,
        );
        return result || history;
      }
    } catch (e) {
      console.warn("Context compression failed, using raw history", e);
    }
    return history;
  }

  /**
   * Ask the LLM whether the agent is stuck in a loop or making real progress.
   * Used to arbitrate heuristic loop-detection suspicions — keeps cheap pattern
   * matching as a first filter, but defers the final "block and redirect"
   * decision to the model so complex tasks that legitimately need many similar
   * probes aren't halted prematurely.
   *
   * Returns { stuck, suggestion? }:
   *  - stuck=true  → heuristic confirmed, block the action and inject suggestion
   *  - stuck=false → allow the action; heuristic was a false positive
   *  On any failure (network, parse) we return stuck=true as a safe fallback so
   *  the agent still gets redirected instead of looping forever.
   */
  async arbitrateAgentLoop(
    task: string,
    recentActions: Array<{ tool: string; args: string; outcome?: string }>,
    suspectAction: { tool: string; args: string },
    sessionConfig?: AIConfig,
    signal?: AbortSignal,
  ): Promise<{ stuck: boolean; suggestion: string }> {
    const cfg = sessionConfig || this.config;
    const { provider, model, apiKey } = cfg;
    const baseUrl = providerUsesBaseUrl(provider) ? cfg.baseUrl : undefined;
    if (!provider || !model) {
      return { stuck: true, suggestion: "Try a completely different approach or use final_answer." };
    }

    const lines = recentActions
      .map((a, i) => `${i + 1}. ${a.tool}(${a.args.slice(0, 120)})${a.outcome ? ` → ${a.outcome.slice(0, 80)}` : ""}`)
      .join("\n");
    const prompt = `You are evaluating whether an AI agent is stuck in an unproductive loop or genuinely making progress on a complex task.

TASK: ${task.slice(0, 300)}

RECENT ACTIONS (oldest→newest):
${lines}

NEXT ACTION THE AGENT WANTS TO TAKE:
${suspectAction.tool}(${suspectAction.args.slice(0, 200)})

Decide: is the agent stuck in a loop (running minor variations of the same probe without learning anything new / not converging toward the task), or legitimately making progress?

Reply with ONLY a single JSON object on one line, no markdown, no explanation:
{"stuck": true|false, "suggestion": "<if stuck: one sentence telling the agent what concrete different approach to try next, or to use final_answer to report the blocker; if not stuck: empty string>"}`;

    const messages = [{ role: "user", content: prompt }];
    const maxTokens = 200;

    const parseReply = (txt: string): { stuck: boolean; suggestion: string } => {
      const m = txt.match(/\{[\s\S]*?\}/);
      if (!m) return { stuck: true, suggestion: "Try a different approach or use final_answer." };
      try {
        const obj = JSON.parse(m[0]);
        return {
          stuck: obj.stuck === true,
          suggestion: typeof obj.suggestion === "string" ? obj.suggestion : "",
        };
      } catch {
        return { stuck: true, suggestion: "Try a different approach or use final_answer." };
      }
    };

    try {
      if (signal?.aborted) return { stuck: true, suggestion: "Aborted." };

      if (provider === "ollama") {
        const response = await proxyFetch(
          `${baseUrl || "http://localhost:11434"}/api/generate`,
          {
            method: "POST",
            headers: this.jsonHeaders(apiKey),
            body: JSON.stringify({ model, prompt, stream: false, format: "json" }),
            signal,
          },
        );
        if (!response.ok) throw new Error(`Ollama: ${response.status}`);
        const data = await response.json();
        return parseReply(data.response || "");
      }

      if (isAnthropicProtocol(provider) && (apiKey || provider === "anthropic-compat")) {
        const response = await proxyFetch(getAnthropicChatUrl(provider, baseUrl), {
          method: "POST",
          headers: this.anthropicHeaders(apiKey),
          body: JSON.stringify({ model, max_tokens: maxTokens, messages }),
          signal,
        });
        const data = await response.json();
        return parseReply(data.content?.[0]?.text || "");
      }

      if (isOpenAICompatible(provider) && (apiKey || providerUsesBaseUrl(provider))) {
        const result = await this.openAIChatSimple(
          provider,
          model,
          apiKey || "",
          messages,
          maxTokens,
          providerUsesBaseUrl(provider) ? baseUrl : undefined,
        );
        return parseReply(result);
      }
    } catch (e) {
      console.warn("Loop arbiter failed, assuming stuck", e);
    }
    return { stuck: true, suggestion: "Try a completely different approach or use final_answer to report the blocker." };
  }

  /** Stream an Ollama /api/chat response. Returns content and thinking text. */
  private async streamOllamaChat(
    baseUrl: string,
    model: string,
    messages: any[],
    onToken?: (token: string, thinking?: string) => void,
    signal?: AbortSignal,
    format?: string,
    think: boolean = true,
    apiKey?: string,
  ): Promise<{ content: string; thinking: string }> {
    const body: any = { model, messages, stream: true, think };
    if (format) body.format = format;
    // If model rejects think+format combo, the 400 retry below drops both

    const headers = this.jsonHeaders(apiKey);
    let response = await proxyFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    // Retry without format/think if model still returns 400
    if (response.status === 400 && (body.format || body.think)) {
      const retryBody: any = { model, messages, stream: true };
      response = await proxyFetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers,
        body: JSON.stringify(retryBody),
        signal,
      });
    }

    if (!response.ok) throw new Error(`Ollama Error: ${response.status}`);
    if (!response.body) throw new Error("No response body for streaming");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let thinkingText = "";
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          const msg = chunk.message;
          if (msg?.thinking) {
            thinkingText += msg.thinking;
            if (onToken) onToken("", msg.thinking);
          }
          if (msg?.content) {
            fullText += msg.content;
            if (onToken) onToken(msg.content);
          }
        } catch {
          /* skip malformed lines */
        }
      }
    }
    return { content: fullText, thinking: thinkingText };
  }

  // ---------------------------------------------------------------------------
  // Generic OpenAI-compatible methods (DeepSeek, Kimi, Gemini, GLM, OpenAI)
  // ---------------------------------------------------------------------------

  /** Resolve the chat completions URL for a given provider+config. */
  private getOpenAIChatUrl(provider: string, baseUrl?: string): string {
    if (baseUrl) {
      const url = baseUrl.replace(/\/+$/, "");
      if (url.endsWith("/chat/completions")) return url;
      // baseUrl already includes /v1 (e.g. "https://api.example.com/v1")
      if (url.endsWith("/v1")) return `${url}/chat/completions`;
      // Bare host (e.g. "http://127.0.0.1:1234") — add full path
      return `${url}/v1/chat/completions`;
    }
    const providerUrl = CLOUD_PROVIDERS[provider]?.chatUrl;
    if (providerUrl) return providerUrl;
    return "/v1/chat/completions";
  }

  /** Resolve the legacy completions URL for non-chat models (codex, davinci, etc.). */
  private getOpenAICompletionsUrl(provider: string, baseUrl?: string): string {
    if (baseUrl) {
      const url = baseUrl.replace(/\/+$/, "");
      if (url.endsWith("/completions") && !url.endsWith("/chat/completions"))
        return url;
      if (url.endsWith("/v1")) return `${url}/completions`;
      return `${url}/v1/completions`;
    }
    // Derive from the chatUrl by stripping /chat/completions → /completions
    const chatUrl = CLOUD_PROVIDERS[provider]?.chatUrl;
    if (chatUrl) return chatUrl.replace("/chat/completions", "/completions");
    return "/v1/completions";
  }

  /** Resolve the Responses API URL for codex models. */
  private getOpenAIResponsesUrl(provider: string, baseUrl?: string): string {
    if (baseUrl) {
      const url = baseUrl.replace(/\/+$/, "");
      if (url.endsWith("/responses")) return url;
      if (url.endsWith("/v1")) return `${url}/responses`;
      return `${url}/v1/responses`;
    }
    const chatUrl = CLOUD_PROVIDERS[provider]?.chatUrl;
    if (chatUrl) return chatUrl.replace("/v1/chat/completions", "/v1/responses");
    return "/v1/responses";
  }

  /** Non-streaming OpenAI-compatible chat completion. */
  private async openAIChatSimple(
    provider: string,
    model: string,
    apiKey: string,
    messages: any[],
    maxTokens?: number,
    baseUrl?: string,
  ): Promise<string> {
    const useResponses = isResponsesModel(model);
    const useCompletions = !useResponses && isCompletionsModel(model);

    let url: string;
    let body: any;

    if (useResponses) {
      url = this.getOpenAIResponsesUrl(provider, baseUrl);
      const { instructions, input } = messagesToResponsesInput(messages);
      body = { model, input, stream: false, store: false };
      if (instructions) body.instructions = instructions;
      if (maxTokens) body.max_output_tokens = maxTokens;
    } else if (useCompletions) {
      url = this.getOpenAICompletionsUrl(provider, baseUrl);
      body = { model, prompt: messagesToPrompt(messages), stream: false };
      if (maxTokens) body.max_tokens = maxTokens;
    } else {
      url = this.getOpenAIChatUrl(provider, baseUrl);
      body = { model, messages, stream: false };
      if (maxTokens) body.max_tokens = maxTokens;
    }

    const response = await proxyFetch(url, {
      method: "POST",
      headers: this.jsonHeaders(apiKey || undefined),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      // "not a chat model" → learn this model needs Responses API, retry
      if (/not a chat model/i.test(errText) && !isResponsesModel(model)) {
        responsesModelCache.add(model.toLowerCase());
        return this.openAIChatSimple(provider, model, apiKey, messages, maxTokens, baseUrl);
      }
      throw new Error(
        `${CLOUD_PROVIDERS[provider]?.label || provider} server error (${response.status}): ${errText.slice(0, 200)}`,
      );
    }
    const data = await response.json();
    // Responses API returns output_text; Chat API returns choices[0].message.content; Completions returns choices[0].text
    return (
      data.output_text?.trim() ||
      data.output?.[0]?.content?.[0]?.text?.trim() ||
      data.choices?.[0]?.message?.content?.trim() ||
      data.choices?.[0]?.text?.trim() ||
      ""
    );
  }

  /** Streaming OpenAI-compatible chat completion. Returns { content, thinking }. */
  private async streamOpenAIChat(
    provider: string,
    model: string,
    apiKey: string,
    messages: any[],
    onToken?: (token: string, thinking?: string) => void,
    signal?: AbortSignal,
    responseFormat?: string,
    baseUrl?: string,
    thinking?: boolean,
  ): Promise<{ content: string; thinking: string }> {
    const useResponses = isResponsesModel(model);
    const useCompletions = !useResponses && isCompletionsModel(model);

    let url: string;
    let body: any;

    if (useResponses) {
      url = this.getOpenAIResponsesUrl(provider, baseUrl);
      const { instructions, input } = messagesToResponsesInput(messages);
      body = { model, input, stream: true, store: false };
      if (instructions) body.instructions = instructions;
    } else if (useCompletions) {
      url = this.getOpenAICompletionsUrl(provider, baseUrl);
      body = { model, prompt: messagesToPrompt(messages), stream: true };
    } else {
      url = this.getOpenAIChatUrl(provider, baseUrl);
      body = { model, messages, stream: true };
    }

    // Only send response_format for cloud providers that support json_object (chat completions only).
    if (!useCompletions && !useResponses && responseFormat === "json" && !providerUsesBaseUrl(provider)) {
      body.response_format = { type: "json_object" };
    }

    // Enable reasoning/thinking for providers that support it
    if (thinking && !useCompletions) {
      // DeepSeek reasoning models
      if (provider === "deepseek" || model.includes("deepseek")) {
        body.enable_search = false; // required for reasoning
      }
      // OpenAI o-series models
      if (model.match(/^o[1-9]|^o3/)) {
        body.reasoning_effort = "medium";
      }
    }

    // Note: chat_template_kwargs removed — most providers reject unknown fields.

    const response = await proxyFetch(url, {
      method: "POST",
      headers: this.jsonHeaders(apiKey || undefined),
      body: JSON.stringify(body),
      signal,
    });

    // Fallback: If the server returned a 200 but it's a flat JSON error instead of a stream
    // (e.g. Minimax returning balance errors disguised as 200 OK Json)
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const errJson = await response.json();
      if (errJson.error) {
        const errMsg = errJson.error.message || String(errJson.error);
        // "not a chat model" → learn this model needs Responses API, retry automatically
        if (/not a chat model/i.test(errMsg) && !isResponsesModel(model)) {
          responsesModelCache.add(model.toLowerCase());
          return this.streamOpenAIChat(provider, model, apiKey, messages, onToken, signal, responseFormat, baseUrl, thinking);
        }
        throw new Error(`API Error: ${errMsg}`);
      }
      if (errJson.base_resp && errJson.base_resp.status_code !== 0) {
        throw new Error(
          `API Error: ${errJson.base_resp.status_msg || errJson.base_resp.status_code}`,
        );
      }
      if (errJson.choices && errJson.choices.length > 0) {
        return {
          content: errJson.choices[0].message?.content || "",
          thinking: "",
        };
      }
      // Responses API non-streaming fallback
      if (errJson.output_text || errJson.output) {
        const text = errJson.output_text || errJson.output?.[0]?.content?.[0]?.text || "";
        return { content: text, thinking: "" };
      }
      throw new Error(
        `Unexpected JSON response: ${JSON.stringify(errJson).slice(0, 200)}`,
      );
    }

    return this.parseOpenAIStream(response, onToken);
  }

  /** Parse an SSE stream from an OpenAI-compatible API (chat completions, legacy completions, or Responses API). */
  private async parseOpenAIStream(
    response: Response,
    onToken?: (token: string, thinking?: string) => void,
  ): Promise<{ content: string; thinking: string }> {
    if (!response.body) throw new Error("No response body for streaming");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let thinkingText = "";
    let buffer = "";
    let currentEventType = ""; // Track SSE event type for Responses API

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { currentEventType = ""; continue; }

        // Track SSE event type (Responses API uses "event: <type>" lines)
        if (trimmed.startsWith("event: ")) {
          currentEventType = trimmed.slice(7);
          continue;
        }

        if (!trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") continue;

        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // skip malformed SSE lines
        }

        // Error handling (shared across all API formats)
        if (chunk.error) {
          const msg =
            chunk.error.message ||
            (typeof chunk.error === "string"
              ? chunk.error
              : JSON.stringify(chunk.error));
          throw new Error(`API Error: ${msg}`);
        }
        if (chunk.base_resp && chunk.base_resp.status_code !== 0) {
          throw new Error(
            `API Error: ${chunk.base_resp.status_msg || chunk.base_resp.status_code}`,
          );
        }

        // Responses API format — uses event types like "response.output_text.delta"
        if (currentEventType === "response.output_text.delta" && chunk.delta) {
          fullText += chunk.delta;
          if (onToken) onToken(chunk.delta);
          continue;
        }
        // Responses API error events
        if (currentEventType === "response.failed" || chunk.status === "failed") {
          const errMsg = chunk.error?.message || chunk.incomplete_details || "Response failed";
          throw new Error(`API Error: ${typeof errMsg === "string" ? errMsg : JSON.stringify(errMsg)}`);
        }
        // Skip non-delta Responses API events (response.created, response.completed, etc.)
        if (currentEventType.startsWith("response.")) continue;

        // Chat completions / Legacy completions format
        const delta = chunk.choices?.[0]?.delta;
        const completionText = chunk.choices?.[0]?.text;

        if (completionText) {
          // Legacy completions API format
          fullText += completionText;
          if (onToken) onToken(completionText);
        } else if (delta) {
          // Chat completions API format
          // Handle reasoning_content (DeepSeek, GLM, Kimi K2)
          if (delta.reasoning_content) {
            thinkingText += delta.reasoning_content;
            if (onToken) onToken("", delta.reasoning_content);
          }
          if (delta.content) {
            fullText += delta.content;
            if (onToken) onToken(delta.content);
          }
        } else {
          continue;
        }
      }
    }
    return { content: fullText, thinking: thinkingText };
  }

  async generateCommand(
    prompt: string,
    onToken?: (token: string) => void,
    context?: { cwd?: string; terminalHistory?: string },
    sessionConfig?: AIConfig,
    signal?: AbortSignal,
    options?: { thinking?: boolean; onThinking?: (text: string) => void },
  ): Promise<string> {
    const cfg = sessionConfig || this.config;
    const { provider, model, apiKey, baseUrl } = cfg;

    const contextLines = [
      context?.cwd ? `CWD: ${context.cwd}` : "",
      context?.terminalHistory ? `Recent terminal output:\n${context.terminalHistory}` : "",
    ].filter(Boolean).join("\n");

    const systemPrompt = `Terminal assistant. OS: ${navigator.platform}.${contextLines ? `\n${contextLines}` : ""}
Reply ONLY in this format, nothing else:
COMMAND: <raw command, no backticks>
TEXT: <one short sentence>
Give the command that DIRECTLY answers what the user asked. NOT prerequisite/install/setup commands — the actual command they want to run. Assume tools are already installed.
Omit COMMAND line if no command applies (greetings, conceptual questions).
NEVER wrap commands in backticks or quotes. NEVER use markdown. Keep TEXT under 15 words.`;

    try {
      if (provider === "ollama") {
        const controller = new AbortController();
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
        // Abort on external signal (stop button) too
        if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
        const ollamaBase = baseUrl || "http://localhost:11434";

        try {
          // Use chat endpoint with think:false — thinking models output <think> tags
          // via /api/generate which corrupt the COMMAND:/TEXT: format.
          // Fall back to /api/generate if /api/chat returns 404 (old models without chat template).
          let result: string;
          try {
            const thinkEnabled = options?.thinking ?? false;
            const chatResult = await this.streamOllamaChat(
              ollamaBase,
              model,
              [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt },
              ],
              (token, thinking) => {
                if (thinking && options?.onThinking) options.onThinking(thinking);
                if (token && onToken) onToken(token);
              },
              controller.signal,
              undefined, // no format constraint
              thinkEnabled,
              apiKey,
            );
            result = chatResult.content;
          } catch (chatErr: any) {
            // Fallback to /api/generate for models without chat support
            if (chatErr.message?.includes("404")) {
              const resp = await proxyFetch(`${ollamaBase}/api/generate`, {
                method: "POST",
                headers: this.jsonHeaders(apiKey),
                body: JSON.stringify({
                  model,
                  prompt: `${systemPrompt}\n\nUser request: ${prompt}\nCommand:`,
                  stream: false,
                }),
                signal: controller.signal,
              });
              if (!resp.ok) throw chatErr;
              const data = await resp.json();
              // Strip <think>...</think> tags from thinking models
              result = (data.response || "").replace(/<think>[\s\S]*?<\/think>/g, "");
            } else {
              throw chatErr;
            }
          }
          clearTimeout(timeout);
          return result.trim();
        } catch (fetchError: any) {
          clearTimeout(timeout);
          if (fetchError.name === "AbortError") {
            if (timedOut) throw new Error("Ollama connection timed out. Is it running?");
            // User-initiated abort (stop button) — propagate as AbortError
            const abortErr = new DOMException("Advice generation stopped", "AbortError");
            throw abortErr;
          }
          throw fetchError;
        }
      }

      if (isAnthropicProtocol(provider)) {
        if (!apiKey && provider === "anthropic")
          throw new Error("Anthropic API Key required");
        const response = await proxyFetch(getAnthropicChatUrl(provider, baseUrl), {
          method: "POST",
          headers: this.anthropicHeaders(apiKey),
          body: JSON.stringify({
            model: model,
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: "user", content: prompt }],
          }),
          signal,
        });
        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          throw new Error(`Anthropic error (${response.status}): ${errText.slice(0, 200)}`);
        }
        const data = await response.json();
        // Find the text block (skip thinking blocks if model returned them)
        const textBlock = data.content?.find((b: any) => b.type === "text");
        return (textBlock?.text || data.content?.[0]?.text || "").trim();
      }

      // OpenAI-compatible providers (openai, deepseek, kimi, gemini, glm, lmstudio, openai-compat)
      if (isOpenAICompatible(provider)) {
        if (!apiKey && !providerUsesBaseUrl(provider))
          throw new Error(
            `${CLOUD_PROVIDERS[provider]?.label || provider} API Key required`,
          );
        const thinkEnabled = options?.thinking ?? false;
        const result = await this.streamOpenAIChat(
          provider,
          model,
          apiKey || "",
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          (token, thinking) => {
            if (thinking && options?.onThinking) options.onThinking(thinking);
            if (token && onToken) onToken(token);
          },
          signal,
          undefined,
          providerUsesBaseUrl(provider) ? baseUrl : undefined,
          thinkEnabled,
        );
        if (result.thinking && options?.onThinking) {
          // Ensure thinking text was delivered (some paths accumulate without callback)
        }
        return result.content.trim();
      }

      throw new Error(
        `Provider ${provider} not supported for command generation.`,
      );
    } catch (e: any) {
      console.error(`Error generating command with ${provider}:`, e);
      throw e;
    }
  }

  async generatePlaceholder(
    context: string,
    _partialInput?: string,
    sessionConfig?: AIConfig,
    signal?: AbortSignal,
    onToken?: (text: string) => void,
  ): Promise<string> {
    const cfg = sessionConfig || this.config;
    const provider = cfg.provider;
    const model = cfg.model;
    const apiKey = cfg.apiKey || this.config.apiKey;
    const baseUrl = providerUsesBaseUrl(provider) ? cfg.baseUrl : undefined;
    if (!model) return "";

    const systemPrompt = `You predict what the user will type next in a terminal. Based on the recent terminal output, suggest a short one-line command or action. Output ONLY the suggestion text, nothing else. Do not use backticks. Keep it under 60 characters. If unsure, output an empty string.`;
    const userContent = `Recent terminal output:\n${context.slice(-500)}`;

    // Combine caller signal (cancellation) with a 15s timeout (local models can be slow to load)
    const timeout = AbortSignal.timeout(15000);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeout])
      : timeout;

    try {
      if (provider === "ollama") {
        const ollamaBase = baseUrl || "http://localhost:11434";
        // Try chat endpoint first (think:false suppresses thinking tags),
        // fall back to generate for models without chat template.
        let response = await proxyFetch(`${ollamaBase}/api/chat`, {
          method: "POST",
          headers: this.jsonHeaders(apiKey),
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userContent },
            ],
            think: false,
            stream: false,
          }),
          signal: combinedSignal,
        });
        let raw = "";
        if (response.ok) {
          const data = await response.json();
          raw = data.message?.content || "";
        } else {
          // Fallback to /api/generate
          response = await proxyFetch(`${ollamaBase}/api/generate`, {
            method: "POST",
            headers: this.jsonHeaders(apiKey),
            body: JSON.stringify({
              model,
              prompt: `${systemPrompt}\n\n${userContent}\n\nSuggestion:`,
              stream: false,
            }),
            signal: combinedSignal,
          });
          if (!response.ok) return "";
          const data = await response.json();
          raw = (data.response || "").replace(/<think>[\s\S]*?<\/think>/g, "");
        }
        const result = raw.trim().replace(/^`+|`+$/g, "");
        return result.length <= 80 ? result : "";
      }

      if (
        isAnthropicProtocol(provider) &&
        (apiKey || provider === "anthropic-compat")
      ) {
        const response = await proxyFetch(getAnthropicChatUrl(provider, baseUrl), {
          method: "POST",
          headers: this.anthropicHeaders(apiKey),
          body: JSON.stringify({
            model,
            max_tokens: 100,
            system: systemPrompt,
            messages: [{ role: "user", content: userContent }],
          }),
          signal: combinedSignal,
        });
        const data = await response.json();
        const result = (data.content?.[0]?.text || "")
          .trim()
          .replace(/^`+|`+$/g, "")
          .split("\n")[0];
        return result.length <= 80 ? result : "";
      }

      // OpenAI-compatible providers (including lmstudio) — stream so placeholder appears progressively
      if (
        isOpenAICompatible(provider) &&
        (apiKey || providerUsesBaseUrl(provider))
      ) {
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ];
        // Track whether we're past the thinking phase
        let pastThinking = false;
        let thinkBuffer = "";
        const result = await this.streamOpenAIChat(
          provider,
          model,
          apiKey || "",
          messages,
          onToken
            ? (token) => {
              if (!token) return;
              // Buffer tokens until we detect end of thinking (models embed thinking in content)
              if (!pastThinking) {
                thinkBuffer += token;
                // Check if thinking ended: <think>/<thinking>/<thought>...</close> pattern
                const closeRe = /<\/(think|thinking|thought)>/i;
                if (closeRe.test(thinkBuffer)) {
                  const afterThink = thinkBuffer.split(closeRe).pop()?.trim() || "";
                  if (afterThink) onToken(afterThink);
                  pastThinking = true;
                } else if (thinkBuffer.length > 500) {
                  // No think tags — likely inline thinking. Don't stream anything until done.
                  pastThinking = false;
                }
                return;
              }
              onToken(token);
            }
            : undefined,
          combinedSignal,
          undefined,
          baseUrl,
          false, // disable thinking for placeholder
        );
        // Strip thinking from final content
        let raw = result.content.trim();
        raw = raw.replace(/<(think|thinking|thought)>[\s\S]*?<\/(think|thinking|thought)>/gi, "").trim();
        // If multi-line (inline thinking), take last short line
        const lines = raw.split("\n").map(l => l.trim()).filter(l => l.length > 0);
        const lastClean = lines.length > 1
          ? (lines.filter(l => l.length <= 80 && !/^[\d*\-•]/.test(l) && !l.includes(":")).pop() || lines[lines.length - 1])
          : (lines[0] || "");
        const clean = lastClean.replace(/^`+|`+$/g, "").trim();
        return clean.length <= 80 ? clean : "";
      }
    } catch {
      // Silently fail — placeholder is non-critical
    }
    return "";
  }

  /** Generate a very short tab title (2-5 words) from the user's prompt. Uses streaming, no token limit. */
  async generateTabTitle(
    prompt: string,
    sessionConfig?: AIConfig,
  ): Promise<string> {
    const cfg = sessionConfig || this.config;
    const provider = cfg.provider;
    const model = cfg.model;
    const apiKey = cfg.apiKey || this.config.apiKey;
    const baseUrl = providerUsesBaseUrl(provider) ? cfg.baseUrl : undefined;
    const systemPrompt = `Generate a short tab name that summarizes the conversation below. Output ONLY the name, nothing else.`;

    // Strip thinking artifacts and extract a clean short title
    const cleanTitle = (raw: string): string => {
      let text = raw.trim();
      text = text.replace(/<(think|thinking|thought)>[\s\S]*?<\/(think|thinking|thought)>/gi, "").trim();
      const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
      if (lines.length > 1) {
        const candidate = lines.filter(l => l.length >= 2 && l.length <= 30 && !/^[\d*\-•]/.test(l) && !l.includes(":")).pop();
        if (candidate) text = candidate;
      }
      text = text.replace(/^["'`*]+|["'`*]+$/g, "");
      return text.length >= 2 && text.length <= 30 ? text : "";
    };

    const abortCtrl = new AbortController();
    const timeout = setTimeout(() => abortCtrl.abort(), 30000);
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: `[USER PROMPT]: ${prompt.slice(0, 200)}` },
    ];

    // Shared streaming callback: strips thinking on the fly, aborts once we have a valid title
    let contentAcc = "";
    let inThink = false;
    const earlyResult = { value: "" };
    const onToken = (token: string, thinking?: string) => {
      // If native thinking field (e.g. ollama), skip it
      if (thinking) return;
      if (!token) return;
      // Detect and skip thinking tags embedded in content
      if (!inThink && /<(think|thinking|thought)>/i.test(token)) {
        inThink = true;
        return;
      }
      if (inThink) {
        if (/<\/(think|thinking|thought)>/i.test(token)) {
          inThink = false;
          const after = token.split(/<\/(think|thinking|thought)>/i).pop()?.trim() || "";
          if (after) contentAcc += after;
        }
        return;
      }
      contentAcc += token;
      // Check if we have a valid title yet — abort early if so
      const candidate = cleanTitle(contentAcc);
      if (candidate) {
        earlyResult.value = candidate;
        abortCtrl.abort();
      }
    };

    try {
      if (provider === "ollama") {
        await this.streamOllamaChat(
          baseUrl || "http://localhost:11434", model, messages,
          onToken, abortCtrl.signal, undefined, false, apiKey,
        );
        return earlyResult.value || cleanTitle(contentAcc);
      }

      if (
        isAnthropicProtocol(provider) &&
        (apiKey || provider === "anthropic-compat")
      ) {
        const response = await proxyFetch(getAnthropicChatUrl(provider, baseUrl), {
          method: "POST",
          headers: this.anthropicHeaders(apiKey),
          body: JSON.stringify({
            model, max_tokens: 4096, stream: true, system: systemPrompt,
            messages: [{ role: "user", content: prompt.slice(0, 200) }],
          }),
          signal: abortCtrl.signal,
        });
        if (!response.ok) return "";
        const reader = response.body?.getReader();
        if (!reader) return "";
        const decoder = new TextDecoder();
        let buf = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n"); buf = lines.pop() || "";
            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              try {
                const evt = JSON.parse(line.slice(6));
                if (evt.type === "content_block_delta") onToken(evt.delta?.text || "");
              } catch { /* skip */ }
            }
            if (earlyResult.value) break;
          }
        } finally { reader.releaseLock(); }
        return earlyResult.value || cleanTitle(contentAcc);
      }

      if (
        isOpenAICompatible(provider) &&
        (apiKey || providerUsesBaseUrl(provider))
      ) {
        await this.streamOpenAIChat(
          provider, model, apiKey || "", messages,
          onToken, abortCtrl.signal, undefined, baseUrl,
        );
        return earlyResult.value || cleanTitle(contentAcc);
      }
    } catch {
      // Abort or timeout — return whatever we collected
      if (earlyResult.value) return earlyResult.value;
      return cleanTitle(contentAcc);
    } finally {
      clearTimeout(timeout);
    }
    return "";
  }

  /**
   * Generate a tab name from terminal history context (2-4 words).
   * Used for auto-naming tabs after ~60s of activity. Fire-and-forget safe.
   */
  async generateTabName(
    context: string,
    sessionConfig?: AIConfig,
  ): Promise<string> {
    const cfg = sessionConfig || this.config;
    const provider = cfg.provider;
    const model = cfg.model;
    const apiKey = cfg.apiKey || this.config.apiKey;
    const baseUrl = providerUsesBaseUrl(provider) ? cfg.baseUrl : undefined;
    if (!model) return "";

    const systemPrompt = `Based on the terminal history below, generate a short descriptive tab name (2-4 words, max 25 chars). Output ONLY the name, no quotes, no punctuation. Examples: "Node Server", "Git Rebase", "Docker Build", "Python Tests".`;
    const userContent = context.slice(-500);
    const signal = AbortSignal.timeout(10000);

    try {
      if (provider === "ollama") {
        const response = await proxyFetch(
          `${baseUrl || "http://localhost:11434"}/api/generate`,
          {
            method: "POST",
            headers: this.jsonHeaders(apiKey),
            body: JSON.stringify({
              model,
              prompt: `${systemPrompt}\n\nTerminal history:\n${userContent}\n\nTab name:`,
              stream: false,
            }),
            signal,
          },
        );
        if (!response.ok) return "";
        const data = await response.json();
        const result = (data.response || "").trim().replace(/^["'`]+|["'`]+$/g, "");
        return result.length > 0 && result.length <= 30 ? result : "";
      }

      if (
        isAnthropicProtocol(provider) &&
        (apiKey || provider === "anthropic-compat")
      ) {
        const response = await proxyFetch(getAnthropicChatUrl(provider, baseUrl), {
          method: "POST",
          headers: this.anthropicHeaders(apiKey),
          body: JSON.stringify({
            model,
            max_tokens: 15,
            system: systemPrompt,
            messages: [{ role: "user", content: userContent }],
          }),
          signal,
        });
        const data = await response.json();
        const result = (data.content?.[0]?.text || "").trim().replace(/^["'`]+|["'`]+$/g, "");
        return result.length > 0 && result.length <= 30 ? result : "";
      }

      if (
        isOpenAICompatible(provider) &&
        (apiKey || providerUsesBaseUrl(provider))
      ) {
        const result = await this.openAIChatSimple(
          provider,
          model,
          apiKey || "",
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
          undefined,
          baseUrl,
        );
        const clean = result.replace(/^["'`]+|["'`]+$/g, "");
        return clean.length > 0 && clean.length <= 30 ? clean : "";
      }
    } catch {
      // Non-critical
    }
    return "";
  }

  /**
   * Direct vision API call — bypasses the agent loop entirely.
   * Used when user attaches images. No tool definitions, no JSON constraint.
   */
  async analyzeImages(
    prompt: string,
    images: AttachedImage[],
    onToken: (token: string) => void,
    sessionConfig?: AIConfig,
    signal?: AbortSignal,
    conversationHistory?: { role: "user" | "assistant"; content: string }[],
  ): Promise<string> {
    const cfg = sessionConfig || this.config;
    const provider = cfg.provider;
    const model = cfg.model;
    const apiKey = cfg.apiKey || this.config.apiKey;
    const baseUrl = providerUsesBaseUrl(provider) ? cfg.baseUrl : undefined;

    const systemPrompt =
      "You are a helpful vision assistant. Describe what you see in the user's image(s) and answer their question. Be detailed and specific.";

    // Build prior conversation messages (text only — previous images not re-sent)
    const priorMessages = (conversationHistory || []).map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    if (provider === "ollama") {
      const userMsg: any = {
        role: "user",
        content: prompt,
        images: images.map((img) => img.base64),
      };
      const result = await this.streamOllamaChat(
        baseUrl || "http://localhost:11434",
        model,
        [{ role: "system", content: systemPrompt }, ...priorMessages, userMsg],
        (token) => {
          if (token) onToken(token);
        },
        signal,
        undefined, // no JSON format
        false, // no thinking
        apiKey,
      );
      return result.content;
    }

    if (
      isAnthropicProtocol(provider) &&
      (apiKey || provider === "anthropic-compat")
    ) {
      const userContent = [
        ...images.map((img) => ({
          type: "image" as const,
          source: {
            type: "base64" as const,
            media_type: img.mediaType,
            data: img.base64,
          },
        })),
        { type: "text" as const, text: prompt },
      ];
      const anthropicHistory = priorMessages.map((msg) => ({
        role: msg.role as "user" | "assistant",
        content: msg.content,
      }));
      const response = await proxyFetch(getAnthropicChatUrl(provider, baseUrl), {
        method: "POST",
        headers: this.anthropicHeaders(apiKey),
        body: JSON.stringify({
          model,
          max_tokens: 16384,
          system: systemPrompt,
          messages: [
            ...anthropicHistory,
            { role: "user", content: userContent },
          ],
          stream: true,
        }),
        signal,
      });
      if (!response.ok) throw new Error(`Anthropic error (${response.status})`);
      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;
          try {
            const evt = JSON.parse(trimmed.slice(6));
            if (evt.type === "content_block_delta" && evt.delta?.text) {
              fullText += evt.delta.text;
              onToken(evt.delta.text);
            }
          } catch { }
        }
      }
      return fullText;
    }

    // OpenAI-compatible providers
    if (
      isOpenAICompatible(provider) &&
      (apiKey || providerUsesBaseUrl(provider))
    ) {
      const userContent = [
        { type: "text" as const, text: prompt },
        ...images.map((img) => ({
          type: "image_url" as const,
          image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
        })),
      ];
      const result = await this.streamOpenAIChat(
        provider,
        model,
        apiKey || "",
        [
          { role: "system", content: systemPrompt },
          ...priorMessages,
          { role: "user", content: userContent },
        ],
        (token) => {
          if (token) onToken(token);
        },
        signal,
        undefined, // no JSON format
        baseUrl,
      );
      return result.content;
    }

    throw new Error(`Provider ${provider} not configured for image analysis.`);
  }

  async runAgent(
    prompt: string,
    executeCommand: (cmd: string) => Promise<string>,
    writeToTerminal: (
      cmd: string,
      isRawInput?: boolean,
      checkPermission?: boolean,
    ) => Promise<void> | void,
    readTerminal: (lines: number) => Promise<string>,
    onUpdate: (step: string, output: string, payload?: any) => void,
    sessionConfig?: AIConfig,
    signal?: AbortSignal,
    thinkingEnabled: boolean = true,
    continuation?: AgentContinuation,
    images?: AttachedImage[],
    options?: { isSSH?: boolean; sessionId?: string; rawUserTask?: string; isAlternateBuffer?: () => boolean },
    checkFilePermission?: (description: string) => Promise<void>,
  ): Promise<AgentResult> {
    const cfg = sessionConfig || this.config;
    const provider = cfg.provider;
    const model = cfg.model;
    // Fall back to global apiKey if session config doesn't have one (e.g.
    // model selected via ContextBar before settings propagated).
    const apiKey = cfg.apiKey || this.config.apiKey;
    // Only send baseUrl for providers that use it — prevents Ollama localhost leak.
    const baseUrl = providerUsesBaseUrl(provider) ? cfg.baseUrl : undefined;

    // High safety ceiling — termination is driven by LLM-arbitrated loop
    // detection, not a hard step count (complex tasks legitimately need many
    // steps). Step limit only catches runaway cases arbiter also misses.
    const maxSteps = sessionConfig?.maxAgentSteps || 300;

    // Initialize state — resume from continuation or start fresh
    let history: any[];
    let executedCommands: Set<string>;
    let lastWriteDir: string;
    let usedScaffold: boolean;
    let wroteFiles: boolean;
    let usedWebTools: boolean; // web_search/web_fetch count as "action taken" for lazy completion guard
    let terminalBusy: boolean;

    if (continuation) {
      // Resume after ask_question — restore full conversation and tracking state
      history = continuation.history;
      history.push({ role: "user", content: prompt });
      executedCommands = new Set(continuation.executedCommands);
      lastWriteDir = continuation.lastWriteDir;
      usedScaffold = continuation.usedScaffold;
      wroteFiles = continuation.wroteFiles;
      usedWebTools = continuation.usedWebTools ?? false;
      terminalBusy = continuation.terminalBusy;
    } else {
      history = [
        {
          role: "system",
          content: `Terminal agent. Respond ONLY with one valid JSON tool call per turn.

═══ TOOLS ═══

{"tool":"execute_command","command":"..."}
  Run ONE non-interactive shell command. Get exit code + stdout + stderr.
  GOOD: read state ('ls -la /etc'), run a build ('npm run lint'), one-shot scripts.
  BAD: dev servers, REPLs, vim/htop/claude — those are run_in_terminal.
  BAD: 'cat /file' — use read_file. 'grep -r foo' — use search_dir. 'ls' — use list_dir.
  BAD: external API calls (yahoo finance, stock APIs, REST). Use web_fetch on a human-readable page instead.
  Errors come back as <tool_use_error>…</tool_use_error>. Read them; do NOT retry the same command.

{"tool":"run_in_terminal","command":"..."}
  Long-running / interactive commands: dev servers, scaffolders, vim, REPLs.
  Then call read_terminal repeatedly to monitor — DO NOT run another command while one is running.
  Tron auto-stops a previous server when you start a new one.

{"tool":"read_terminal","lines":50}
  Read the last N lines of terminal output. Use after run_in_terminal to monitor progress
  or to see what an interactive program is showing. Tron classifies the state for you
  (idle/busy/server/input_needed) and waits with backoff.

{"tool":"send_text","text":"...","description":"..."}
  Send keystrokes to a running interactive program (TUI menus, prompts).
  Special keys: \\r = Enter, \\x1B[B = Down, \\x1B[A = Up, \\x03 = Ctrl+C, \\x04 = Ctrl+D.
  Always provide 'description' (e.g. "Down arrow + Enter to select React").
  Auto-accept defaults: send_text("\\r") or send_text("y\\r"). Only ask the user about
  CRITICAL unresolved choices — defaults are usually fine.

{"tool":"read_file","path":"/absolute/path"}
  Read a file. Returns up to ~50KB of content. Use instead of 'cat'.
  Always use ABSOLUTE paths. If unsure where a file lives, list_dir or search_dir first.
  REQUIRED before edit_file on a file you haven't already seen this session — without
  reading first you'll guess at the contents and edit_file's search will fail.

{"tool":"write_file","path":"/absolute/path","content":"..."}
  Create a NEW file or fully replace a small (<200 lines) existing file. Creates
  parent dirs as needed. Always use ABSOLUTE paths.
  PREFER edit_file for any existing file with content you want to keep — write_file
  destroys whatever was there.

{"tool":"edit_file","path":"/absolute/path","search":"...","replace":"..."}
  Targeted search-and-replace inside an existing file. Tron tolerates curly quotes
  ('"' vs '"'/'"'), CRLF vs LF, and NBSP — you don't have to match those exactly.
  But search must include enough surrounding context to be unique in the file.
  GOOD search: 'function foo() {\\n  return 1;\\n}' (the whole function)
  BAD search: 'return 1;' (likely matches many places)
  When the same edit applies to several files, call edit_file once per file rather
  than trying to glob.

{"tool":"list_dir","path":"/absolute/path"}
  List one directory. Returns names + types (dir/file). Use instead of 'ls'.
  Won't recurse. Use search_dir for recursive search.

{"tool":"search_dir","path":"/absolute/path","query":"..."}
  Recursively search file CONTENTS for a string. Returns matches with file+line.
  Use instead of 'grep -r'. Query is a literal string, not a regex.

{"tool":"web_search","query":"..."}
  Search the web. Returns title/url/snippet for ~10 results. The user can click them.
  USE WHEN: unfamiliar error message, library API question, version compat,
  "what's the right syntax for X". Don't grind on '--help' output if a 5-second
  web search would tell you the answer.

{"tool":"web_fetch","url":"..."}
  Fetch a single page as plain text. Use after web_search on a URL that looks
  promising — README, docs page, Stack Overflow answer. NEVER use this on JSON
  API endpoints (yahoo finance, stock/weather APIs) — those are forbidden.

{"tool":"todo_write","todos":[{"content":"...","status":"pending|in_progress|completed"}, ...]}
  ANNOUNCE A PLAN. For any task that needs 3+ tool calls, START by writing a
  short todo list (3-7 items, one verb each). Then for each step:
    - mark it 'in_progress' BEFORE starting
    - mark it 'completed' immediately after finishing — do not batch
  Re-emit the full list each time you want to update state. Be specific:
    GOOD: "Find the openclaw config file"
    BAD:  "Investigate the system"
  The user sees this list. Trivial single-action requests (greetings, "show me X")
  do NOT need a todo list — skip straight to the action.

{"tool":"remember","content":"..."}
  Persist a short fact across the rest of the session. Use for:
    - approaches that already failed and why
    - file paths / IDs / config values you'll need later
    - constraints discovered (e.g. "Docker is not installed", "user prefers tabs")
  Memory is shown to you under [MEMORY] at the start of each turn.
  Keep entries short (one line each). Don't dump file contents here.

{"tool":"ask_question","question":"..."}
  Pause and ask the user. Use ONLY when:
    - You need credentials, an API key, or a personal preference.
    - You've already tried 2-3 distinct approaches and are genuinely stuck.
    - The blocker is something only the user can fix (start a service,
      install software, choose between non-obvious options).
  Do NOT use for things you can discover yourself (paths, system state, file
  contents). Do NOT use as "is this OK?" — just do the work.

{"tool":"final_answer","content":"..."}
  Task complete (or you've decided you can't proceed and need to report).
  1-3 lines. State what you did, or what blocked you.

═══ HOW TO WORK ═══

PLAN FIRST. For multi-step tasks emit todo_write before any other tool call.
The list is your contract with yourself — work the list, don't wander off it.

DIAGNOSE BEFORE RETRYING. When a tool fails:
  1. READ the <tool_use_error> message — exit codes, "command not found",
     "permission denied", "no such file" all tell you something specific.
  2. Identify the ROOT CAUSE: missing dep, wrong path, auth, service not
     running, syntax error.
  3. Try a FOCUSED fix that addresses the cause. Do NOT rerun the same
     command — Tron will block consecutive duplicates as a loop.
  4. If three different fixes don't work, REMEMBER what you tried and ASK
     the user (ask_question) or REPORT the blocker (final_answer).

ASK WHEN STUCK. After 2-3 distinct attempts at one sub-problem, STOP. Don't
spend 30 commands on a prerequisite. ask_question describing what you've
tried — the user can usually unblock you in one sentence.

DON'T GO DOWN INFRASTRUCTURE RABBIT HOLES. If the actual task is "send a
telegram message" and Docker isn't running, ask_question first ("Docker
isn't running — should I start it or is it OK to skip?"). Don't spend 15
commands installing/starting tooling on the user's behalf without checking.

ONE TOOL PER RESPONSE. Output exactly ONE JSON object then STOP. Wait for
the result. The result is either the tool's output or a <tool_use_error>
tag with the failure reason — both must be read carefully.

═══ STANDING RULES ═══

- Be FULLY autonomous on read-only checks (ps, lsof, ls, system_profiler) —
  never ask the user for state you can discover yourself.
- If the user denies a permission, STOP and final_answer.
- FILE OPS: prefer read_file/list_dir/search_dir/edit_file/write_file over
  cat/grep/ls/heredoc/printf via the terminal.
- Start dev servers ONLY as the LAST step, after all code/deps/config done.
- SCAFFOLDING: let scaffolders create their own dirs (don't mkdir first).
  Use non-interactive flags (--yes). If a target dir exists and conflicts,
  clean it first.
- IMAGES the user mentions were analyzed in a prior step — use the
  description, don't try to access them.
- TASK FOCUS: execute ONLY the [CURRENT TASK]. Prior conversation is
  reference; never re-run previous actions.
- CONVERSATIONAL: a greeting / casual chat with no task = brief friendly
  reply via final_answer. No exploration.
- NO EXTERNAL APIS: never curl/web_fetch JSON endpoints (yahoo finance,
  stock, weather). web_fetch on human-readable pages only.

${agentPrompt}
`,
        },
      ];
      // Build first user message — include images if provided
      if (images && images.length > 0) {
        if (provider === "ollama") {
          history.push({
            role: "user",
            content: prompt,
            images: images.map((img) => img.base64),
          });
        } else if (isAnthropicProtocol(provider)) {
          history.push({
            role: "user",
            content: [
              ...images.map((img) => ({
                type: "image",
                source: {
                  type: "base64",
                  media_type: img.mediaType,
                  data: img.base64,
                },
              })),
              { type: "text", text: prompt },
            ],
          });
        } else {
          // OpenAI-compatible (openai, gemini, deepseek, kimi, qwen, glm, lmstudio, openai-compat)
          history.push({
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...images.map((img) => ({
                type: "image_url",
                image_url: {
                  url: `data:${img.mediaType};base64,${img.base64}`,
                },
              })),
            ],
          });
        }
      } else {
        history.push({ role: "user", content: prompt });
      }
      executedCommands = new Set<string>();
      lastWriteDir = "";
      usedScaffold = false;
      wroteFiles = false;
      usedWebTools = false;
      terminalBusy = false;
    }

    // Detect terminal state by reading recent output.
    // If terminal is in alternate buffer, a TUI app (Claude Code, vim, etc.)
    // is definitely running — classify as "busy" even if output looks idle-ish.
    const detectTerminalState = async (): Promise<TerminalState> => {
      const output = await readTerminal(20);
      const state = classifyTerminalOutput(output);
      if (state === "idle" && options?.isAlternateBuffer?.()) {
        // Alternate buffer active but output looks idle — TUI is running
        // (e.g. Claude Code waiting for input, vim in normal mode)
        return "busy";
      }
      return state;
    };

    /**
     * Escalating strategy to stop a running process and return to idle shell.
     * Tries multiple approaches: Ctrl+C, double Ctrl+C, Enter+Ctrl+C, "q"+Enter, Ctrl+D.
     * Returns true if terminal reached idle state.
     */
    const smartStopProcess = async (): Promise<boolean> => {
      // Each strategy escalates a step. We deliberately exclude `q\r` and
      // bare `\x04` — they print literal characters into the shell input
      // buffer when the foreground process has already exited (the very
      // common case here, since smartStopProcess fires whenever Tron
      // *thinks* a process might be running). That left strays like
      // `lls -la` corrupting subsequent execs (observed in log
      // 1fc9961d1f.json). Rapid Ctrl+C bursts and Esc are buffer-safe.
      const strategies: { keys: string; label: string; delay: number }[] = [
        { keys: "\x03", label: "Ctrl+C", delay: 400 },
        { keys: "\x03\x03", label: "Ctrl+C x2", delay: 500 },
        { keys: "\x1b", label: "Esc (TUI exit)", delay: 400 },
        { keys: "\x03\x03\x03", label: "Ctrl+C x3", delay: 500 },
      ];
      for (const strategy of strategies) {
        await writeToTerminal(strategy.keys, true);
        for (let check = 0; check < 3; check++) {
          await new Promise((r) => setTimeout(r, strategy.delay));
          const state = classifyTerminalOutput(await readTerminal(10) || "");
          if (state === "idle") {
            // Belt-and-suspenders: send Ctrl+U to wipe any partial input
            // that the shell may still hold even when classifyTerminal-
            // Output reads "idle" — the prompt redraws on \r before the
            // input buffer is cleared.
            await writeToTerminal("\x15", true);
            await new Promise((r) => setTimeout(r, 50));
            return true;
          }
        }
      }
      return false;
    };

    let parseFailures = 0;
    // Loop detection: track recent actions to break repetitive patterns
    const recentActions: string[] = [];
    const recentCoarseKeys: string[] = []; // Coarse prefix-based tracking for semantic-loop detection
    // Full action history for LLM arbiter (tool, args, last outcome)
    const recentActionDetails: Array<{ tool: string; args: string; outcome?: string }> = [];
    let loopBreaks = 0; // Confirmed loops (by LLM arbiter). 3 → terminate.
    let recentlyBlockedAction: string | null = null; // Last action blocked by loop detection — cleared after any different action succeeds
    let lastArbiterStep = -1; // Step index of last arbiter call — rate-limit to avoid back-to-back LLM calls
    let lastArbiterSuggestion: string | null = null; // Suggestion from most recent confirmed loop — reshown until agent changes approach
    // Progress tracking
    let lastProgressStep = 0;
    let commandsSucceeded = 0;
    let commandsFailed = 0;
    let consecutiveBusy = 0; // Count consecutive busy-state skips to avoid infinite loops
    let consecutiveGuardBlocks = 0; // Global counter for ANY guard rejection — force-stops when too high
    let tuiExitFailures = 0; // Count consecutive TUI auto-exit failures — escalates to ask_question
    let lastReadTerminalOutput = ""; // Track consecutive identical read_terminal results
    let identicalReadCount = 0; // How many times in a row read_terminal returned the same content
    let readTerminalCount = 0; // Total consecutive read_terminal calls (for UI merging + backoff)
    let multiToolWarnings = 0; // Consecutive responses where model outputs multiple tool calls

    // ── Plan + Memory (Claude Code-inspired) ───────────────────────────────
    // Plan: agent emits todo_write to publish a checklist. We re-inject it
    // into history every loop iteration so the model can't "forget" what it
    // committed to. Memory: short notes the agent wants to keep across turns
    // (failed approaches, key paths, constraints). Both restore from
    // continuation so they survive ask_question pauses.
    let agentTodos: import("../../types").AgentTodo[] = continuation?.agentTodos
      ? [...continuation.agentTodos]
      : [];
    const agentMemory: string[] = continuation?.agentMemory
      ? [...continuation.agentMemory]
      : [];
    /** Counts substantive tool calls (not parse retries / loop blocks). Used
     *  to enforce plan-first: after N substantive calls without todo_write
     *  we inject a hard reminder. Resumed runs (continuation) are treated as
     *  if a plan already exists since the prior turn likely had one. */
    let substantiveSteps = 0;
    let hasPublishedPlan = (continuation?.agentTodos?.length ?? 0) > 0;
    let planNudgesSent = 0;
    /** Per-binary error counts — keyed by `${binary} ${subcommand}` extracted
     *  from execute_command. When the same combo errors twice with no
     *  intervening web_search/web_fetch/man, we block further invocations of
     *  that combo until research happens. Pure harness rule — small models
     *  ignore prompt directives but obey hard tool-call rejections. */
    const binaryErrorCounts = new Map<string, number>();
    /** Blocked binary combos waiting for research before retry. */
    const blockedBinaries = new Set<string>();

    // ── Repeated error / stagnation detection ──────────────────────────────
    // Tracks error "signatures" (TypeError, SyntaxError, module not found, etc.)
    // across both command failures (exit code != 0) and successful outputs that
    // contain error stack traces. When the same error type recurs 3+ times, a
    // strong intervention is injected telling the agent to investigate root cause.
    const recentErrorSignatures: string[] = [];

    /** Extract a canonical error signature from any text (stdout, stderr, error msg). */
    const extractErrorSignature = (msg: string): string | null => {
      // Common JS/TS runtime errors
      const patterns: [RegExp, string][] = [
        [/TypeError:\s*(.{0,80})/, "TypeError"],
        [/SyntaxError:\s*(.{0,80})/, "SyntaxError"],
        [/ReferenceError:\s*(.{0,80})/, "ReferenceError"],
        [/RangeError:\s*(.{0,80})/, "RangeError"],
        [/Cannot find module\s+'([^']{0,80})'/, "ModuleNotFound"],
        // Python
        [/ModuleNotFoundError:\s*(.{0,80})/, "ModuleNotFound"],
        [/ImportError:\s*(.{0,80})/, "ImportError"],
        [/NameError:\s*(.{0,80})/, "NameError"],
        [/AttributeError:\s*(.{0,80})/, "AttributeError"],
        // Rust / Go / general
        [/error\[E\d+\]:\s*(.{0,80})/, "CompileError"],
        [/cannot find (?:crate|package)\s+'?(.{0,60})'?/, "ModuleNotFound"],
        // Generic "command not found"
        [/command not found:\s*(.{0,60})/, "CommandNotFound"],
        // Permissions
        [/EACCES:\s*(.{0,80})/, "PermissionError"],
        [/Permission denied/, "PermissionError"],
      ];
      for (const [re, prefix] of patterns) {
        const m = msg.match(re);
        if (m) return `${prefix}: ${m[1]?.trim() || m[0].trim()}`;
      }
      return null;
    };

    /**
     * Record an error signature from any text (command output or error message).
     * Returns an intervention prompt if the same error pattern has recurred 3+ times.
     */
    const checkRepeatedErrors = (text: string): string | null => {
      const sig = extractErrorSignature(text);
      if (!sig) return null;
      recentErrorSignatures.push(sig);
      // Keep only last 12
      if (recentErrorSignatures.length > 12) recentErrorSignatures.shift();
      // Fuzzy match: same error type prefix (e.g. "TypeError: chalk" matches "TypeError: chalk.cyan")
      const prefix = sig.slice(0, Math.min(30, sig.indexOf(":") + 10));
      const count = recentErrorSignatures.filter(s => s.startsWith(prefix)).length;
      if (count >= 3) {
        recentErrorSignatures.length = 0; // Reset so it doesn't fire every step
        return `CRITICAL: The same error has occurred ${count} times: "${sig}"\n\nYou are stuck in an unproductive loop. STOP trying syntax variations and investigate the ROOT CAUSE:\n1. Check the library version: run a diagnostic command (e.g. "node -e \\"console.log(require('<pkg>/package.json').version)\\"", "pip show <pkg>", "cat Cargo.toml")\n2. Check if it's an ESM vs CommonJS issue (v5+ of many npm packages are ESM-only — require() won't work)\n3. Read the library's actual API for the installed version — don't guess\n4. If the library is incompatible, install a compatible version (e.g. "npm install chalk@4") or use a completely different library\n5. If nothing works, simplify: remove the dependency and use plain code instead\n\nDo NOT make the same kind of edit again without first diagnosing the issue.`;
      }
      return null;
    };

    /** Extract `${binary} ${subcommand}` from an execute_command — the unit
     *  we track for the "search before reprobing" rule. Skips shell glue
     *  like `cd …`, pipes, redirects so `cd /tmp && openclaw foo` keys on
     *  `openclaw foo`, not `cd /tmp`. */
    const extractBinaryKey = (cmd: string): string | null => {
      if (!cmd) return null;
      // Strip leading `cd path && ` / `cd path; ` chunks
      const stripped = cmd
        .replace(/^cd\s+\S+\s*(?:&&|;)\s*/g, "")
        .replace(/^env\s+\S+=\S+\s+/g, "")
        .trim();
      // Take first command before the first pipe/&&/||/;
      const head = stripped.split(/[|;]|&&|\|\|/)[0].trim();
      const tokens = head.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return null;
      const bin = tokens[0];
      // Skip generic shell builtins where this rule isn't useful
      if (/^(ls|cat|grep|find|echo|printf|cd|pwd|head|tail|wc|sed|awk|cut|sort|uniq|tr|xargs|test|true|false|exit|return)$/.test(bin)) {
        return null;
      }
      // For `docker exec NAME node X.mjs sub args`, key on `docker exec node X.mjs sub`
      // We compress to first 4 tokens to avoid overfitting on argument values.
      const sub = tokens.slice(1, 4).filter((t) => !t.startsWith("-")).join(" ");
      return sub ? `${bin} ${sub}` : bin;
    };

    // "User ready / continue" signal from UI (e.g. Continue button in overlay)
    // Uses a global flag checked each read_terminal iteration
    (globalThis as any).__tronAgentContinue = false;

    for (let i = 0; i < maxSteps; i++) {
      if (signal?.aborted) {
        throw new Error("Agent aborted by user.");
      }
      // Circuit breaker: if too many consecutive guard rejections, reset scaffold state and unblock
      if (consecutiveGuardBlocks >= 3) {
        onUpdate(
          "failed",
          `Circuit breaker: ${consecutiveGuardBlocks} consecutive blocks — resetting guards`,
        );
        // Reset scaffold flag — the scaffold likely failed if agent keeps getting blocked
        usedScaffold = false;
        executedCommands.clear();
        history.push({
          role: "user",
          content:
            "Previous guards have been reset. You can now run commands freely. Re-assess the current state: use read_terminal to check what happened, then decide the best approach.",
        });
        consecutiveGuardBlocks = 0;
      }
      // Clear any leftover streaming entries from previous iteration (e.g. guard-rejected responses)
      onUpdate("clear_streaming", "");

      // Re-inject the current plan + memory at the top of each iteration so
      // the model can't drift from its committed checklist or forget what it
      // already learned. Sentinel lets us drop the previous block before
      // pushing a fresh one — keeps history bounded.
      // eslint-disable-next-line no-inner-declarations
      {
        const SENTINEL = "[STATE_REMINDER]";
        // Drop any prior reminder so we can push a fresh one without growth.
        for (let k = history.length - 1; k >= 0; k--) {
          const m = history[k];
          if (
            m &&
            m.role === "user" &&
            typeof m.content === "string" &&
            m.content.startsWith(SENTINEL)
          ) {
            history.splice(k, 1);
            break;
          }
        }

        // Scan recent history for <tool_use_error> blocks so we can show the
        // model what's already failed. Walks last 30 messages, dedupes by
        // (tool, first-80-chars-of-args), keeps most recent 5. The model's
        // own attention often misses these in long histories — re-injecting
        // at the top of every turn makes them impossible to ignore.
        const failures: Array<{ tool: string; args: string; error: string }> = [];
        const seen = new Set<string>();
        const ERR_RE = /<tool_use_error>([^:]+?)\s*(?:failed)?:\s*([^<]*)<\/tool_use_error>/i;
        // Walk newest → oldest; insert at front so final order is oldest → newest
        // (newest at the bottom = closest to the model's attention).
        const HISTORY_SCAN = Math.min(30, history.length);
        const collected: typeof failures = [];
        for (let k = history.length - 1; k >= history.length - HISTORY_SCAN; k--) {
          const m = history[k];
          if (!m || m.role !== "user" || typeof m.content !== "string") continue;
          const match = m.content.match(ERR_RE);
          if (!match) continue;
          const tool = match[1].trim().slice(0, 30);
          const error = match[2].trim().slice(0, 160);
          // Pull the action that triggered this from the preceding assistant msg
          let args = "";
          for (let j = k - 1; j >= Math.max(0, k - 3); j--) {
            const am = history[j];
            if (am?.role === "assistant" && typeof am.content === "string") {
              try {
                const obj = JSON.parse(am.content);
                args = String(
                  obj?.command ?? obj?.path ?? obj?.url ?? obj?.query ?? "",
                ).slice(0, 80);
              } catch { /* ignore parse — args stays "" */ }
              break;
            }
          }
          const dedup = `${tool}:${args}`;
          if (seen.has(dedup)) continue;
          seen.add(dedup);
          collected.unshift({ tool, args, error });
          if (collected.length >= 5) break;
        }
        failures.push(...collected);

        const hasState =
          agentTodos.length > 0 ||
          agentMemory.length > 0 ||
          failures.length > 0;

        if (hasState) {
          const lines: string[] = [SENTINEL];
          if (agentTodos.length > 0) {
            lines.push("[PLAN]");
            for (let i = 0; i < agentTodos.length; i++) {
              const t = agentTodos[i];
              const mark =
                t.status === "completed"
                  ? "✓"
                  : t.status === "in_progress"
                    ? "→"
                    : "○";
              lines.push(`${mark} ${i + 1}. ${t.content}`);
            }
            lines.push("");
          }
          if (failures.length > 0) {
            lines.push("[FAILED ATTEMPTS — do not retry these verbatim]");
            for (const f of failures) {
              const argPart = f.args ? ` ${f.args}` : "";
              lines.push(`- ${f.tool}${argPart} → ${f.error}`);
            }
            lines.push("");
          }
          if (agentMemory.length > 0) {
            lines.push("[MEMORY]");
            for (const m of agentMemory) lines.push(`- ${m}`);
            lines.push("");
          }
          lines.push(
            "(Stay on the in-progress / pending plan item. If the same kind of action keeps failing, web_search the docs OR ask_question. Use remember() to add new constraints.)",
          );
          history.push({ role: "user", content: lines.join("\n") });
        }
      }

      // Plan-first enforcement. Past a few substantive steps with no plan
      // published, the agent is wandering — inject a forcing nudge. Models
      // that ignored the system-prompt PLAN FIRST rule respond well to a
      // mid-stream user message that demands the next action shape.
      if (!hasPublishedPlan && substantiveSteps >= 5 && planNudgesSent === 0) {
        history.push({
          role: "user",
          content:
            "[plan check] You've taken 5+ tool calls without publishing a plan. STOP exploring. Your NEXT response MUST be a todo_write call with 3-7 short, verb-led steps describing the work ahead. After that, work the list one item at a time. If the original task is genuinely ambiguous (e.g. recipient unspecified, multiple plausible targets), use ask_question instead of guessing.",
        });
        planNudgesSent = 1;
      } else if (!hasPublishedPlan && substantiveSteps >= 12 && planNudgesSent < 2) {
        history.push({
          role: "user",
          content:
            "[plan check — final] You have ignored the planning request. You are clearly stuck or going in circles. Either: (a) emit todo_write NOW with a plan reflecting what you've discovered, (b) emit ask_question to clarify the user's intent, or (c) emit final_answer reporting what you've found and what blocked you. Any other tool call will be terminated.",
        });
        planNudgesSent = 2;
      }

      if (thinkingEnabled) {
        onUpdate("thinking", "Agent is thinking...");
      }

      let responseText = "";

      // 1. Get LLM Response (streaming for Ollama)
      let thinkingText = "";

      // Thinking-tag interceptor: detects <think>/<thinking>/<thought> in regular
      // token stream (e.g. LM Studio) and reroutes to thinking accumulator.
      const thinkTagOpenRe = /^<(think|thinking|thought)>/i;
      const thinkTagCloseRe = /<\/(think|thinking|thought)>/i;
      let _inThinkTag = false;
      let _tokenBuf = ""; // buffer for detecting opening tag at stream start
      const interceptThinkingTokens = (
        token: string,
        thinkingAcc: { value: string },
        contentAcc: { value: string },
      ) => {
        _tokenBuf += token;
        // Detect opening tag at start of stream
        if (!_inThinkTag && _tokenBuf.length <= 30) {
          if (thinkTagOpenRe.test(_tokenBuf.trimStart())) {
            _inThinkTag = true;
            // Persist this model as a thinking model for future sessions
            this.markModelAsThinking(provider, model);
            const afterTag = _tokenBuf.trimStart().replace(thinkTagOpenRe, "");
            if (afterTag) {
              thinkingAcc.value += afterTag;
              if (thinkingEnabled) onUpdate("streaming_thinking", thinkingAcc.value);
            }
            return;
          }
          // Partial tag — wait for more
          if (/^<(t|th|thi|thin|think|thinki|thinkin|thinking|thou|thoug|though|thought)$/i.test(_tokenBuf.trimStart())) {
            return;
          }
        }
        if (_inThinkTag) {
          const closeMatch = _tokenBuf.match(thinkTagCloseRe);
          if (closeMatch) {
            const closeIdx = _tokenBuf.indexOf(closeMatch[0]);
            _inThinkTag = false;
            // Anything after closing tag is real content
            const afterClose = _tokenBuf.substring(closeIdx + closeMatch[0].length);
            // Flush thinking (strip the close tag from token)
            const thinkPart = token.replace(thinkTagCloseRe, "").replace(/[\s\S]*$/, "");
            if (thinkPart) {
              thinkingAcc.value += thinkPart;
              if (thinkingEnabled) onUpdate("streaming_thinking", thinkingAcc.value);
            }
            if (afterClose.trim()) {
              contentAcc.value += afterClose;
              onUpdate("streaming_response", contentAcc.value);
            }
            // Reset buffer to only content after close
            _tokenBuf = afterClose;
          } else {
            thinkingAcc.value += token;
            if (thinkingEnabled) onUpdate("streaming_thinking", thinkingAcc.value);
          }
          return;
        }
        contentAcc.value += token;
        onUpdate("streaming_response", contentAcc.value);
      };

      try {
        if (provider === "ollama") {
          let thinkingAccumulated = "";
          const thinkAcc = { value: "" };
          const contentAcc = { value: "" };
          const result = await this.streamOllamaChat(
            baseUrl || "http://localhost:11434",
            model,
            history,
            (token, thinking) => {
              if (thinking && thinkingEnabled) {
                thinkingAccumulated += thinking;
                onUpdate("streaming_thinking", thinkingAccumulated);
              }
              if (token) {
                interceptThinkingTokens(token, thinkAcc, contentAcc);
              }
            },
            signal,
            "json",
            thinkingEnabled,
            apiKey,
          );
          // Use intercepted content if thinking tags were detected in token stream
          responseText = thinkAcc.value ? contentAcc.value : result.content;
          thinkingText = result.thinking || thinkAcc.value;
          if (thinkingAccumulated || thinkAcc.value) {
            onUpdate("thinking_complete", thinkingAccumulated || thinkAcc.value);
          } else {
            onUpdate("thinking_done", "");
          }
        } else if (
          isAnthropicProtocol(provider) &&
          (apiKey || provider === "anthropic-compat")
        ) {
          // Anthropic Messages API with streaming
          let contentAccumulated = "";
          let thinkingAccumulated = "";
          const anthropicBody: any = {
            model,
            max_tokens: thinkingEnabled ? 128000 : 16384,
            system: history[0].content,
            messages: history.slice(1),
            stream: true,
          };
          if (thinkingEnabled) {
            anthropicBody.thinking = { type: "enabled", budget_tokens: Math.min(32000, anthropicBody.max_tokens - 1024) };
          }
          let response = await proxyFetch(getAnthropicChatUrl(provider, baseUrl), {
            method: "POST",
            headers: this.anthropicHeaders(apiKey),
            body: JSON.stringify(anthropicBody),
            signal,
          });
          if (!response.ok) {
            const errBody = await response.text().catch(() => "");
            // If thinking failed (model doesn't support it), retry without
            if (thinkingEnabled && response.status === 400) {
              delete anthropicBody.thinking;
              anthropicBody.max_tokens = 16384;
              response = await proxyFetch(getAnthropicChatUrl(provider, baseUrl), {
                method: "POST",
                headers: this.anthropicHeaders(apiKey),
                body: JSON.stringify(anthropicBody),
                signal,
              });
              if (!response.ok) {
                const retryErr = await response.text().catch(() => "");
                throw new Error(
                  `${CLOUD_PROVIDERS[provider]?.label || provider} server error (${response.status}): ${retryErr.slice(0, 300)}`,
                );
              }
            } else {
              throw new Error(
                `${CLOUD_PROVIDERS[provider]?.label || provider} server error (${response.status}): ${errBody.slice(0, 300)}`,
              );
            }
          }
          if (!response.body) throw new Error("No response body from server");

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data: ")) continue;
              try {
                const evt = JSON.parse(trimmed.slice(6));
                if (evt.type === "content_block_delta") {
                  if (evt.delta?.type === "thinking_delta" && evt.delta?.thinking) {
                    thinkingAccumulated += evt.delta.thinking;
                    if (thinkingEnabled) onUpdate("streaming_thinking", thinkingAccumulated);
                  } else if (evt.delta?.text) {
                    contentAccumulated += evt.delta.text;
                    onUpdate("streaming_response", contentAccumulated);
                  }
                }
              } catch { }
            }
          }
          responseText = contentAccumulated;
          thinkingText = thinkingAccumulated;
          if (thinkingAccumulated) {
            onUpdate("thinking_complete", thinkingAccumulated);
          } else {
            onUpdate("thinking_done", "");
          }
        } else if (
          isOpenAICompatible(provider) &&
          (apiKey || providerUsesBaseUrl(provider))
        ) {
          // OpenAI-compatible cloud providers with streaming
          let thinkingAccumulated = "";
          // Reset interceptor state for this provider branch
          _inThinkTag = false;
          _tokenBuf = "";
          const oaiThinkAcc = { value: "" };
          const oaiContentAcc = { value: "" };
          const result = await this.streamOpenAIChat(
            provider,
            model,
            apiKey || "",
            history,
            (token, thinking) => {
              if (thinking && thinkingEnabled) {
                thinkingAccumulated += thinking;
                onUpdate("streaming_thinking", thinkingAccumulated);
              }
              if (token) {
                interceptThinkingTokens(token, oaiThinkAcc, oaiContentAcc);
              }
            },
            signal,
            "json",
            baseUrl,
            thinkingEnabled,
          );
          responseText = oaiThinkAcc.value ? oaiContentAcc.value : result.content;
          thinkingText = result.thinking || oaiThinkAcc.value;
          if (thinkingAccumulated || oaiThinkAcc.value) {
            onUpdate("thinking_complete", thinkingAccumulated || oaiThinkAcc.value);
          } else {
            onUpdate("thinking_done", "");
          }
        } else {
          throw new Error(
            `${CLOUD_PROVIDERS[provider]?.label || provider} requires an API key.Configure it in Settings.`,
          );
        }
      } catch (e: any) {
        if (signal?.aborted) {
          throw new Error("Agent aborted by user.");
        }
        // AbortError from timeout or model failure — NOT a user abort, treat as API error
        if (e.name === "AbortError" && !signal?.aborted) {
          const label = CLOUD_PROVIDERS[provider]?.label || provider;
          const safeMsg = sanitizeError(e.message || "Request timed out");
          onUpdate("error", `${label} error: ${safeMsg}`);
          return { success: false, message: `${label}: ${safeMsg}` };
        }
        const label = CLOUD_PROVIDERS[provider]?.label || provider;
        // "Failed to fetch" = CORS/network failure — unrecoverable, fail immediately
        const isFetchError = e.message === "Failed to fetch" || e instanceof TypeError;
        if (isFetchError) {
          const detail = "Network error — could not reach the API. Check your internet connection and API key.";
          onUpdate("error", `${label} error: ${detail} `);
          return { success: false, message: `${label}: ${detail}` };
        }
        // API/model errors (invalid format, model refusal, etc.) — silent retry up to 3 times
        parseFailures++;
        const safeErrMsg = sanitizeError(e.message || "Unknown error");
        if (parseFailures >= 3) {
          onUpdate("error", `${label} error: ${safeErrMsg} `);
          return { success: false, message: `${label}: ${safeErrMsg}` };
        }
        // Push error context so model can adjust on retry
        history.push({ role: "assistant", content: "(API error)" });
        history.push({
          role: "user",
          content: `Error from API: ${safeErrMsg}\nPlease retry. Respond with ONLY a JSON object — no markdown, no explanation.`,
        });
        continue;
      }

      // Strip any remaining thinking tags from response text (providers that embed them inline)
      responseText = responseText.replace(/<(think|thinking|thought)>[\s\S]*?<\/(think|thinking|thought)>/gi, "").trim();

      // 2. Parse Tool Call — try content first, then extract from thinking
      let action: any;
      // Convert \xHH escapes (invalid JSON) to \u00HH (valid JSON) inside strings
      const fixJsonEscapes = (raw: string): string =>
        raw.replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1");

      /** Escape bare newlines/tabs inside JSON string values (not structural whitespace). */
      const escapeNewlinesInStrings = (text: string): string => {
        let result = "";
        let inStr = false;
        let esc = false;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (esc) { result += ch; esc = false; continue; }
          if (ch === "\\") { result += ch; esc = true; continue; }
          if (ch === '"') { inStr = !inStr; result += ch; continue; }
          if (inStr) {
            if (ch === "\n") { result += "\\n"; continue; }
            if (ch === "\r") { result += "\\r"; continue; }
            if (ch === "\t") { result += "\\t"; continue; }
          }
          result += ch;
        }
        return result;
      };

      // Known tool names — used to normalize {"tool_name": {...}} into {"tool": "tool_name", ...}
      const TOOL_NAMES = new Set([
        "execute_command", "run_in_terminal", "send_text", "read_terminal",
        "write_file", "read_file", "edit_file", "list_dir", "search_dir",
        "web_search", "web_fetch",
        "todo_write", "remember",
        "ask_question", "final_answer",
      ]);

      // If the model used a tool name as a top-level key (e.g. {"final_answer": {"content":"..."}})
      // restructure it into {"tool": "final_answer", "content": "..."}
      const normalizeToolKey = (obj: any): any => {
        // Some models wrap tool calls in an array, e.g. [{"tool":"execute_command","command":"..."}]
        if (Array.isArray(obj)) {
          if (obj.length > 0 && typeof obj[0] === "object") return normalizeToolKey(obj[0]);
          return obj;
        }
        if (!obj || typeof obj !== "object" || obj.tool) return obj;
        const keys = Object.keys(obj);
        const toolKey = keys.find((k) => TOOL_NAMES.has(k));
        if (toolKey) {
          const val = obj[toolKey];
          const { [toolKey]: _, ...rest } = obj;
          if (typeof val === "string") {
            // e.g. {"final_answer": "Done."} → {"tool":"final_answer","content":"Done."}
            // Tools that expect a "command" property need it mapped correctly
            const COMMAND_TOOLS = new Set(["execute_command", "run_in_terminal"]);
            const prop = COMMAND_TOOLS.has(toolKey) ? "command" : "content";
            return { tool: toolKey, [prop]: val, ...rest };
          }
          if (typeof val === "object" && val !== null) {
            // e.g. {"final_answer": {"content":"Done."}} → {"tool":"final_answer","content":"Done."}
            return { tool: toolKey, ...val, ...rest };
          }
          return obj;
        }
        // Handle model-specific {"cmd":["bash","-lc","actual_command"]} format (e.g. gpt-oss-120b)
        if (obj.cmd) {
          const command = Array.isArray(obj.cmd)
            ? obj.cmd[obj.cmd.length - 1]
            : typeof obj.cmd === "string"
              ? obj.cmd
              : null;
          if (typeof command === "string") {
            return { tool: "execute_command", command };
          }
        }
        return obj;
      };

      const tryParseJson = (text: string): any => {
        if (!text.trim()) return null;

        // 1. Try direct parse first (with \x escape fix)
        try {
          return normalizeToolKey(JSON.parse(fixJsonEscapes(text)));
        } catch { }

        // 1b. Repair bare newlines inside JSON strings (common in write_file content)
        try {
          return normalizeToolKey(JSON.parse(escapeNewlinesInStrings(fixJsonEscapes(text))));
        } catch { }

        // 2. Markdown code block extraction (handles ```json, ```JSON, ```, etc.)
        const mdMatch = text.match(/```\w*\s*([\s\S]*?)```/);
        if (mdMatch) {
          try {
            return normalizeToolKey(JSON.parse(fixJsonEscapes(mdMatch[1].trim())));
          } catch { }
        }

        // 3. Extract JSON from model-specific token-wrapped responses
        // Some models wrap output in <|channel|>...<|message|>{...} format
        const lastTokenIdx = text.lastIndexOf("<|");
        if (lastTokenIdx >= 0) {
          const closingIdx = text.indexOf("|>", lastTokenIdx);
          if (closingIdx >= 0) {
            const afterLastToken = text.slice(closingIdx + 2).trim();
            if (afterLastToken.startsWith("{")) {
              try {
                return normalizeToolKey(
                  JSON.parse(fixJsonEscapes(afterLastToken)),
                );
              } catch { }
            }
          }
        }

        // 4. Robust extraction: scan for balanced {} objects and try each
        let searchFrom = 0;
        while (searchFrom < text.length) {
          const openIdx = text.indexOf("{", searchFrom);
          if (openIdx === -1) break;

          let balance = 0;
          let inStr = false;
          let esc = false;
          let endIdx = -1;

          for (let i = openIdx; i < text.length; i++) {
            const char = text[i];
            if (esc) {
              esc = false;
              continue;
            }
            if (char === "\\") {
              esc = true;
              continue;
            }
            if (char === '"') {
              inStr = !inStr;
              continue;
            }
            if (!inStr) {
              if (char === "{") balance++;
              else if (char === "}") {
                balance--;
                if (balance === 0) {
                  endIdx = i;
                  break;
                }
              }
            }
          }

          if (endIdx === -1) break; // unbalanced — stop

          const candidate = fixJsonEscapes(text.slice(openIdx, endIdx + 1));
          try {
            const obj = normalizeToolKey(JSON.parse(candidate));
            if (obj.tool || obj.content) return obj;
          } catch {
            // Try repairing bare newlines inside strings
            try {
              const obj = normalizeToolKey(JSON.parse(escapeNewlinesInStrings(candidate)));
              if (obj.tool || obj.content) return obj;
            } catch { }
            // Try fixing trailing commas: ,} → }
            const fixed = candidate
              .replace(/,\s*}/g, "}")
              .replace(/,\s*]/g, "]");
            try {
              const obj = normalizeToolKey(JSON.parse(fixed));
              if (obj.tool || obj.content) return obj;
            } catch { }
          }

          // This {} didn't match — continue searching after it
          searchFrom = endIdx + 1;
        }

        return null;
      };

      action = tryParseJson(responseText);
      // Fallback: model may put JSON in thinking instead of content
      if (!action?.tool && !action?._plan && thinkingText) {
        action = tryParseJson(thinkingText);
      }

      // Plan responses don't need a tool — they'll be handled before tool dispatch
      if (action && action._plan) {
        // pass through to plan handler below
      } else if (!action || !action.tool) {
      // Coerce tool-less objects or plain conversational text into proper tool calls
        if (!action) {
          const trimmed = (responseText || "").trim();

          // Detect bracket-style tool invocations: [read_terminal], [execute_command ls], etc.
          // Some models output tool names in brackets instead of JSON.
          const bracketMatch = trimmed.match(/^\[(\w+)\](.*)$/s);
          if (bracketMatch && TOOL_NAMES.has(bracketMatch[1])) {
            const toolName = bracketMatch[1];
            const arg = bracketMatch[2].trim();
            action = { tool: toolName };
            if (toolName === "execute_command" || toolName === "run_in_terminal") {
              action.command = arg || "echo 'no command provided'";
            } else if (toolName === "read_terminal") {
              action.lines = 50;
            } else if (toolName === "final_answer") {
              action.content = arg || "Done.";
            } else if (toolName === "ask_question") {
              action.question = arg || "Could you clarify?";
            } else if (arg) {
              action.content = arg;
            }
          } else if (trimmed && !trimmed.includes("{")) {
            // Plain text without JSON braces
            action = {};
            if (/^(please clarify|what|how|can you|could you|would you)\b/i.test(trimmed) || trimmed.includes("?")) {
              action.tool = "ask_question";
              action.question = trimmed;
            } else if (trimmed.length < 500) {
              action.tool = "final_answer";
              action.content = trimmed;
            } else {
              action = null; // Too long, let it fail
            }
          }
        } else if (typeof action.command === "string") {
          action.tool = "execute_command";
        } else if (typeof action.question === "string") {
          action.tool = "ask_question";
        } else if (typeof action.error === "string") {
          if (/\b(clarify|understand|help with|what|how|please)\b/i.test(action.error) || action.error.includes("?")) {
            action.tool = "ask_question";
            action.question = action.error;
          } else {
            action.tool = "final_answer";
            action.content = action.error;
          }
        } else if (typeof action.content === "string") {
          if (/^(please clarify|what|how|can you|could you|would you)\b/i.test(action.content.trim()) || action.content.includes("?")) {
            action.tool = "ask_question";
            action.question = action.content;
          } else {
            action.tool = "final_answer";
          }
        } else {
          // Small models often use non-standard keys like "answer", "response", "text", "message", "result", "reply", "output"
          const answerKey = ["answer", "response", "text", "message", "result", "reply", "output"].find(
            (k) => typeof action[k] === "string"
          );
          if (answerKey) {
            const val = action[answerKey] as string;
            if (/^(please clarify|what|how|can you|could you|would you)\b/i.test(val.trim()) || val.includes("?")) {
              action.tool = "ask_question";
              action.question = val;
            } else {
              action.tool = "final_answer";
              action.content = val;
            }
          }
        }
      }

      if ((!action || !action.tool) && !(action && action._plan)) {
        parseFailures++;

        // Remove the thought step that was just emitted for this failed parse attempt.
        // Without this, each silent retry creates a visible thought in the overlay,
        // causing repetitive thought spam (e.g. 14 consecutive thoughts before any action).
        onUpdate("retract_thought", "");

        // Inline retry: re-call the LLM without adding failed attempts to history.
        // This avoids polluting context with bad output from weaker models.
        // Only after all inline retries are exhausted do we add a correction to history.
        const MAX_INLINE_RETRIES = 5;
        if (parseFailures <= MAX_INLINE_RETRIES) {
          // For the first few failures, retry inline (same history, no new messages)
          // For the last attempt before giving up, add a correction hint to history
          if (parseFailures === MAX_INLINE_RETRIES) {
            const truncatedResponse = (responseText || "(empty)").slice(0, 500);
            history.push({ role: "assistant", content: truncatedResponse });
            history.push({
              role: "user",
              content:
                'Error: Invalid response. You MUST respond with ONLY a JSON object. No markdown, no explanation, no thinking. Example: {"tool": "execute_command", "command": "ls"} or {"tool": "final_answer", "content": "Done."}',
            });
          }
          continue;
        }

        // All retries exhausted — fall back gracefully
        const fallbackText = (responseText || thinkingText || "").trim();
        // If we got plain text that isn't a confused JSON tool call, use it as the answer
        const hasToolCallJSON = /{"tool"\s*:/.test(fallbackText);
        if (fallbackText.length > 0 && !hasToolCallJSON) {
          return {
            success: true,
            message: fallbackText.slice(0, 2000),
            type: "success",
          };
        }
        return {
          success: false,
          message:
            "This model failed to follow the agent protocol after multiple retries. Try a more capable model.",
        };
      }
      parseFailures = 0; // Reset on successful parse

      // ── Multi-tool-call detection ──────────────────────────────────────
      // Some models (especially smaller/local ones) generate multiple tool
      // calls in a single response instead of waiting for each result.
      // The parser picks the first one, but the model keeps repeating this
      // pattern and never makes progress. Detect and inject correction.
      const toolCallMatches = (responseText || "").match(/\{"tool"\s*:/g);
      if (toolCallMatches && toolCallMatches.length > 1) {
        multiToolWarnings++;
        if (multiToolWarnings >= 3) {
          // Model is stuck in multi-tool pattern — force final_answer
          consecutiveGuardBlocks++;
          history.push({ role: "assistant", content: JSON.stringify(action) });
          history.push({
            role: "user",
            content: "CRITICAL: You keep outputting multiple tool calls in one response. This is NOT supported. You can only use ONE tool per response, then WAIT for the result. Summarize your progress and finish with final_answer.",
          });
          multiToolWarnings = 0;
          continue;
        }
        // Inject one-at-a-time reminder with the tool result
        // (appended to the tool result message below, not here)
      } else {
        multiToolWarnings = 0; // Reset when model responds with single tool call
      }

      history.push({ role: "assistant", content: JSON.stringify(action) });

      // Loop detection: heuristics flag suspicion; an LLM arbiter confirms
      // whether the agent is actually stuck. Arbiter-confirmed loops redirect
      // with concrete suggestions; 3 confirmations terminate the agent.
      const actionKey = JSON.stringify({
        tool: action.tool,
        path: action.path,
        command: action.command,
        text: action.text,
        query: action.query,
        url: action.url,
      });

      // Block the most recently *arbiter-confirmed* looped action — cleared
      // once the agent actually tries something different
      if (actionKey && recentlyBlockedAction === actionKey) {
        history.push({
          role: "user",
          content: `BLOCKED: you tried the SAME action again after a loop warning. You MUST use a different tool or different parameters${lastArbiterSuggestion ? `. Specifically: ${lastArbiterSuggestion}` : ""}. If you cannot proceed, use final_answer.`,
        });
        continue;
      }
      // Agent moved on to a different action — clear the block
      if (actionKey && recentlyBlockedAction && actionKey !== recentlyBlockedAction) {
        recentlyBlockedAction = null;
        lastArbiterSuggestion = null;
      }

      if (actionKey) recentActions.push(actionKey);
      if (recentActions.length > 8) recentActions.shift();

      // Consecutive suspicion: same exact action N times in a row.
      // Tools that legitimately repeat (send_text for menu nav, read_terminal
      // for monitoring) get a higher tolerance. Everything else (exec, edits,
      // file reads) is suspicious on the *second* identical call — re-running
      // the same `sed` or `edit_file` back-to-back is almost always a model
      // glitch (observed pattern: model emits the same command twice in
      // consecutive responses without learning from the first result).
      const maxConsecutive = action.tool === "send_text" ? 5 : action.tool === "read_terminal" ? 5 : 2;
      let isConsecutiveSuspicion = false;
      if (actionKey != null && recentActions.length >= maxConsecutive) {
        isConsecutiveSuspicion = true;
        for (let i = 1; i <= maxConsecutive; i++) {
          if (recentActions[recentActions.length - i] !== actionKey) {
            isConsecutiveSuspicion = false;
            break;
          }
        }
      }

      // Alternating suspicion: A→B→A→B→A→B pattern
      const isAlternatingSuspicion =
        recentActions.length >= 6 &&
        recentActions[recentActions.length - 1] ===
        recentActions[recentActions.length - 3] &&
        recentActions[recentActions.length - 3] ===
        recentActions[recentActions.length - 5] &&
        recentActions[recentActions.length - 2] ===
        recentActions[recentActions.length - 4] &&
        recentActions[recentActions.length - 4] ===
        recentActions[recentActions.length - 6];

      // Semantic suspicion: coarse-prefix match catches minor-variation probes
      // (different python one-liners, grep patterns, JSON paths) all doing the
      // same diagnostic work.
      const coarseArgs = action.command || action.query || action.path || action.url || "";
      const coarseKey = action.tool === "write_file" || action.tool === "edit_file"
        ? `${action.tool}:${action.path || ""}`
        : `${action.tool}:${coarseArgs.slice(0, 50)}`;
      recentCoarseKeys.push(coarseKey);
      if (recentCoarseKeys.length > 12) recentCoarseKeys.shift();
      const coarseThreshold = action.tool === "read_terminal" || action.tool === "send_text" ? 8 : 5;
      const coarseCount = recentCoarseKeys.filter((k) => k === coarseKey).length;
      const isSemanticSuspicion = coarseCount >= coarseThreshold;

      // Record action detail for arbiter context (cap at last 15)
      recentActionDetails.push({ tool: action.tool, args: coarseArgs || action.text || "" });
      if (recentActionDetails.length > 15) recentActionDetails.shift();

      const suspicionTriggered =
        isConsecutiveSuspicion || isAlternatingSuspicion || isSemanticSuspicion;

      if (suspicionTriggered) {
        // Rate-limit arbiter: don't call again within 3 steps of a previous call
        // (arbiter itself costs an LLM roundtrip; false positives don't block)
        if (lastArbiterStep >= 0 && i - lastArbiterStep < 3) {
          // Treat as benign — heuristic already asked recently, give it space
        } else {
          lastArbiterStep = i;
          // Don't emit a "thinking" update here — that surfaces as a thought
          // entry in the agent thread (especially jarring on non-thinking
          // models). The arbiter is a fast background check; users only need
          // to know about it if it actually blocks an action, in which case
          // the LOOP DETECTED message below handles it.
          const taskForArbiter = options?.rawUserTask || prompt || "";
          const arbiter = await this.arbitrateAgentLoop(
            taskForArbiter,
            recentActionDetails.slice(-15),
            { tool: action.tool, args: coarseArgs || action.text || "" },
            cfg,
            signal,
          );

          if (arbiter.stuck) {
            loopBreaks++;
            if (actionKey) recentlyBlockedAction = actionKey;
            lastArbiterSuggestion = arbiter.suggestion || null;
            recentActions.length = 0;
            recentCoarseKeys.length = 0;

            if (loopBreaks >= 3) {
              // Don't terminate silently — flip to ask_question so the user
              // can unblock. The agent has been spinning; the user knows
              // what they want and can usually clarify in one sentence.
              const tried = recentActionDetails
                .slice(-6)
                .map((a) => `${a.tool}(${a.args.slice(0, 60)})`)
                .join("; ");
              const question = arbiter.suggestion
                ? `I've gotten stuck. ${arbiter.suggestion} (Recent attempts: ${tried || "various"}). How should I proceed?`
                : `I've tried several approaches but can't make progress. Recent attempts: ${tried || "various exploration commands"}. What would you like me to do? (e.g. provide a specific command, point me at docs, or ask me to abandon the task)`;
              return {
                success: true,
                message: question,
                type: "question",
                continuation: {
                  history: [...history],
                  executedCommands: [...executedCommands],
                  usedScaffold,
                  wroteFiles,
                  usedWebTools,
                  lastWriteDir,
                  terminalBusy,
                  agentTodos: agentTodos.length > 0 ? [...agentTodos] : undefined,
                  agentMemory: agentMemory.length > 0 ? [...agentMemory] : undefined,
                },
              };
            }

            const suggestion = arbiter.suggestion
              ? ` Suggestion: ${arbiter.suggestion}`
              : "";
            history.push({
              role: "user",
              content:
                loopBreaks === 1
                  ? `LOOP DETECTED (confirmed by independent check): you are repeating similar "${action.tool}" calls without converging on the task. This action is BLOCKED.${suggestion} STRONGLY consider using ask_question to clarify with the user — they can usually unblock you in one sentence (e.g. providing a chat ID, an API key, the right command, or a doc URL).`
                  : `LOOP DETECTED AGAIN (${loopBreaks}/3, confirmed). You are still stuck.${suggestion} Your NEXT response MUST be either ask_question (preferred — get user help) or final_answer (only if you truly cannot proceed). One more loop will auto-escalate to the user.`,
            });
            continue;
          }
          // Arbiter said: not a loop. Let the action through. But soften the
          // heuristic state so we don't re-fire on the very next step.
          if (isConsecutiveSuspicion || isAlternatingSuspicion) {
            recentActions.length = 0;
          }
          if (isSemanticSuspicion) {
            // Drop a few entries so we need genuinely-new repetitions to re-flag
            recentCoarseKeys.splice(0, Math.max(0, recentCoarseKeys.length - 3));
          }
        }
      }

      // 3. Execute Tool

      // Track substantive (non-parse-retry, non-blocked) tool calls — drives
      // the plan-first nudge above. Don't count todo_write itself (that's
      // the planning step) or final_answer/ask_question (terminal states).
      if (
        action.tool &&
        action.tool !== "todo_write" &&
        action.tool !== "final_answer" &&
        action.tool !== "ask_question"
      ) {
        substantiveSteps++;
      }

      // Plan step: structured plan with steps array
      // Only accept plans if the user explicitly asked for one AND agent hasn't executed anything yet
      const userAskedForPlan = /\b(plan\b|make a plan|outline the|break\s*down)/i.test(prompt);
      if (action._plan && !userAskedForPlan) {
        // Model spontaneously planned — discard and treat as if it should just execute
        delete action._plan;
        delete action.steps;
      }
      if (action._plan && executedCommands.size === 0 && !wroteFiles) {
        // Extract steps: prefer explicit array, fallback to parsing numbered lines from content
        let planSteps: string[] = Array.isArray(action.steps) ? action.steps : [];
        if (planSteps.length === 0 && typeof action.content === "string") {
          planSteps = action.content
            .split("\n")
            .map((l: string) => l.replace(/^\s*\d+[.)]\s*/, "").trim())
            .filter((l: string) => l.length > 0);
        }
        if (planSteps.length === 0) planSteps = ["Plan received"];
        onUpdate("plan", "", { steps: planSteps });
        history.push({ role: "assistant", content: responseText });
        // If model embedded a follow-up tool call, use it
        if (action._action && action._action.tool) {
          action = action._action;
        } else {
          history.push({ role: "user", content: "Plan received. Now execute each step in order." });
          continue;
        }
      }

      // Clean plan metadata from action before tool dispatch
      delete action._plan;
      delete action.steps;
      delete action._action;
      delete action._step_done;

      if (action.tool === "todo_write") {
        // Replace the plan wholesale — model re-emits the full list each time
        // so it can update statuses. Validate and clamp.
        const raw = Array.isArray(action.todos) ? action.todos : [];
        const cleaned = raw
          .filter((t: any) => t && typeof t.content === "string" && t.content.trim())
          .slice(0, 20)
          .map((t: any): import("../../types").AgentTodo => ({
            content: String(t.content).trim().slice(0, 200),
            status:
              t.status === "in_progress" || t.status === "completed"
                ? t.status
                : "pending",
          }));
        agentTodos = cleaned;
        if (cleaned.length > 0) hasPublishedPlan = true;
        const summary =
          cleaned.length === 0
            ? "Plan cleared."
            : cleaned
                .map((t: import("../../types").AgentTodo, i: number) => {
                  const mark =
                    t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : "○";
                  return `${mark} ${i + 1}. ${t.content}`;
                })
                .join("\n");
        onUpdate("plan", summary, { tool: "todo_write", todos: cleaned });
        history.push({
          role: "user",
          content: `Plan updated:\n${summary}\n\nNow execute the next 'in_progress' (or 'pending') item.`,
        });
        continue;
      }

      if (action.tool === "remember") {
        const text = (action.content || "").trim();
        if (!text) {
          history.push({
            role: "user",
            content: `<tool_use_error>remember requires non-empty 'content'</tool_use_error>`,
          });
          continue;
        }
        // Cap entry length so a runaway model can't fill memory with file dumps
        const entry = text.slice(0, 280);
        agentMemory.push(entry);
        // Cap total memory entries
        if (agentMemory.length > 30) agentMemory.shift();
        onUpdate("system", `Remembered: ${entry}`, { tool: "remember", content: entry });
        history.push({
          role: "user",
          content: `Remembered. ${agentMemory.length} memory ${agentMemory.length === 1 ? "entry" : "entries"} now stored.`,
        });
        continue;
      }

      if (action.tool === "final_answer") {
        // Reject if the content is clearly a tool name — model confused output format
        const finalContent = (action.content || "").trim();
        const toolNameMatch = finalContent.match(/^\[?(\w+)\]?$/);
        if (toolNameMatch && TOOL_NAMES.has(toolNameMatch[1]) && toolNameMatch[1] !== "final_answer") {
          history.push({
            role: "user",
            content: `Error: Your response "${finalContent}" looks like you intended to call the ${toolNameMatch[1]} tool, but you did not format it as JSON. Respond with ONLY a JSON object, e.g.: {"tool": "${toolNameMatch[1]}"${toolNameMatch[1] === "read_terminal" ? ', "lines": 50' : toolNameMatch[1] === "execute_command" ? ', "command": "your_command"' : ""}}`,
          });
          continue;
        }

        // Reject premature completion: scaffolded a project but never wrote any code
        if (usedScaffold && !wroteFiles) {
          history.push({
            role: "user",
            content: `Error: You scaffolded a project template but did NOT write any code yet. A template is just boilerplate — you must now use write_file to implement the actual features the user requested (e.g. game logic, UI components, styles). Do NOT give final_answer until you have written the real code.`,
          });
          continue;
        }

        // Reject if dev server is not running (for web projects)
        // If we scaffolded and wrote files (e.g. a web app), we expect a running app.
        if (usedScaffold && wroteFiles && !terminalBusy) {
          const state = await detectTerminalState();
          // Only fail if it's explicitly idle. If "server" or "busy", assume it's fine.
          if (state === "idle") {
            // Silent retry — don't show guard rejection to user
            history.push({
              role: "user",
              content: `Error: You scaffolded a project and implemented files, but the dev server is NOT running (terminal is idle). You MUST start the dev server (e.g. "npm run dev") using "run_in_terminal" before finishing. The user expects a running application.`,
            });
            continue;
          }
        }

        // Use the raw user task passed directly from the caller — NOT extracted from the
        // augmented prompt (which includes [ENVIRONMENT], [TERMINAL OUTPUT], etc. that
        // pollute keyword matching and cause false guard rejections).
        const userTask = (options?.rawUserTask || "").toLowerCase().trim();
        const isShortAck =
          userTask.length <= 20 &&
          /^(ok|okay|yes|no|sure|thanks|thank you|got it|alright|go|do it|good|great|cool|nice|fine|yep|nope|done|next|hi|hey|hello|sup|yo|what'?s up|howdy|greetings|good (morning|afternoon|evening)|hiya|hola)$/i.test(
            userTask,
          );

        // Reject final_answer that asks user permission to continue or lists remaining work
        const answerText = (action.content || "").toLowerCase();
        const isAskingToContinue =
          /\b(would you like|shall i|do you want me to|want me to|should i)\b.+\b(continue|proceed|go ahead|fix|create|implement|install|build)\b/.test(
            answerText,
          );
        const hasUnfinishedSteps =
          /\b(i('ll| will) need to|next steps?|to proceed|remaining|still need)\b/.test(
            answerText,
          );
        // Detect future-tense plans: "I'll create...", "Let me check...", "I will implement..."
        const isFuturePlan =
          /\b(i'll|i will|let me|i'm going to|i need to)\b.+\b(create|build|implement|check|modify|fix|write|set up|configure|update|install|make|add|start|search|fetch|look|find|perform|do|run|try)\b/.test(
            answerText,
          );
        const mentionsError =
          /\b(error|issue|problem|bug|fail|broken|cannot read|undefined)\b/.test(
            answerText,
          ) &&
          !/\b(fixed|resolved|solved|because|caused by|due to|requires?|you need|configured|working|running|active|set up|ready)\b/.test(
            answerText,
          );
        // Don't reject for mentioning errors if the user's own prompt mentioned errors (agent is responding to a known issue)
        const userMentionedError =
          /\b(error|issue|problem|bug|fail|broken)\b/i.test(
            history[history.length - 2]?.content || "",
          ) || /\b(error|issue|problem|bug|fail|broken)\b/i.test(userTask);

        // Guard against false positives like "it is set up for model management"
        const isDescribingExistingState = /\b(is|are|shows? it's|was)\b\s+(set up)\b/.test(answerText);

        if (
          !isShortAck &&
          (isAskingToContinue ||
            isFuturePlan ||
            (hasUnfinishedSteps && !loopBreaks && !isDescribingExistingState))
        ) {
          // Silent retry — don't show guard rejection to user
          history.push({
            role: "user",
            content: `REJECTED: Your final_answer describes unfinished work. You are an ACTION agent — do NOT ask permission to continue. Just DO the remaining steps yourself (fix errors, install dependencies, write code, etc.) and THEN give final_answer when everything is actually done and working.`,
          });
          continue;
        }
        // Reject if answer mentions unfixed errors (unless agent is stuck from loops or user reported the error)
        if (mentionsError && !loopBreaks && !userMentionedError) {
          // Silent retry — don't show guard rejection to user
          history.push({
            role: "user",
            content: `REJECTED: Your final_answer mentions errors that are not fixed. Do NOT report errors as done. Fix them first (read the error, identify root cause, apply fix), then give final_answer when working.`,
          });
          continue;
        }

        // Reject final_answer that tells user to run commands — agent should do it itself
        const delegationPatterns =
          /\b(run|execute|type|enter|use the command|to (start|run|launch|install|configure))\b.*[`"']/;
        if (delegationPatterns.test(answerText) && !terminalBusy) {
          const cmdMatch = (action.content || "").match(
            /[`"']([^`"']{5,})[`"']/,
          );
          if (cmdMatch) {
            // Silent retry — don't show guard rejection to user
            history.push({
              role: "user",
              content: `REJECTED: Do NOT tell the user to run commands. You are an ACTION agent — execute "${cmdMatch[1]}" yourself using run_in_terminal or execute_command. Then give final_answer when done.`,
            });
            continue;
          }
        }

        // Reject final_answer that IS a bare command (agent should execute, not report)
        // e.g. "ollama list", "npm start", "git status" — short, no prose, no punctuation
        const trimmedAnswer = (action.content || "").trim();
        const looksLikeBareCommand =
          trimmedAnswer.length > 0 &&
          trimmedAnswer.length < 60 &&
          !trimmedAnswer.includes(".") &&    // no sentences
          !trimmedAnswer.includes(",") &&    // no lists
          !trimmedAnswer.includes("!") &&
          !/^(I |The |It |Yes|No |Done|Here|Sure|OK|Thank|Note)/i.test(trimmedAnswer) &&
          /^[a-z][\w./-]*(\s+\S+)*$/i.test(trimmedAnswer) && // command-like pattern
          executedCommands.size === 0 &&
          !wroteFiles &&
          !usedWebTools &&
          !terminalBusy &&
          !loopBreaks;
        if (looksLikeBareCommand && !isShortAck) {
          // Silent retry — don't show guard rejection to user
          history.push({
            role: "user",
            content: `REJECTED: Your final_answer "${trimmedAnswer}" looks like a shell command you should EXECUTE, not report. Use execute_command to run it and show the user the RESULT, not the command itself.`,
          });
          continue;
        }

        // Reject generic terse completion messages that don't convey actual results
        const genericCompletionPatterns = /^(task completed|done|finished|completed|all done|it'?s done|that'?s it|everything is (set up|done|ready))\s*[.!]?\s*$/i;
        if (genericCompletionPatterns.test(trimmedAnswer) && executedCommands.size > 0 && !isShortAck) {
          // Silent retry — don't show guard rejection to user
          history.push({
            role: "user",
            content: `REJECTED: Your final_answer "${trimmedAnswer}" is too generic. Provide the ACTUAL results/output of what you did. For example, if you ran a command, include what it returned. If you modified files, explain what changed. Be specific.`,
          });
          continue;
        }

        // Check for "Lazy Completion": Agent used read-only tools but took no write actions.
        // Instead of keyword-matching the user's request, check the signal:
        // tools were invoked (agent tried to work) but zero commands executed / files written.
        const isQuestionPattern = /^(how\s+to|how\s+do\s+i|what\s+is|explain|can\s+you\s+explain|tell\s+me|what|why|where|when|who)\b/i.test(userTask);
        const userEndsWithQuestion = userTask.trim().endsWith("?");
        const isLikelyQuestion = isQuestionPattern || userEndsWithQuestion;

        // history.length > initialHistoryLen means the agent used tools (read_file, list_dir, etc.)
        const agentUsedTools = history.length > 4; // system + user + at least 2 tool exchanges
        if (
          !isShortAck &&
          !isLikelyQuestion &&
          agentUsedTools &&
          executedCommands.size === 0 &&
          !wroteFiles &&
          !usedWebTools &&
          !terminalBusy
        ) {
          // Silent retry — don't show guard rejection to user
          history.push({
            role: "user",
            content: `REJECTED: The user asked you to "${userTask.slice(0, 60)}" but you have executed 0 commands and written 0 files. Reading files is NOT completing the task. You MUST take action — use execute_command, run_in_terminal, or write_file to actually DO the work.`,
          });
          continue;
        }
        // Fix mismatched server URLs: if final_answer mentions localhost:PORT but
        // terminal shows a different port, correct it (common with small models)
        let finalMessage: string = action.content || "";
        if (terminalBusy && /localhost:\d+/.test(finalMessage)) {
          try {
            const termOut = await readTerminal(30);
            const termPorts = [...termOut.matchAll(/localhost:(\d+)/g)].map(m => m[1]);
            const msgPorts = [...finalMessage.matchAll(/localhost:(\d+)/g)].map(m => m[1]);
            if (termPorts.length > 0 && msgPorts.length > 0) {
              const actualPort = termPorts[termPorts.length - 1]; // last seen port
              for (const wrongPort of msgPorts) {
                if (wrongPort !== actualPort && termPorts.indexOf(wrongPort) === -1) {
                  finalMessage = finalMessage.replaceAll(`localhost:${wrongPort}`, `localhost:${actualPort}`);
                }
              }
            }
          } catch { /* non-critical */ }
        }
        return { success: true, message: finalMessage, type: "success", payload: action };
      }

      if (action.tool === "ask_question") {
        const questionText = action.question || action.content || "";
        const q = questionText.toLowerCase();

        // Allow questions about credentials, secrets, preferences — things the agent can't check
        const isCredentialQuestion =
          /\b(password|username|account|credential|api.?key|token|login|auth|secret|license|email|ssh)\b/.test(q);
        const isPreferenceQuestion =
          /\b(prefer|want|choose|which|style|color|name|title)\b/.test(q);

        // General autonomy guard: if agent hasn't tried any commands yet and the
        // question isn't about credentials/preferences, reject it. The agent should
        // explore the system first (commands, file reads) before asking the user.
        if (!isCredentialQuestion && !isPreferenceQuestion && executedCommands.size === 0 && !wroteFiles && !usedWebTools) {
          history.push({
            role: "user",
            content: `REJECTED: Do NOT ask the user — you haven't tried anything yet. Be autonomous: use execute_command to check system state (system_profiler, diskutil, ps, lsof, ls, find, which, curl). Discover the answer yourself first. Only ask_question if you truly cannot determine the answer after trying.`,
          });
          continue;
        }

        // Detect ask_question that is actually a completed answer (no question mark,
        // substantial content = the agent is reporting results, not asking)
        const endsWithQuestion = questionText.trim().endsWith("?");
        const hasQuestionMark = questionText.includes("?");
        const isLongAnswer = questionText.length > 150;
        if (isLongAnswer && !endsWithQuestion) {
          // Long response without trailing "?" — this is a done response, not a question
          onUpdate("done", questionText, { tool: "final_answer", content: questionText });
          return { success: true, message: questionText };
        }
        // Also catch: has a "?" buried in middle but the bulk is analysis/results
        if (questionText.length > 300 && hasQuestionMark) {
          // Count question marks vs total content — if <1 per 200 chars, it's mostly answer
          const qCount = (questionText.match(/\?/g) || []).length;
          if (qCount <= 1 && questionText.length > 400) {
            onUpdate("done", questionText, { tool: "final_answer", content: questionText });
            return { success: true, message: questionText };
          }
        }

        return {
          success: true,
          message: action.question || action.content || "Question?",
          type: "question",
          continuation: {
            history: [...history],
            executedCommands: [...executedCommands],
            usedScaffold,
            wroteFiles,
            usedWebTools,
            lastWriteDir,
            terminalBusy,
            agentTodos: agentTodos.length > 0 ? [...agentTodos] : undefined,
            agentMemory: agentMemory.length > 0 ? [...agentMemory] : undefined,
          },
        };
      }

      if (action.tool === "run_in_terminal") {
        try {
          // Pre-flight check — catch running servers/TUI programs before writing to terminal
          if (!terminalBusy) {
            const pfOutput = await readTerminal(30);
            const pfState = classifyTerminalOutput(pfOutput || "");

            // Server/daemon or busy process — stop it first
            if (pfState === "server" || pfState === "busy") {
              onUpdate("executing", `Stopping ${pfState === "server" ? "server" : "process"} to run: ${(action.command || "").slice(0, 60)}…`, action);
              const stopped = await smartStopProcess();
              if (!stopped) {
                if (pfState === "server") {
                  onUpdate("failed", `Server still running — command not executed`, action);
                  history.push({
                    role: "user",
                    content: `(Command NOT executed — a process is running in the terminal and could not be stopped. You must stop it manually: try send_text("\\x03"), send_text("q\\r"), or send_text("\\x04"), then read_terminal to confirm idle, then retry.)`,
                  });
                  continue;
                }
                terminalBusy = true;
                onUpdate("executed", `Stopping process to run: ${(action.command || "").slice(0, 60)}… (process still busy)`, action);
              } else {
                onUpdate("executed", `Stopped ${pfState === "server" ? "server" : "process"}`, action);
              }
            }

            // TUI detection
            if (pfState !== "idle" && pfState !== "server") {
              const tui = detectTuiProgram(pfOutput || "");
              if (tui) {
                onUpdate("executed", `Exiting TUI "${tui}"…`, action);
                const result = await attemptTuiExit(tui, writeToTerminal, readTerminal);
                if (result.exited) {
                  onUpdate("executed", `Exited ${tui} (${result.attempts.join(" → ")})`, action);
                  tuiExitFailures = 0;
                } else {
                  tuiExitFailures++;
                  if (tuiExitFailures >= 2) {
                    onUpdate("executed", `Cannot exit TUI "${tui}" — asking user`, action);
                    history.push({
                      role: "user",
                      content: `(Auto-exit failed ${tuiExitFailures} times for TUI "${tui}". You MUST use ask_question NOW to tell the user to manually close the TUI program, then wait for their confirmation before retrying.)`,
                    });
                  } else {
                    history.push({
                      role: "user",
                      content: `(Command NOT executed — TUI "${tui}" still running after exit attempts: ${result.attempts.join(" → ")}. Use send_text to exit manually, then read_terminal to confirm idle.)`,
                    });
                  }
                  continue;
                }
              }
            }
          }
          // If terminal has a running process, check its state first
          if (terminalBusy) {
            const state = await detectTerminalState();
            if (state === "input_needed") {
              // Process is waiting for user input — tell agent to ask
              consecutiveBusy = 0;
              const output = await readTerminal(15);
              onUpdate("executed", `Terminal waiting for input`, action);
              history.push({
                role: "user",
                content: `(Command NOT executed — terminal is waiting for user input.)\n${output}\n\nUse ask_question to ask the user what to enter, then send_text to type it. The user may also type directly in the terminal.`,
              });
              continue;
            } else if (state === "busy") {
              // Check if a TUI program is running instead of a build/install process
              const tuiOutput = await readTerminal(30);
              const tui = detectTuiProgram(tuiOutput);
              if (tui) {
                consecutiveBusy = 0;
                onUpdate("executed", `Exiting TUI "${tui}"…`, action);
                const result = await attemptTuiExit(tui, writeToTerminal, readTerminal);
                if (result.exited) {
                  onUpdate("executed", `Exited ${tui} (${result.attempts.join(" → ")})`, action);
                  terminalBusy = false;
                  tuiExitFailures = 0;
                } else {
                  tuiExitFailures++;
                  if (tuiExitFailures >= 2) {
                    onUpdate("executed", `Cannot exit TUI "${tui}" — asking user`, action);
                    history.push({
                      role: "user",
                      content: `(Auto-exit failed ${tuiExitFailures} times for TUI "${tui}". You MUST use ask_question NOW to tell the user to manually close the TUI program, then wait for their confirmation before retrying.)`,
                    });
                  } else {
                    history.push({
                      role: "user",
                      content: `(Command NOT executed — TUI "${tui}" still running after exit attempts: ${result.attempts.join(" → ")}. Use send_text to exit manually, then read_terminal to confirm idle.)`,
                    });
                  }
                  continue;
                }
              }
              if (!terminalBusy) {
                // TUI was exited above — skip busy waiting, proceed to command
              } else {
                // Process still running (installing, building) — DON'T kill it, wait with backoff
                consecutiveBusy++;
                const waitMs = Math.min(2000 * consecutiveBusy, 8000);
                await new Promise((r) => setTimeout(r, waitMs));
                // Re-check after waiting — it may have finished
                const freshState = await detectTerminalState();
                if (freshState === "idle") {
                  terminalBusy = false;
                  consecutiveBusy = 0;
                  const finishedOutput = await readTerminal(15);
                  history.push({
                    role: "user",
                    content: `(Previous terminal process finished. Output:\n${finishedOutput}\n)`,
                  });
                  // Don't continue — let the original command execute
                } else if (consecutiveBusy >= 10) {
                  // Stuck for too long — stop polling and tell agent to change approach
                  onUpdate(
                    "executed",
                    `(Terminal busy for ${consecutiveBusy} checks — skipping command)`,
                    action
                  );
                  history.push({
                    role: "user",
                    content: `(Terminal has been busy for ${consecutiveBusy} consecutive checks. The process may be stalled or waiting for input. You should either:\n1. Use read_terminal one more time to check if there's a prompt or error\n2. Use send_text("\\x03") to Ctrl+C the process if it appears stuck\n3. Use send_text to provide input if the process is waiting for a response\n4. Use final_answer to report the current state\nDo NOT attempt more run_in_terminal or execute_command calls.)`,
                  });
                  consecutiveGuardBlocks++;
                  continue;
                } else {
                  const output = await readTerminal(15);
                  onUpdate(
                    "executed",
                    "(Terminal busy — auto-read)\n---\n" +
                    (output || "(no output)"),
                    action
                  );
                  history.push({
                    role: "user",
                    content: `(Command NOT executed — terminal is busy running a process. Use ONLY read_terminal to monitor progress. Do NOT use execute_command or run_in_terminal until the process finishes. Be patient — builds, installs, and docker operations can take several minutes.)\nCurrent output:\n${output}`,
                  });
                  continue;
                }
              }
            } else if (state === "server") {
              // Dev server running — auto-stop it so the command can execute
              onUpdate("executing", `Stopping server to run: ${(action.command || "").slice(0, 60)}…`, action);
              const stopped = await smartStopProcess();
              if (stopped) {
                terminalBusy = false;
                consecutiveBusy = 0;
                onUpdate("executed", `Stopped server`, action);
                // Mark previous terminal output as stale
                history.push({
                  role: "user",
                  content: `(Previous server stopped. All prior terminal output and error messages are STALE — only trust output from commands after this point.)`,
                });
                // Fall through to execute the command
              } else {
                onUpdate("failed", `Server could not be stopped`, action);
                history.push({
                  role: "user",
                  content: `(Command NOT executed — process could not be stopped. You must stop it manually: try send_text("\\x03"), send_text("q\\r"), or send_text("\\x04"), then read_terminal to confirm idle, then retry.)`,
                });
                consecutiveGuardBlocks++;
                continue;
              }
            } else {
              // idle — process finished on its own; read output so agent knows what happened
              consecutiveBusy = 0;
              terminalBusy = false;
              const finishedOutput = await readTerminal(15);
              const nudge =
                usedScaffold && !wroteFiles
                  ? `\nThe scaffold/install is complete. Now use write_file to implement the user's requested features. Do NOT run ls, mkdir, or any scaffold commands.`
                  : "";
              history.push({
                role: "user",
                content: `(Previous terminal process finished. Output:\n${finishedOutput}\n)${nudge}`,
              });
            }
          }

          let runCmd = action.command;
          executedCommands.add(runCmd);
          const isScaffoldCmd = /\b(create|init)\b/i.test(runCmd);

          // After scaffolding, nudge agent toward write_file but don't block reads
          if (
            (usedScaffold || isScaffoldCmd) &&
            !wroteFiles &&
            /^\s*(mkdir)\b/.test(runCmd)
          ) {
            onUpdate(
              "failed",
              `Blocked: "${runCmd}" — use write_file instead (it creates directories automatically)`,
              action
            );
            history.push({
              role: "user",
              content: `Error: Do not manually create directories. Use write_file with the full path — it creates parent directories automatically.`,
            });
            consecutiveGuardBlocks++;
            continue;
          }

          // Block dev server launch if code hasn't been written yet
          if (
            usedScaffold &&
            !wroteFiles &&
            /\b(npm|yarn|pnpm|bun)\s+(run\s+)?(dev|start)\b/.test(runCmd)
          ) {
            // Silent retry — don't show guard rejection to user
            history.push({
              role: "user",
              content: `Error: You scaffolded a template but haven't written any code yet. Use write_file to implement the features the user asked for BEFORE starting the dev server.`,
            });
            consecutiveGuardBlocks++;
            continue;
          }

          // Auto-prepend cd if agent wrote files to a project dir but forgot to cd
          runCmd = autoCdCommand(runCmd, lastWriteDir);
          // Use \r (carriage return) — that's what Enter sends in a PTY
          // checkPermission=true so user is prompted before execution
          terminalBusy = true; // Set BEFORE await — reset in catch if it fails
          consecutiveBusy = 0; // Successfully dispatched a command
          consecutiveGuardBlocks = 0;
          await writeToTerminal(runCmd + "\r", true, true);
          // Wait briefly for output to arrive, then snapshot the terminal
          await new Promise((r) => setTimeout(r, 1500));
          const snapshot = await readTerminal(15);
          // Only mark as scaffolded if the command didn't fail or get cancelled
          if (
            isScaffoldCmd &&
            !/command not found|not recognized|No such file|Operation cancelled|cancelled|aborted|SIGINT/i.test(
              snapshot || "",
            )
          ) {
            usedScaffold = true;
          }
          onUpdate(
            "executed",
            runCmd + "\n---\n" + (snapshot || "(awaiting output)"),
            action
          );
          history.push({
            role: "user",
            content: `(Command started in terminal. Initial output:\n${snapshot || "(no output yet)"}\n\nIMPORTANT: You MUST use read_terminal repeatedly to monitor progress until the process finishes (terminal returns to idle/prompt state). Do NOT use execute_command or run_in_terminal — the terminal is occupied. Do NOT send Ctrl+C unless the process is clearly stuck or the user asks you to stop it. Long-running commands like docker, npm install, builds etc. can take several minutes — be patient.)`,
          });
        } catch (err: any) {
          terminalBusy = false; // Reset — command never actually ran
          const isDeny = err.message === "User denied command execution.";
          onUpdate("failed", action.command + "\n---\n" + err.message, action);
          if (isDeny) {
            // Permission denied is a hard stop — don't let agent retry the same command
            history.push({
              role: "user",
              content: `User DENIED this command. Do NOT retry it. Either:\n1. Use ask_question to ask the user why they denied it and what they'd prefer\n2. Try a completely different approach\n3. Use final_answer to report that you cannot proceed without this command`,
            });
          } else {
            history.push({
              role: "user",
              content: `<tool_use_error>execute_command failed: ${err.message}</tool_use_error>`,
            });
          }
        }
        continue;
      }

      if (action.tool === "send_text") {
        try {
          // Process escape sequences in the text before sending. Fallback to empty string to prevent TypeError.
          let processedText = action.text || "";

          // Guard: reject if no characters at all (but allow control chars like '\r', '\x1B[B' etc.)
          if (!processedText || processedText.length === 0) {
            onUpdate(
              "failed",
              "send_text: empty text rejected. Specify actual keystrokes.",
              action
            );
            history.push({
              role: "user",
              content: `(send_text rejected: text was empty. Use specific keystrokes like \\r for Enter, \\x1B[B for Down Arrow.)`,
            });
            continue;
          }

          // Map \n to \r (PTY Enter = carriage return 0x0D, not newline 0x0A)
          processedText = processedText.replace(/\\n/g, "\r");
          processedText = processedText.replace(/\\r/g, "\r");
          processedText = processedText.replace(/\\t/g, "\t");
          processedText = processedText.replace(
            /\\x([0-9a-fA-F]{2})/g,
            (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)),
          );
          processedText = processedText.replace(
            /\\u([0-9a-fA-F]{4})/g,
            (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)),
          );

          // Guard: reject if no characters at all (but allow control chars like \r, \x1B[B etc.)
          if (!processedText || processedText.length === 0) {
            onUpdate(
              "failed",
              "send_text: empty text rejected. Specify actual keystrokes.",
              action
            );
            history.push({
              role: "user",
              content: `(send_text rejected: text was empty. Use specific keystrokes like \\r for Enter, \\x1B[B for Down Arrow.)`,
            });
            continue;
          }

          // Send processed text/keys — use raw mode to avoid Ctrl+C killing the process
          await writeToTerminal(processedText, true);
          // If Ctrl+C or Ctrl+D was sent, terminal is no longer busy
          const stoppedProcess =
            (processedText === "\x03" || processedText === "\x04") &&
            terminalBusy;
          if (processedText === "\x03" || processedText === "\x04") {
            terminalBusy = false;
          }
          // Prefer LLM-provided description, fall back to key analysis
          const desc = action.description || describeKeysUtil(processedText);
          // Wait briefly for terminal to update, then snapshot
          await new Promise((r) => setTimeout(r, 1500));
          const snapshot = await readTerminal(10);
          onUpdate("executed", desc + "\n---\n" + (snapshot || "(no output)"), action);
          if (stoppedProcess) {
            // Agent stopped a running process — remind it to continue, not restart
            history.push({
              role: "user",
              content: `(Process stopped. Continue with the next step.)`,
            });
          } else {
            history.push({
              role: "user",
              content: `(Sent text to terminal: "${action.text}")`,
            });
          }
        } catch (err: any) {
          onUpdate("failed", "Send text failed: " + err.message, action);
          history.push({
            role: "user",
            content: `Send Text Failed: ${err.message} `,
          });
        }
        continue;
      }

      if (action.tool === "read_terminal") {
        try {
          const lines = typeof action.lines === "number" ? action.lines : 50;

          // When terminal is busy, loop internally with backoff until idle/done.
          // This prevents the LLM from seeing partial output and firing new commands.
          const MAX_BUSY_POLLS = 60; // Safety cap (~5 min at max backoff)
          let busyPolls = 0;
          let output = "";
          let termState: string = "busy";
          let tuiProgram: string | null = null;

          while (true) {
            if (signal?.aborted) throw new Error("Agent aborted by user.");

            output = await readTerminal(lines);

            // Check if user clicked "Continue"
            if ((globalThis as any).__tronAgentContinue) {
              (globalThis as any).__tronAgentContinue = false;
              identicalReadCount = 0;
              lastReadTerminalOutput = "";
              onUpdate("executed", `User confirmed ready — continuing`, action);
              history.push({
                role: "user",
                content: `${output}\n\n✅ The user has confirmed they completed the required action (e.g. finished browser login, entered input). The terminal output above shows the current state. Proceed with the task.`,
              });
              break;
            }

            // Track consecutive identical outputs
            const outputTrimmed = (output || "").trim();
            if (outputTrimmed === lastReadTerminalOutput && outputTrimmed.length > 0) {
              identicalReadCount++;
            } else {
              lastReadTerminalOutput = outputTrimmed;
              identicalReadCount = 0;
            }

            termState = classifyTerminalOutput(output || "");
            // If alternate buffer is active, a TUI is definitely running
            const inAltBuffer = options?.isAlternateBuffer?.() ?? false;
            if (inAltBuffer && termState === "idle") termState = "busy";
            tuiProgram = (termState !== "idle" || inAltBuffer) ? detectTuiProgram(output || "") : null;
            // If alternate buffer but heuristics didn't match, treat as generic TUI
            if (inAltBuffer && !tuiProgram) tuiProgram = "tui-app";

            // If terminal is busy (process running) and we came from run_in_terminal,
            // poll internally instead of returning to the LLM
            // Break on 3+ identical reads — process is idle/stalled, not actively busy
            const shouldPollInternally = terminalBusy && termState === "busy" && !tuiProgram && busyPolls < MAX_BUSY_POLLS && identicalReadCount < 3;

            // Smart backoff: 2s → 3s → 5s → 8s → 10s (capped)
            const backoffMs = Math.min(2000 + 1000 * busyPolls, 10000);
            readTerminalCount++;
            busyPolls++;

            // Update UI — single merged entry with countdown
            const previewLines = output
              ? output.split("\n").filter((l) => l.trim()).slice(-3)
              : [];
            const firstLine = previewLines[0]?.slice(0, 100) || "(No output)";
            const fullPreview = previewLines.join("\n").slice(0, 300) || "(No output)";
            const suffix = readTerminalCount > 1 ? ` (${readTerminalCount}x)` : "";
            onUpdate(
              "read_terminal",
              `Checking terminal${suffix}: ${firstLine}\n---\n${fullPreview}`,
              { ...action, _nextCheckMs: shouldPollInternally ? backoffMs : 0, _checkCount: readTerminalCount }
            );

            if (!shouldPollInternally) break; // Terminal done or special state — return to LLM

            await new Promise((r) => setTimeout(r, backoffMs));
          }

          // Already handled by "Continue" button above
          if ((globalThis as any).__tronAgentContinue === false && identicalReadCount === 0 && termState !== "busy") {
            // Was handled inside the loop — skip duplicate push
            if (history[history.length - 1]?.content?.includes("confirmed they completed")) {
              continue;
            }
          }

          if (tuiProgram) {
            history.push({
              role: "user",
              content: `${output}\n\n⚠️ A TUI program is running: **${tuiProgram}**. The terminal is NOT at a shell prompt.\n- If your current task is UNRELATED to ${tuiProgram}: use execute_command or run_in_terminal for your next command — the system will automatically exit the TUI first.\n- If your task IS related to ${tuiProgram}: interact directly using send_text with appropriate keystrokes, then read_terminal to verify.`,
            });
          } else if (termState === "input_needed") {
            // Shell continuation prompts mean an unclosed quote/brace/heredoc.
            // The agent must Ctrl+C out, not try to "answer" the prompt.
            const lastLine = (output || "").trimEnd().split(/\r?\n/).pop()?.trim() || "";
            const stuckOnQuote = /^(dquote|quote|cmdsubst|heredoc|\?)>\s*$/.test(lastLine);
            if (stuckOnQuote) {
              const which =
                lastLine.startsWith("dquote") ? "an unclosed double-quote" :
                lastLine.startsWith("quote") ? "an unclosed single-quote" :
                lastLine.startsWith("cmdsubst") ? "an unclosed $(...) command substitution" :
                lastLine.startsWith("heredoc") ? "an unfinished heredoc" :
                "an unclosed quote/brace";
              history.push({
                role: "user",
                content: `${output}\n\n⚠️ Shell is waiting because your last execute_command had ${which} (the prompt now reads "${lastLine}"). Do NOT try to answer it. Send_text "\\x03" to abort, then re-run the command with proper quote escaping. Hint: wrap arguments containing double quotes in SINGLE quotes — e.g. instead of execute_command("foo --message \\"Hi 'there'\\""), use execute_command(\`foo --message 'Hi there'\`). For payloads with both quote styles, build the JSON in write_file and pass --data-file instead.`,
              });
            } else if (identicalReadCount >= 3) {
              history.push({
                role: "user",
                content: `${output}\n\n⚠️ IMPORTANT: Terminal has been waiting for user input for ${identicalReadCount} consecutive checks with NO CHANGE. The user needs to take action (e.g. complete a login flow in the browser, enter a password, etc.). You MUST use ask_question NOW to tell the user what you're waiting for and ask them to confirm when they're done. Do NOT call read_terminal again until the user responds.`,
              });
            } else {
              history.push({
                role: "user",
                content: `${output}\n\n⚠️ The terminal is waiting for user input (password, confirmation, etc.). Use ask_question to ask the user what to enter, then use send_text to type their response. The user may also type directly in the terminal — if so, read_terminal again to see the result.`,
              });
            }
          } else if (termState === "server" && identicalReadCount >= 1) {
            // Check if server output contains errors — don't declare success if there are errors
            const hasErrors = /\bError\b|ERR!|ENOENT|Cannot find|Failed to|Internal server error|FATAL|panic|Segmentation fault/i.test(output || "");
            if (hasErrors) {
              history.push({
                role: "user",
                content: `${output}\n\n⚠️ A server/dev process is running but the output contains ERRORS. Do NOT declare success — review the errors above and fix them. You may need to edit source files (use write_file or edit_file) to resolve the issues. The dev server will hot-reload automatically after you save changes.`,
              });
            } else {
              history.push({
                role: "user",
                content: `${output}\n\n✅ A server/daemon process is running successfully with NO errors. Ignore any previous error messages in the conversation — they are from an older server run and no longer relevant. You MUST use final_answer NOW to report the result to the user. Do NOT write more files, do NOT call read_terminal again — the server is running and the task is COMPLETE.`,
              });
            }
          } else if (termState === "idle") {
            // Process finished — clear busy flag and return output
            terminalBusy = false;
            history.push({
              role: "user",
              content: output
                ? `${output}\n\n✅ The terminal process has finished (terminal is idle). Review the output above and proceed.`
                : "(Process finished with no output)",
            });
          } else if (identicalReadCount >= 3) {
            // Stable output — likely a server/daemon with static error output, or a stalled process
            terminalBusy = false;
            history.push({
              role: "user",
              content: `${output}\n\n⚠️ Terminal output has been unchanged for ${identicalReadCount} consecutive reads. A process is running but not producing new output (likely a dev server showing errors). You can now proceed: use execute_command or run_in_terminal for your next command — the system will stop the process automatically if needed. Or use final_answer if the task is complete.`,
            });
          } else if (busyPolls >= MAX_BUSY_POLLS) {
            terminalBusy = false;
            history.push({
              role: "user",
              content: `${output}\n\n⚠️ Terminal has been monitored for ${busyPolls} checks (~5 minutes). The process may be stalled. You should either use send_text("\\x03") to stop it, or use final_answer to report the current state.`,
            });
          } else {
            history.push({
              role: "user",
              content: output || "(No output yet)",
            });
          }
        } catch (err: any) {
          onUpdate("failed", "Read terminal failed: " + err.message, action);
          history.push({
            role: "user",
            content: `<tool_use_error>read_file failed: ${err.message}</tool_use_error>`,
          });
        }
        // Throttle: when terminal is busy, delay before next LLM call to avoid rapid API calls
        if (terminalBusy) {
          const throttleMs = Math.min(2000 + 1000 * readTerminalCount, 8000);
          await new Promise((r) => setTimeout(r, throttleMs));
        }
        continue;
      }

      // Reset read counters when agent takes any other action —
      // but preserve identicalReadCount while a server is running to avoid write→read→write loops
      readTerminalCount = 0;
      if (!terminalBusy) {
        identicalReadCount = 0;
        lastReadTerminalOutput = "";
      }

      // --- Resolve relative file paths against terminal cwd ---
      // Weak models may use "." or relative paths instead of absolute ones.
      // Resolve them via terminal.getCwd so file ops target the correct directory.
      if (["write_file", "read_file", "edit_file", "list_dir", "search_dir"].includes(action.tool)) {
        const p = action.path || action.dirPath;
        if (p && !p.startsWith("/") && !/^[A-Z]:\\/i.test(p)) {
          try {
            const cwd = await (window as any).electron.ipcRenderer.invoke("terminal.getCwd", options?.sessionId);
            if (cwd) {
              // Use platform-appropriate separator
              const sep = cwd.includes("\\") ? "\\" : "/";
              const resolved = p === "." ? cwd : `${cwd}${sep}${p}`;
              if (action.path) action.path = resolved;
              if (action.dirPath) action.dirPath = resolved;
            }
          } catch { /* best effort — continue with original path */ }
        }
      }

      if (action.tool === "write_file") {
        const filePath = action.path;
        const content = action.content;

        // Guard: block rewrites after server is running with files already written
        if (terminalBusy && wroteFiles && identicalReadCount >= 1) {
          history.push({
            role: "user",
            content: `STOP: A dev server is already running and you have already written code. The task is COMPLETE — the server will hot-reload your changes automatically. Do NOT rewrite files. Use final_answer NOW to report success.`,
          });
          consecutiveGuardBlocks++;
          continue;
        }

        // Silently retry if AI sent malformed write_file (missing path/content) — don't show error to user
        if (!filePath || typeof content !== "string") {
          history.push({
            role: "user",
            content: `Error: write_file requires "path" (string) and "content" (string). You sent: path=${JSON.stringify(filePath)}, content type=${typeof content}. Fix and retry.`,
          });
          continue;
        }
        try {
          if (checkFilePermission) {
            await checkFilePermission(`Write file: ${filePath}`);
          }
          onUpdate("executing", `Writing file: ${filePath}`, action);
          let result: any;
          if (options?.isSSH && options.sessionId) {
            // SSH: use shell commands to write file
            const escaped = content.replace(/\\/g, "\\\\").replace(/'/g, "'\\''");
            const cmd = `mkdir -p "$(dirname '${filePath}')" && cat > '${filePath}' << 'TRON_SSH_EOF'\n${escaped}\nTRON_SSH_EOF`;
            const execResult = await (window as any).electron.ipcRenderer.invoke("terminal.exec", { sessionId: options.sessionId, command: cmd });
            result = execResult.exitCode === 0 ? { success: true, existed: false } : { success: false, error: execResult.stderr || "Write failed" };
          } else {
            result = await (window as any).electron.ipcRenderer.invoke(
              "file.writeFile",
              {
                filePath,
                content,
                ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
              },
            );
          }
          if (result.success) {
            const MAX_PREVIEW = 5000;
            const preview =
              content.length > MAX_PREVIEW
                ? content.slice(0, MAX_PREVIEW) +
                `\n... (${content.length - MAX_PREVIEW} more characters)`
                : content;
            onUpdate("executed", `Wrote file: ${filePath}\n---\n${preview}`, action);
            wroteFiles = true;
            consecutiveGuardBlocks = 0;
            // Track project root — use the shallowest (shortest) directory written to
            const dir = filePath.substring(0, filePath.lastIndexOf("/"));
            if (dir && (!lastWriteDir || dir.length < lastWriteDir.length)) {
              lastWriteDir = dir;
            }
            history.push({
              role: "user",
              content: result.existed
                ? `(File overwritten: ${filePath}. NOTE: For future edits to existing files, prefer edit_file over write_file to avoid rewriting the entire file.)`
                : `(File created: ${filePath})`,
            });
          } else {
            throw new Error(result.error || "Unknown write error");
          }
        } catch (err: any) {
          onUpdate("failed", "Write file failed: " + err.message, action);
          history.push({
            role: "user",
            content: `<tool_use_error>write_file failed: ${err.message}</tool_use_error>`,
          });
        }
        continue;
      }

      if (action.tool === "read_file") {
        const filePath = action.path;
        try {
          if (!filePath) {
            throw new Error("read_file requires 'path' (string)");
          }
          onUpdate("executing", `Reading file: ${filePath}`, action);
          let result: any;
          if (options?.isSSH && options.sessionId) {
            const execResult = await (window as any).electron.ipcRenderer.invoke("terminal.exec", { sessionId: options.sessionId, command: `cat '${filePath}'` });
            result = execResult.exitCode === 0 ? { success: true, content: execResult.stdout } : { success: false, error: execResult.stderr || "File not found" };
          } else {
            result = await (window as any).electron.ipcRenderer.invoke(
              "file.readFile",
              {
                filePath,
                ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
              },
            );
          }
          if (result.success) {
            const content = result.content || "(empty file)";
            // Truncate very large files
            const truncated =
              content.length > 10000
                ? content.slice(0, 5000) +
                "\n...(truncated)...\n" +
                content.slice(-5000)
                : content;
            onUpdate(
              "executed",
              `Read file: ${filePath} (${content.length} chars)`,
              action
            );
            history.push({
              role: "user",
              content: truncated,
            });
          } else {
            throw new Error(result.error || "Unknown read error");
          }
        } catch (err: any) {
          const errMsg = err.message || "Unknown error";
          const isNotFound = /not found|no such file|ENOENT/i.test(errMsg);
          onUpdate("failed", "Read file failed: " + errMsg, action);
          history.push({
            role: "user",
            content: isNotFound
              ? `File does not exist: ${filePath}. Do NOT retry reading it. If you need this file, create it with write_file instead.`
              : `Read File Failed: ${errMsg}`,
          });
        }
        continue;
      }

      if (action.tool === "edit_file") {
        try {
          const filePath = action.path;
          const search = action.search;
          const replace = action.replace;
          if (
            !filePath ||
            typeof search !== "string" ||
            typeof replace !== "string"
          ) {
            throw new Error(
              "edit_file requires 'path', 'search', and 'replace' (all strings)",
            );
          }
          if (checkFilePermission) {
            await checkFilePermission(`Edit file: ${filePath}`);
          }
          onUpdate("executing", `Editing file: ${filePath}`, action);
          let result: any;
          if (options?.isSSH && options.sessionId) {
            // SSH: use sed for simple edits, or cat+write for complex ones
            const escapedSearch = search.replace(/[/&\\]/g, "\\$&").replace(/\n/g, "\\n");
            const escapedReplace = replace.replace(/[/&\\]/g, "\\$&").replace(/\n/g, "\\n");
            const sedCmd = `sed -i 's/${escapedSearch}/${escapedReplace}/g' '${filePath}'`;
            const execResult = await (window as any).electron.ipcRenderer.invoke("terminal.exec", { sessionId: options.sessionId, command: sedCmd });
            result = execResult.exitCode === 0 ? { success: true, replacements: 1 } : { success: false, error: execResult.stderr || "Edit failed" };
          } else {
            result = await (window as any).electron.ipcRenderer.invoke(
              "file.editFile",
              {
                filePath,
                search,
                replace,
                ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
              },
            );
          }
          if (result.success) {
            // Build a compact diff preview for the overlay
            const diffPreview = `--- search\n${search}\n+++ replace\n${replace}`;
            const truncatedDiff =
              diffPreview.length > 3000
                ? diffPreview.slice(0, 3000) + "\n... (truncated)"
                : diffPreview;
            onUpdate(
              "executed",
              `Edited file: ${filePath} (${result.replacements} replacements)\n---\n${truncatedDiff}`,
              action
            );
            wroteFiles = true;
            consecutiveGuardBlocks = 0;
            // Track project root — use the shallowest directory
            const dir = filePath.substring(0, filePath.lastIndexOf("/"));
            if (dir && (!lastWriteDir || dir.length < lastWriteDir.length)) {
              lastWriteDir = dir;
            }
            history.push({
              role: "user",
              content: `(File edited successfully: ${filePath}. Made ${result.replacements} replacements.)`,
            });
          } else {
            throw new Error(result.error || "Unknown edit error");
          }
        } catch (err: any) {
          onUpdate("failed", "Edit file failed: " + err.message, action);
          history.push({
            role: "user",
            content: `<tool_use_error>edit_file failed: ${err.message}</tool_use_error>`,
          });
        }
        continue;
      }

      if (action.tool === "list_dir") {
        try {
          const dirPath = action.path || action.dirPath;
          if (!dirPath) throw new Error("list_dir requires 'path' (string)");
          onUpdate("executing", `Listing directory: ${dirPath}`, action);
          let contents: string;
          if (options?.isSSH && options.sessionId) {
            // SSH: use ls command on remote host
            const execResult = await (window as any).electron.ipcRenderer.invoke("terminal.exec", { sessionId: options.sessionId, command: `ls -1aF '${dirPath}'` });
            if (execResult.exitCode !== 0) throw new Error(execResult.stderr || "Directory not found");
            // Parse ls -1aF output: dirs end with /, skip . and ..
            contents = execResult.stdout.trim().split("\n")
              .filter((l: string) => l && l !== "./" && l !== "../")
              .map((l: string) => l.endsWith("/") ? `[DIR] \t${l.slice(0, -1)}` : `[FILE]\t${l.replace(/[*@|=]$/, "")}`)
              .join("\n");
          } else {
            const result = await (window as any).electron.ipcRenderer.invoke(
              "file.listDir",
              { dirPath, ...(options?.sessionId ? { sessionId: options.sessionId } : {}) },
            );
            if (!result.success) throw new Error(result.error || "Unknown list error");
            contents = result.contents
              .map((c: any) => `${c.isDirectory ? "[DIR] " : "[FILE]"}\t${c.name}`)
              .join("\n");
          }
          onUpdate(
            "executed",
            `Listed directory: ${dirPath}\n---\n${contents.slice(0, 500)}${contents.length > 500 ? "..." : ""}`,
            action
          );
          history.push({
            role: "user",
            content: `Directory contents for ${dirPath}:\n${contents}`,
          });
        } catch (err: any) {
          // Non-critical: agent can continue without listing
          onUpdate("executed", `Could not list ${action.path || action.dirPath || "directory"} (${err.message})`, action);
          history.push({
            role: "user",
            content: `<tool_use_error>list_dir failed: ${err.message}</tool_use_error>`,
          });
        }
        continue;
      }

      if (action.tool === "search_dir") {
        try {
          const dirPath = action.path || action.dirPath;
          const query = action.query;
          if (!dirPath || typeof query !== "string") {
            throw new Error("search_dir requires 'path' and 'query' (strings)");
          }
          onUpdate("executing", `Searching '${query}' in: ${dirPath}`, action);
          let summary: string;
          let lines: string;
          if (options?.isSSH && options.sessionId) {
            // SSH: use grep on remote host
            const escaped = query.replace(/'/g, "'\\''");
            const execResult = await (window as any).electron.ipcRenderer.invoke("terminal.exec", { sessionId: options.sessionId, command: `grep -rn --include='*' '${escaped}' '${dirPath}' 2>/dev/null | head -100` });
            // grep returns exit code 1 when no matches — not an error
            const output = (execResult.stdout || "").trim();
            if (!output) {
              summary = "Found 0 matches.";
              lines = "";
            } else {
              const matchLines = output.split("\n");
              summary = `Found ${matchLines.length} matches.`;
              lines = output;
            }
          } else {
            const result = await (window as any).electron.ipcRenderer.invoke(
              "file.searchDir",
              { dirPath, query, ...(options?.sessionId ? { sessionId: options.sessionId } : {}) },
            );
            if (!result.success) throw new Error(result.error || "Unknown search error");
            lines = result.results
              .map((r: any) => `${r.file}:${r.line}: ${r.content}`)
              .join("\n");
            summary = `Found ${result.results.length} matches.`;
          }
          onUpdate(
            "executed",
            `Searched directory: ${dirPath}\n---\n${summary}`,
            action
          );
          history.push({
            role: "user",
            content: `${summary}\n${lines}`,
          });
        } catch (err: any) {
          // Non-critical: agent can continue without search results
          onUpdate("executed", `Could not search ${action.path || action.dirPath || "directory"} (${err.message})`, action);
          history.push({
            role: "user",
            content: `<tool_use_error>search_dir failed: ${err.message}</tool_use_error>`,
          });
        }
        continue;
      }

      if (action.tool === "web_search") {
        const query = action.query || action.q;
        if (!query) {
          history.push({ role: "user", content: "web_search requires a 'query' parameter." });
          continue;
        }
        // Web search counts as research → unblock any binary that was
        // gated waiting for docs lookup. Clear the per-binary error
        // counts too so a second-attempt streak doesn't immediately re-block.
        if (blockedBinaries.size > 0) {
          blockedBinaries.clear();
          binaryErrorCounts.clear();
        }
        onUpdate("executing", `Searching web: ${query}`, action);
        try {
          // Use IPC invoke — works in both Electron (preload IPC) and web mode (WS bridge → server)
          const data: any = await (window as any).electron.ipcRenderer.invoke("web.search", { query });
          const results = data.results || [];
          if (results.length === 0) {
            onUpdate("executed", `Web search: no results for "${query}"`, { ...action, searchResults: [] });
            history.push({ role: "user", content: `Web search for "${query}" returned no results.` });
          } else {
            const formatted = results.map((r: any, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
            // Pass the structured results in the payload so the renderer can
            // show clickable title+url+snippet cards instead of just a count.
            onUpdate(
              "executed",
              `Web search: ${results.length} results for "${query}"`,
              { ...action, searchResults: results.slice(0, 10) },
            );
            history.push({ role: "user", content: `Web search results for "${query}":\n\n${formatted}\n\nUse these results to answer the user's question. You may web_fetch any URL above for more details.` });
            usedWebTools = true;
          }
        } catch (err: any) {
          onUpdate("executed", `Web search failed: ${err.message}`, action);
          history.push({ role: "user", content: `<tool_use_error>web_search failed: ${err.message}</tool_use_error>` });
        }
        continue;
      }

      if (action.tool === "web_fetch") {
        // Same as web_search — fetching docs unblocks reprobe gate.
        if (blockedBinaries.size > 0) {
          blockedBinaries.clear();
          binaryErrorCounts.clear();
        }
        const url = action.url;
        if (!url) {
          history.push({ role: "user", content: "web_fetch requires a 'url' parameter." });
          continue;
        }
        onUpdate("executing", `Fetching: ${url.slice(0, 80)}`, action);
        try {
          // Use IPC invoke — works in both Electron (preload IPC) and web mode (WS bridge → server)
          const data: any = await (window as any).electron.ipcRenderer.invoke("web.fetch", { url });
          if (data.error) {
            onUpdate("executed", `Fetch failed: ${data.error}`, action);
            history.push({ role: "user", content: `<tool_use_error>web_fetch failed: ${data.error}</tool_use_error>` });
          } else {
            const content = data.content || "";
            const truncated = content.length > 12000 ? content.slice(0, 12000) + "\n\n[Content truncated — 12KB limit]" : content;
            onUpdate("executed", `Fetched ${url.slice(0, 60)} (${content.length} chars)`, action);
            history.push({ role: "user", content: `Content from ${url}:\n\n${truncated}` });
            usedWebTools = true;
          }
        } catch (err: any) {
          onUpdate("executed", `Web fetch failed: ${err.message}`, action);
          history.push({ role: "user", content: `<tool_use_error>web_fetch failed: ${err.message}</tool_use_error>` });
        }
        continue;
      }

      if (action.tool === "execute_command") {
        // Search-before-reprobe gate: if this binary+subcommand has already
        // failed twice without an intervening web_search/web_fetch, block
        // and force the agent to look it up. Pure harness rule — small
        // models ignore prompt directives but obey hard tool rejections.
        const binaryKey = extractBinaryKey(action.command || "");
        if (binaryKey && blockedBinaries.has(binaryKey)) {
          onUpdate(
            "failed",
            `Blocked: '${binaryKey}' has failed repeatedly. web_search the docs or ask_question first.`,
            action,
          );
          history.push({
            role: "user",
            content: `<tool_use_error>execute_command blocked: '${binaryKey}' has already errored twice. Before invoking it again you MUST either (a) web_search "${binaryKey} documentation" and web_fetch a result, OR (b) ask_question to get the correct invocation from the user. Probing more --help variants will not help — the help output you've already seen has been processed.</tool_use_error>`,
          });
          consecutiveGuardBlocks++;
          continue;
        }

        // Interactive commands MUST use run_in_terminal — sentinel exec can't handle TUI prompts.
        // Also check parts after `&&` or `;` to properly catch `cd foo && npm create`
        const INTERACTIVE_CMD_RE =
          /\b(npm\s+create|npx\s+create|npm\s+init|yarn\s+create|pnpm\s+create|bun\s+create|npx\s+degit|npx\s+giget)\b/i;

        // Split chained commands to check if ANY part is interactive
        const chainedCommands = action.command.split(/;|&&/);
        const isInteractive = chainedCommands.some((part: string) => INTERACTIVE_CMD_RE.test(part));

        if (isInteractive) {
          if (usedScaffold) {
            // Project already scaffolded — redirect to write_file, NOT run_in_terminal (which would also block)
            onUpdate(
              "failed",
              `Blocked: project already scaffolded — use write_file to implement features`,
              action
            );
            history.push({
              role: "user",
              content: `Error: A scaffold command was already run. Do NOT re-run scaffold commands (npm create, npx create, etc.). If the project directory doesn't exist at the expected location (scaffold may have placed it elsewhere), create it manually with mkdir via execute_command, then use write_file to create files.${terminalBusy ? " The dev server is running and will hot-reload your changes automatically." : ""}`,
            });
          } else {
            onUpdate(
              "failed",
              `Blocked: interactive command "${action.command.slice(0, 60)}" — use run_in_terminal`,
              action
            );
            history.push({
              role: "user",
              content: `Error: "${action.command}" is an interactive command with prompts/menus. You MUST use run_in_terminal instead of execute_command for scaffold/create commands. Then monitor with read_terminal.`,
            });
          }
          consecutiveGuardBlocks++;
          continue;
        }

        // Pre-flight check — catch running servers/TUI programs before sentinel-based exec
        let stoppedServerForExec = false;
        if (!terminalBusy) {
          const pfOutput = await readTerminal(30);
          const pfState = classifyTerminalOutput(pfOutput || "");

          // Server/daemon or busy process — stop it first so the command runs in a shell
          if (pfState === "server" || pfState === "busy") {
            onUpdate("executing", `Stopping ${pfState === "server" ? "server" : "process"} to run: ${(action.command || "").slice(0, 60)}…`, action);
            const stopped = await smartStopProcess();
            if (stopped) {
              onUpdate("executed", `Stopped ${pfState === "server" ? "server" : "process"}`, action);
              stoppedServerForExec = true;
              terminalBusy = false;
            } else if (pfState === "server") {
              onUpdate("failed", `Server still running — command not executed`, action);
              history.push({
                role: "user",
                content: `(Command NOT executed — a process is running in the terminal and could not be stopped. You must stop it manually: try send_text("\\x03"), send_text("q\\r"), or send_text("\\x04"), then read_terminal to confirm idle, then retry the command.)`,
              });
              continue;
            } else {
              onUpdate("executed", `Stopping process to run: ${(action.command || "").slice(0, 60)}… (process still busy)`, action);
              terminalBusy = true;
            }
          }

          // TUI detection — skip if idle (shell prompt means no TUI running)
          if (pfState !== "idle" && pfState !== "server") {
            const tui = detectTuiProgram(pfOutput || "");
            if (tui) {
              onUpdate("executed", `Exiting TUI "${tui}"…`, action);
              const result = await attemptTuiExit(tui, writeToTerminal, readTerminal);
              if (result.exited) {
                onUpdate("executed", `Exited ${tui} (${result.attempts.join(" → ")})`, action);
                tuiExitFailures = 0;
              } else {
                tuiExitFailures++;
                if (tuiExitFailures >= 2) {
                  onUpdate("executed", `Cannot exit TUI "${tui}" — asking user`, action);
                  history.push({
                    role: "user",
                    content: `(Auto-exit failed ${tuiExitFailures} times for TUI "${tui}". You MUST use ask_question NOW to tell the user to manually close the TUI program, then wait for their confirmation before retrying.)`,
                  });
                } else {
                  history.push({
                    role: "user",
                    content: `(Command NOT executed — TUI "${tui}" still running after exit attempts: ${result.attempts.join(" → ")}. Use send_text to exit manually, then read_terminal to confirm idle.)`,
                  });
                }
                continue;
              }
            }
          }
        }
        // execute_command uses sentinel-based exec — can't work with a foreground process
        if (terminalBusy) {
          const state = await detectTerminalState();
          if (state === "input_needed") {
            consecutiveBusy = 0;
            const output = await readTerminal(15);
            onUpdate("executed", `Terminal waiting for input`, action);
            history.push({
              role: "user",
              content: `(Command NOT executed — terminal is waiting for user input.)\n${output}\n\nWARNING: The terminal is paused waiting for your response. Use send_text to type the answer and hit Enter (\\r). DO NOT ASK THE USER UNLESS CRITICAL. For scaffold/init prompts like "yes/no" or "framework", guess the best option and use send_text immediately.`,
            });
            continue;
          } else if (state === "busy") {
            // Check if a TUI program is running — auto-exit it
            const tuiOutput = await readTerminal(30);
            const tui = detectTuiProgram(tuiOutput);
            if (tui) {
              consecutiveBusy = 0;
              onUpdate("executed", `Exiting TUI "${tui}"…`, action);
              const result = await attemptTuiExit(tui, writeToTerminal, readTerminal);
              if (result.exited) {
                onUpdate("executed", `Exited ${tui} (${result.attempts.join(" → ")})`, action);
                terminalBusy = false;
                tuiExitFailures = 0;
              } else {
                tuiExitFailures++;
                if (tuiExitFailures >= 2) {
                  onUpdate("executed", `Cannot exit TUI "${tui}" — asking user`, action);
                  history.push({
                    role: "user",
                    content: `(Auto-exit failed ${tuiExitFailures} times for TUI "${tui}". You MUST use ask_question NOW to tell the user to manually close the TUI program, then wait for their confirmation before retrying.)`,
                  });
                } else {
                  history.push({
                    role: "user",
                    content: `(Command NOT executed — TUI "${tui}" still running after exit attempts: ${result.attempts.join(" → ")}. Use send_text to exit manually, then read_terminal to confirm idle.)`,
                  });
                }
                continue;
              }
            }
            if (!terminalBusy) {
              // TUI was exited above — skip busy waiting, proceed to command
            } else {
              // Process still running (installing, building) — DON'T kill it, wait with backoff
              consecutiveBusy++;
              const waitMs = Math.min(2000 * consecutiveBusy, 8000);
              await new Promise((r) => setTimeout(r, waitMs));
              // Re-check after waiting
              const freshState = await detectTerminalState();
              if (freshState === "idle") {
                terminalBusy = false;
                consecutiveBusy = 0;
                const finishedOutput = await readTerminal(15);
                history.push({
                  role: "user",
                  content: `(Previous terminal process finished. Output:\n${finishedOutput}\n)`,
                });
                // Don't continue — let the original command execute
              } else if (consecutiveBusy >= 10) {
                onUpdate(
                  "executed",
                  `(Terminal busy for ${consecutiveBusy} checks — skipping command)`,
                  action
                );
                history.push({
                  role: "user",
                  content: `(Terminal has been busy for ${consecutiveBusy} consecutive checks. The process may be stalled or waiting for input not detected as a prompt. You MUST either:\n1. Use send_text("\\x03") to Ctrl+C the process\n2. Use send_text to provide input\n3. Use final_answer to report the current state\nDo NOT attempt more run_in_terminal or execute_command calls.)`,
                });
                continue;
              } else {
                const output = await readTerminal(15);
                onUpdate(
                  "executed",
                  "(Terminal busy — auto-read)\n---\n" +
                  (output || "(no output)"),
                  action
                );
                history.push({
                  role: "user",
                  content: `(Command NOT executed — terminal is busy running a process. Use ONLY read_terminal to monitor progress. Do NOT use execute_command or run_in_terminal until the process finishes. Be patient — builds, installs, and docker operations can take several minutes.)\nCurrent output:\n${output}`,
                });
                continue;
              }
            }
          } else if (state === "server") {
            // Dev server is running — auto-stop it so the command can execute
            onUpdate("executing", `Stopping server to run: ${(action.command || "").slice(0, 60)}…`, action);
            const stopped = await smartStopProcess();
            if (stopped) {
              terminalBusy = false;
              stoppedServerForExec = true;
              onUpdate("executed", `Stopped server`, action);
              // Fall through to execute the command
            } else {
              onUpdate("failed", `Server could not be stopped`, action);
              history.push({
                role: "user",
                content: `(Command NOT executed — process could not be stopped. You must stop it manually: try send_text("\\x03"), send_text("q\\r"), or send_text("\\x04"), then read_terminal to confirm idle, then retry.)`,
              });
              consecutiveGuardBlocks++;
              continue;
            }
          } else {
            // idle — process already finished; read output so agent knows what happened
            consecutiveBusy = 0;
            terminalBusy = false;
            const finishedOutput = await readTerminal(15);
            const nudge =
              usedScaffold && !wroteFiles
                ? `\nThe scaffold/install is complete. Now use write_file to implement the user's requested features. Do NOT run ls, mkdir, or any scaffold commands.`
                : "";
            history.push({
              role: "user",
              content: `(Previous terminal process finished. Output:\n${finishedOutput}\n)${nudge}`,
            });
          }
        }

        // Auto-prepend cd if agent wrote files to a project dir but forgot to cd
        let cmd = autoCdCommand(action.command, lastWriteDir);

        // Guard: block recursive ls/find on broad directories to prevent massive output
        const cmdForCheck = cmd
          .replace(/^cd\s+\S+\s*(?:&&|;)\s*/, "")
          .trim()
          .toLowerCase();
        if (/^ls\s/.test(cmdForCheck) && /\s-[a-z]*r|-r\b/i.test(cmdForCheck)) {
          // Extract non-flag args after ls
          const lsTokens = cmdForCheck.replace(/^ls\s+/, "").split(/\s+/);
          const dirs = lsTokens.filter((t) => !t.startsWith("-"));
          const hasSafeTarget = dirs.some(
            (d) =>
              d.length > 1 && d !== "." && d !== ".." && d !== "~" && d !== "/",
          );
          if (!hasSafeTarget) {
            onUpdate(
              "failed",
              `Blocked: recursive ls without specific directory`,
              action
            );
            history.push({
              role: "user",
              content: `Error: "ls -R" on the current/home directory produces massive output (recursively lists everything including node_modules). Specify the exact project directory path: "ls -R /absolute/path/to/project"${lastWriteDir ? ` (project directory: "${lastWriteDir}")` : ""}. Or use "ls" (non-recursive) to see what's in the current directory.`,
            });
            consecutiveGuardBlocks++;
            continue;
          }
        }

        // After scaffolding, only block mkdir (write_file handles directories)
        if (
          usedScaffold &&
          !wroteFiles &&
          /^\s*(mkdir)\b/.test(cmd.replace(/^cd\s+[^\s&;|]+\s*(?:&&|;)\s*/, ""))
        ) {
          onUpdate(
            "failed",
            `Blocked: "${cmd.slice(0, 60)}" — use write_file instead`,
            action
          );
          history.push({
            role: "user",
            content: `Error: Do not manually create directories. Use write_file with the full path — it creates parent directories automatically.`,
          });
          consecutiveGuardBlocks++;
          continue;
        }

        // Block rm -rf on the project directory after code has been written
        if (wroteFiles && lastWriteDir && /\brm\s+(-\w+\s+)*/.test(cmd)) {
          const rmTargetMatch = cmd.match(/\brm\s+(?:-\w+\s+)*([^\s&;|]+)/);
          if (
            rmTargetMatch &&
            (rmTargetMatch[1].startsWith(lastWriteDir) ||
              lastWriteDir.startsWith(rmTargetMatch[1]))
          ) {
            onUpdate(
              "failed",
              `Blocked: destructive rm on project directory after code written`,
              action
            );
            history.push({
              role: "user",
              content: `Error: You CANNOT delete the project directory "${lastWriteDir}" — you already wrote code there. Use write_file to modify files instead.`,
            });
            consecutiveGuardBlocks++;
            continue;
          }
        }

        executedCommands.add(cmd);

        onUpdate("executing", cmd, action);
        try {
          let output = await executeCommand(cmd);

          // Detect timeout — process is still running in terminal
          if (output && output.startsWith("__TIMEOUT__")) {
            output = output.slice("__TIMEOUT__".length);
            terminalBusy = true;
            onUpdate("executed", cmd + "\n---\n" + output, action);
            history.push({
              role: "user",
              content: `${output}\n\nIMPORTANT: The command is STILL RUNNING in the terminal. Use read_terminal to monitor progress. Do NOT run execute_command or Ctrl+C — wait patiently.`,
            });
            continue;
          }

          if (!output || output.trim() === "") {
            output = "(Command executed successfully with no output)";
          }
          // Successful exec means terminal is at shell prompt
          terminalBusy = false;
          consecutiveGuardBlocks = 0;
          // Track mkdir as project dir
          const mkdirMatch = cmd.match(/\bmkdir\s+(?:-p\s+)?([^\s&;|]+)/);
          if (mkdirMatch) lastWriteDir = mkdirMatch[1];
          onUpdate("executed", cmd + "\n---\n" + output, action);
          const serverNote = stoppedServerForExec
            ? "\n\n⚠️ NOTE: A dev server was automatically stopped to run this command. If you need the server running again, restart it with run_in_terminal.\n⚠️ IMPORTANT: All previous terminal output (including any error messages from the old server) is STALE. Only trust output from THIS command and future commands."
            : "";
          history.push({
            role: "user",
            content: `Command Output: \n${output}${serverNote}`,
          });
          // Search-before-reprobe bookkeeping: a non-zero exit (output
          // starts with "Exit Code N:") counts as a failure for this
          // binary even though the harness call itself didn't throw.
          if (binaryKey && /^Exit Code\s+[1-9]\d*:/i.test(output)) {
            const n = (binaryErrorCounts.get(binaryKey) ?? 0) + 1;
            binaryErrorCounts.set(binaryKey, n);
            if (n >= 2) blockedBinaries.add(binaryKey);
          } else if (binaryKey) {
            // Any successful run resets the counter for that binary.
            binaryErrorCounts.delete(binaryKey);
          }
        } catch (err: any) {
          const isDeny = err.message === "User denied command execution.";
          onUpdate("failed", cmd + "\n---\n" + err.message, action);
          if (isDeny) {
            history.push({
              role: "user",
              content: `User DENIED this command. Do NOT retry it. Either:\n1. Use ask_question to ask the user why they denied it and what they'd prefer\n2. Try a completely different approach\n3. Use final_answer to report that you cannot proceed without this command`,
            });
          } else {
            history.push({
              role: "user",
              content: `<tool_use_error>execute_command failed: ${err.message}</tool_use_error>`,
            });
            // Bump the per-binary error count too — thrown errors are
            // also failures by any reasonable definition.
            if (binaryKey) {
              const n = (binaryErrorCounts.get(binaryKey) ?? 0) + 1;
              binaryErrorCounts.set(binaryKey, n);
              if (n >= 2) blockedBinaries.add(binaryKey);
            }
            // Check for repeated error patterns — force root-cause investigation
            const intervention = checkRepeatedErrors(err.message);
            if (intervention) {
              history.push({ role: "user", content: intervention });
            }
          }
        }
      }

      // --- Multi-tool-call correction ---
      // When model generated multiple tool calls in one response, remind it
      // to use one tool at a time so it actually processes each result.
      if (multiToolWarnings > 0) {
        history.push({
          role: "user",
          content: "IMPORTANT: You generated multiple tool calls in your last response. Only the FIRST one was executed (above). Output exactly ONE JSON tool call per response, then WAIT for the result before calling the next tool.",
        });
      }

      // --- Progress tracking & reflection ---
      // Track meaningful progress
      const lastStep = history[history.length - 1]?.content || "";
      const madeProgress =
        lastStep.includes("Command Output:") ||
        lastStep.includes("File written successfully") ||
        lastStep.includes("File edited successfully") ||
        lastStep.includes("Command started in terminal");
      if (madeProgress) {
        commandsSucceeded++;
        lastProgressStep = i;
      } else if (
        lastStep.startsWith("Command Failed") ||
        lastStep.startsWith("Edit File Failed") ||
        lastStep.startsWith("Write File Failed")
      ) {
        commandsFailed++;
      }

      // Reflection checkpoint every 8 steps
      if (i > 0 && i % 8 === 0) {
        const stepsSinceProgress = i - lastProgressStep;
        if (stepsSinceProgress >= 6) {
          // No meaningful progress in 6+ steps — force reflection
          history.push({
            role: "user",
            content: `REFLECTION (step ${i}/${maxSteps}): You have not made meaningful progress in ${stepsSinceProgress} steps (${commandsFailed} failures, ${commandsSucceeded} successes total). Step back and consider:\n1. What is the original task?\n2. What is actually blocking you?\n3. Is there a simpler approach?\nIf you cannot make progress, use final_answer to explain what went wrong.`,
          });
        }
      }

      // Context compaction: compress old tool results to save context space
      if (history.length > 30) {
        for (let j = 2; j < history.length - 12; j++) {
          const msg = history[j];
          if (msg.role !== "user") continue;
          const c = msg.content;
          // Compress large command outputs
          if (c.startsWith("Command Output:") && c.length > 500) {
            const lines = c.split("\n");
            msg.content = `Command Output (compressed): ${lines.slice(0, 3).join("\n")}\n...(${lines.length - 4} lines omitted)...\n${lines.slice(-2).join("\n")}`;
          }
          // Compress large file reads
          if (
            c.length > 2000 &&
            !c.startsWith("CRITICAL") &&
            !c.startsWith("LOOP") &&
            !c.startsWith("REFLECTION") &&
            !c.startsWith("BLOCKED")
          ) {
            msg.content =
              c.slice(0, 800) +
              `\n...(${c.length - 1000} chars compressed)...\n` +
              c.slice(-200);
          }
        }
      }
    }

    return {
      success: false,
      message: "Agent reached maximum steps without completion.",
      type: "failure",
    };
  }
}

export const aiService = new AIService();
