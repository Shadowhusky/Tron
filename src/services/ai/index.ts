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
  describeKeys as describeKeysUtil,
  autoCdCommand,
  isDuplicateScaffold,
  type TerminalState,
} from "../../utils/terminalState";
import agentPrompt from "./agent.md?raw";
import DEFAULT_MODELS from "../../constants/models.json";

export interface AgentContinuation {
  history: any[];
  executedCommands: string[];
  usedScaffold: boolean;
  wroteFiles: boolean;
  lastWriteDir: string;
  terminalBusy: boolean;
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
}

const CLOUD_PROVIDERS: Record<string, ProviderInfo> = {
  openai: {
    chatUrl: "https://api.openai.com/v1/chat/completions",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).openai || [],
    placeholder: "gpt-5.2",
    label: "OpenAI",
  },
  anthropic: {
    chatUrl: "https://api.anthropic.com/v1/messages",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).anthropic || [],
    placeholder: "claude-sonnet-4-6",
    label: "Anthropic",
  },
  gemini: {
    chatUrl:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).gemini || [],
    placeholder: "gemini-2.5-flash",
    label: "Gemini (Google)",
  },
  deepseek: {
    chatUrl: "https://api.deepseek.com/chat/completions",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).deepseek || [],
    placeholder: "deepseek-chat",
    label: "DeepSeek",
  },
  kimi: {
    chatUrl: "https://api.moonshot.ai/v1/chat/completions",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).kimi || [],
    placeholder: "kimi-k2.5",
    label: "Kimi (Moonshot)",
  },
  qwen: {
    chatUrl:
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).qwen || [],
    placeholder: "qwen3.5-plus",
    label: "Qwen (Alibaba)",
  },
  glm: {
    chatUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).glm || [],
    placeholder: "glm-5",
    label: "GLM (Zhipu)",
  },
  minimax: {
    chatUrl: "https://api.minimax.io/v1/text/chatcompletion_v2",
    defaultModels: (DEFAULT_MODELS as Record<string, string[]>).minimax || [],
    placeholder: "MiniMax-M2.5",
    label: "MiniMax",
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
    provider in CLOUD_PROVIDERS
  );
}

/**
 * Detect models that require OpenAI's Responses API (/v1/responses).
 * GPT-5+ codex models and standalone codex-* models are Responses-only.
 */
function isResponsesModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.includes("codex");
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

    // Cloud providers — show defaults if API key is set
    if (effectiveApiKey) {
      const info = CLOUD_PROVIDERS[provider];
      if (info) {
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
    return models;
  }

  async summarizeContext(history: string): Promise<string> {
    const { provider, model, apiKey, baseUrl } = this.config;
    const prompt = `Summarize the following terminal session history. Retain key actions, file changes, errors, and state changes. Be concise.\n\n${history}`;

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

      if (
        isAnthropicProtocol(provider) &&
        (apiKey || provider === "anthropic-compat")
      ) {
        const response = await proxyFetch(getAnthropicChatUrl(provider, baseUrl), {
          method: "POST",
          headers: this.anthropicHeaders(apiKey),
          body: JSON.stringify({
            model,
            max_tokens: 500,
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
          500,
          providerUsesBaseUrl(provider) ? baseUrl : undefined,
        );
        return result || history;
      }
    } catch (e) {
      console.warn("Context compression failed, using raw history", e);
    }
    return history;
  }

  /** Stream an Ollama /api/generate response, calling onToken for each chunk. Returns full text. */
  private async streamOllamaGenerate(
    baseUrl: string,
    model: string,
    prompt: string,
    onToken?: (token: string, thinking?: string) => void,
    signal?: AbortSignal,
    apiKey?: string,
  ): Promise<string> {
    const response = await proxyFetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: this.jsonHeaders(apiKey),
      body: JSON.stringify({ model, prompt, stream: true }),
      signal,
    });
    if (!response.ok) throw new Error(`Ollama Error: ${response.status}`);
    if (!response.body) throw new Error("No response body for streaming");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
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
          if (chunk.thinking && onToken) onToken("", chunk.thinking);
          if (chunk.response) {
            fullText += chunk.response;
            if (onToken) onToken(chunk.response);
          }
        } catch {
          /* skip malformed lines */
        }
      }
    }
    return fullText;
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
    // Many models reject think + format:"json" together — never send both
    const body: any = { model, messages, stream: true };
    if (format) {
      body.format = format;
      // Don't enable think when requesting structured output
    } else if (think) {
      body.think = true;
    }

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
        throw new Error(`API Error: ${errJson.error.message || errJson.error}`);
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
  ): Promise<string> {
    const { provider, model, apiKey, baseUrl } = this.config;

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
        const timeout = setTimeout(() => controller.abort(), 15000);

        try {
          const result = await this.streamOllamaGenerate(
            baseUrl || "http://localhost:11434",
            model,
            `${systemPrompt}\n\nUser request: ${prompt}\nCommand:`,
            onToken ? (token) => onToken(token) : undefined,
            controller.signal,
            apiKey,
          );
          clearTimeout(timeout);
          return result.trim();
        } catch (fetchError: any) {
          clearTimeout(timeout);
          if (fetchError.name === "AbortError")
            throw new Error("Ollama connection timed out. Is it running?");
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
            max_tokens: 300,
            system: systemPrompt,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const data = await response.json();
        return data.content[0].text.trim();
      }

      // OpenAI-compatible providers (openai, deepseek, kimi, gemini, glm, lmstudio, openai-compat)
      if (isOpenAICompatible(provider)) {
        if (!apiKey && !providerUsesBaseUrl(provider))
          throw new Error(
            `${CLOUD_PROVIDERS[provider]?.label || provider} API Key required`,
          );
        return await this.openAIChatSimple(
          provider,
          model,
          apiKey || "",
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          300,
          providerUsesBaseUrl(provider) ? baseUrl : undefined,
        );
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
        const response = await proxyFetch(
          `${baseUrl || "http://localhost:11434"}/api/generate`,
          {
            method: "POST",
            headers: this.jsonHeaders(apiKey),
            body: JSON.stringify({
              model,
              prompt: `${systemPrompt}\n\n${userContent}\n\nSuggestion:`,
              stream: false,
            }),
            signal: combinedSignal,
          },
        );
        if (!response.ok) return "";
        const data = await response.json();
        const result = (data.response || "").trim().replace(/^`+|`+$/g, "");
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

      // OpenAI-compatible providers — stream so placeholder appears progressively
      if (
        isOpenAICompatible(provider) &&
        (apiKey || providerUsesBaseUrl(provider))
      ) {
        const messages = [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ];
        const result = await this.streamOpenAIChat(
          provider,
          model,
          apiKey || "",
          messages,
          onToken
            ? (token) => {
              if (token) onToken(token);
            }
            : undefined,
          combinedSignal,
          undefined,
          baseUrl,
        );
        const raw = result.content.trim();
        const clean = raw
          .replace(/^`+|`+$/g, "")
          .split("\n")[0]
          .trim();
        return clean.length <= 80 ? clean : "";
      }
    } catch {
      // Silently fail — placeholder is non-critical
    }
    return "";
  }

  /** Generate a very short tab title (2-5 words) from the user's prompt. Fire-and-forget safe. */
  async generateTabTitle(
    prompt: string,
    sessionConfig?: AIConfig,
  ): Promise<string> {
    const cfg = sessionConfig || this.config;
    const provider = cfg.provider;
    const model = cfg.model;
    const apiKey = cfg.apiKey || this.config.apiKey;
    const baseUrl = providerUsesBaseUrl(provider) ? cfg.baseUrl : undefined;
    const systemPrompt = `Generate a very short title (2-5 words, max 25 chars) for a terminal session based on the user's task. Output ONLY the title, no quotes, no punctuation, no explanation. Examples: "Fix Login Bug", "Setup Docker", "Git Rebase Main", "Deploy API".`;

    try {
      if (provider === "ollama") {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const response = await proxyFetch(
            `${baseUrl || "http://localhost:11434"}/api/generate`,
            {
              method: "POST",
              headers: this.jsonHeaders(apiKey),
              body: JSON.stringify({
                model,
                prompt: `${systemPrompt}\n\nUser task: ${prompt.slice(0, 200)}\n\nTitle:`,
                stream: false,
              }),
              signal: controller.signal,
            },
          );
          clearTimeout(timeout);
          if (!response.ok) return "";
          const data = await response.json();
          const result = (data.response || "")
            .trim()
            .replace(/^["'`]+|["'`]+$/g, "");
          return result.length > 0 && result.length <= 30 ? result : "";
        } catch {
          clearTimeout(timeout);
          return "";
        }
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
            messages: [{ role: "user", content: prompt.slice(0, 200) }],
          }),
        });
        const data = await response.json();
        const result = (data.content?.[0]?.text || "")
          .trim()
          .replace(/^["'`]+|["'`]+$/g, "");
        return result.length > 0 && result.length <= 30 ? result : "";
      }

      // OpenAI-compatible providers — no max_tokens (crashes some local models)
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
            { role: "user", content: prompt.slice(0, 200) },
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
    options?: { isSSH?: boolean; sessionId?: string },
  ): Promise<AgentResult> {
    const cfg = sessionConfig || this.config;
    const provider = cfg.provider;
    const model = cfg.model;
    // Fall back to global apiKey if session config doesn't have one (e.g.
    // model selected via ContextBar before settings propagated).
    const apiKey = cfg.apiKey || this.config.apiKey;
    // Only send baseUrl for providers that use it — prevents Ollama localhost leak.
    const baseUrl = providerUsesBaseUrl(provider) ? cfg.baseUrl : undefined;

    const maxSteps = sessionConfig?.maxAgentSteps || 100;

    // Initialize state — resume from continuation or start fresh
    let history: any[];
    let executedCommands: Set<string>;
    let lastWriteDir: string;
    let usedScaffold: boolean;
    let wroteFiles: boolean;
    let terminalBusy: boolean;

    if (continuation) {
      // Resume after ask_question — restore full conversation and tracking state
      history = continuation.history;
      history.push({ role: "user", content: prompt });
      executedCommands = new Set(continuation.executedCommands);
      lastWriteDir = continuation.lastWriteDir;
      usedScaffold = continuation.usedScaffold;
      wroteFiles = continuation.wroteFiles;
      terminalBusy = continuation.terminalBusy;
    } else {
      history = [
        {
          role: "system",
          content: `Terminal agent. Respond ONLY with valid JSON.

TOOLS:
1. {"tool":"execute_command","command":"..."} — Run a non-interactive command, get output. For: ls, mkdir, grep, git, npm install.
2. {"tool":"run_in_terminal","command":"..."} — Run interactive/long-running commands (npm create, dev servers). Monitor with read_terminal after.
3. {"tool":"read_terminal","lines":50} — Read last N lines of terminal output.
4. {"tool":"send_text","text":"...","description":"..."} — Send keystrokes. Include description. Keys: \\r=Enter, \\x1B[B=Down, \\x1B[A=Up, \\x03=Ctrl+C.
5. {"tool":"ask_question","question":"..."} — Ask user for clarification.
6. {"tool":"final_answer","content":"..."} — Task complete. 1-3 lines.
7. {"tool":"write_file","path":"/absolute/path","content":"..."} — Create a NEW file or fully replace a small file. Do NOT use for modifying existing files — use edit_file instead.
8. {"tool":"read_file","path":"/absolute/path"} — Read a file's content directly. Use INSTEAD of cat through execute_command for reading files.
9. {"tool":"list_dir","path":"/absolute/path"} — List contents of a directory safely. Use INSTEAD of ls or dir.
10. {"tool":"search_dir","path":"/absolute/path","query":"..."} — Search for text inside a directory recursively. High performance, preferred over grep.
11. {"tool":"edit_file","path":"/absolute/path","search":"...","replace":"..."} — PREFERRED for modifying existing files. Exact string search-and-replace. Use this for any change to an existing file — even multiple edits are better than rewriting the whole file.

RULES:
1. Execute commands directly. Do not explain what you would do.
2. On failure, read error, fix root cause.
3. If user denies permission, STOP.
4. FILE OPERATIONS: Use read_file to read, list_dir to explore, search_dir to find text, edit_file to modify existing files, write_file ONLY for new files. NEVER rewrite an entire existing file with write_file when you only need to change part of it — use edit_file instead (multiple edit_file calls if needed). Do NOT use cat, heredoc, grep, ls, or printf through the terminal.
5. After interactive command: read_terminal → if menu, send_text → read_terminal again. Loop until done.
6. START DEV SERVER ONLY AS THE VERY LAST STEP. Do not start it until all files are written, dependencies installed, and configuration is complete. Once started, the terminal is blocked.
7. SCAFFOLDING: If the target directory might exist, run "rm -rf <dir>" FIRST. Do NOT run "mkdir" before scaffolding tools (npm create, git clone) — let them create the directory. This avoids "Directory not empty" prompts. Use non-interactive flags (e.g. --yes) where possible.
8. AUTONOMY & STATE: Do NOT ask the user questions about system state (e.g. "Is the server running?", "Is the file created?", "What is on port X?"). CHECK IT YOURSELF using commands like "ps aux | grep <name>", "curl -I localhost:<port>", "lsof -i :<port>", or "ls -F". Only ask if you cannot determine the state programmatically after trying.
9. INTERACTIVE PROMPTS: If a terminal command stops to ask a question (like "Use Experimental Vite?" or "Ok to proceed?"), do NOT ask the user what to choose unless it's a critical architectural choice they haven't clarified. Use send_text("\\r") to accept defaults, or send_text("y\\r") to proceed automatically! Be an autonomous agent.
10. PROBLEM SOLVING: If a command fails or results are unexpected, do NOT just give up or retry blindly. ANALYZE the error message to find the root cause (missing file, permission denied, wrong path, dependency needed). PROACTIVELY FIX the issue (create the missing file, chmod, npm install, correct the path) and then retry. You have permission to fix environment issues to achieve the goal.
10. CONTEXT AWARENESS: The [PROJECT FILES] section shows existing files. Do NOT recreate files that already exist — use read_file or edit_file to modify them. Do NOT scaffold a new project if one already exists. Always check the project structure before creating files.
11. IMAGES: If the user mentions images or screenshots, they were already analyzed in a prior step. Use the description provided — do NOT try to access image files with read_file, execute_command, or ls.
12. TAB TITLE: Always include "_tab_title": "short 2-5 word title" at the root of your JSON response. This sets the terminal tab name and should reflect the current task. Update it as the task evolves. If asking for clarification, omit it.
13. FOCUS: Execute ONLY the [CURRENT TASK]. Prior conversation and terminal history are context for reference — do NOT re-execute or repeat actions from previous turns.
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
      terminalBusy = false;
    }

    // Detect terminal state by reading recent output
    const detectTerminalState = async (): Promise<TerminalState> => {
      const output = await readTerminal(20);
      return classifyTerminalOutput(output);
    };

    let parseFailures = 0;
    // Loop detection: track recent actions to break repetitive patterns
    const recentActions: string[] = [];
    let loopBreaks = 0; // Escalating loop counter
    const blockedActions = new Set<string>(); // Actions that triggered loop detection — permanently blocked
    // Progress tracking
    let lastProgressStep = 0;
    let commandsSucceeded = 0;
    let commandsFailed = 0;
    let consecutiveBusy = 0; // Count consecutive busy-state skips to avoid infinite loops
    let consecutiveGuardBlocks = 0; // Global counter for ANY guard rejection — force-stops when too high
    let lastReadTerminalOutput = ""; // Track consecutive identical read_terminal results
    let identicalReadCount = 0; // How many times in a row read_terminal returned the same content
    let readTerminalCount = 0; // Total consecutive read_terminal calls (for UI merging + backoff)

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
      if (thinkingEnabled) {
        onUpdate("thinking", "Agent is thinking...");
      }

      let responseText = "";

      // 1. Get LLM Response (streaming for Ollama)
      let thinkingText = "";
      try {
        if (provider === "ollama") {
          let thinkingAccumulated = "";
          let contentAccumulated = "";
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
                contentAccumulated += token;
                onUpdate("streaming_response", contentAccumulated);
              }
            },
            signal,
            "json",
            thinkingEnabled,
            apiKey,
          );
          responseText = result.content;
          thinkingText = result.thinking;
          if (thinkingAccumulated) {
            onUpdate("thinking_complete", thinkingAccumulated);
          } else {
            // For non-thinking models: ensure thinking state is cleared
            onUpdate("thinking_done", "");
          }
        } else if (
          isAnthropicProtocol(provider) &&
          (apiKey || provider === "anthropic-compat")
        ) {
          // Anthropic Messages API with streaming
          let contentAccumulated = "";
          const response = await proxyFetch(getAnthropicChatUrl(provider, baseUrl), {
            method: "POST",
            headers: this.anthropicHeaders(apiKey),
            body: JSON.stringify({
              model,
              max_tokens: 16384,
              system: history[0].content,
              messages: history.slice(1),
              stream: true,
            }),
            signal,
          });
          if (!response.ok) {
            const errBody = await response.text().catch(() => "");
            throw new Error(
              `${CLOUD_PROVIDERS[provider]?.label || provider} server error (${response.status}): ${errBody.slice(0, 300)}`,
            );
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
                if (evt.type === "content_block_delta" && evt.delta?.text) {
                  contentAccumulated += evt.delta.text;
                  onUpdate("streaming_response", contentAccumulated);
                }
              } catch { }
            }
          }
          responseText = contentAccumulated;
          onUpdate("thinking_done", "");
        } else if (
          isOpenAICompatible(provider) &&
          (apiKey || providerUsesBaseUrl(provider))
        ) {
          // OpenAI-compatible cloud providers with streaming
          let thinkingAccumulated = "";
          let contentAccumulated = "";
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
                contentAccumulated += token;
                onUpdate("streaming_response", contentAccumulated);
              }
            },
            signal,
            "json",
            baseUrl,
          );
          responseText = result.content;
          thinkingText = result.thinking;
          if (thinkingAccumulated) {
            onUpdate("thinking_complete", thinkingAccumulated);
          } else {
            onUpdate("thinking_done", "");
          }
        } else {
          throw new Error(
            `${CLOUD_PROVIDERS[provider]?.label || provider} requires an API key.Configure it in Settings.`,
          );
        }
      } catch (e: any) {
        if (signal?.aborted || e.name === "AbortError") {
          throw new Error("Agent aborted by user.");
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
        if (parseFailures >= 3) {
          onUpdate("error", `${label} error: ${e.message} `);
          return { success: false, message: `${label}: ${e.message}` };
        }
        // Push error context so model can adjust on retry
        history.push({ role: "assistant", content: "(API error)" });
        history.push({
          role: "user",
          content: `Error from API: ${e.message}\nPlease retry. Respond with ONLY a JSON object — no markdown, no explanation.`,
        });
        continue;
      }

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
        "write_file", "read_file", "edit_file", "list_dir", "search_dir", "ask_question", "final_answer",
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
      if (!action?.tool && thinkingText) {
        action = tryParseJson(thinkingText);
      }

      // Handle auto tab naming requested in the prompt
      if (action && action._tab_title) {
        onUpdate("set_tab_title", action._tab_title, action);
        delete action._tab_title;
        // If _tab_title was the ONLY content (no tool call), skip this iteration
        // without counting as a parse failure — model will send the real tool call next
        if (!action.tool && Object.keys(action).length === 0) {
          history.push({ role: "assistant", content: responseText || "" });
          history.push({ role: "user", content: "Good. Now proceed with the actual tool call." });
          continue;
        }
      }

      // Coerce tool-less objects or plain conversational text into proper tool calls
      if (!action || !action.tool) {
        if (!action) {
          const trimmed = (responseText || "").trim();
          if (trimmed && !trimmed.includes("{")) {
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

      if (!action || !action.tool) {
        parseFailures++;

        // After enough failures, treat raw text as a final answer rather than erroring
        if (parseFailures >= 3) {
          const fallbackText = (responseText || thinkingText || "").trim();
          // Reject if the text looks like a confused tool call attempt (JSON with "tool" key)
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
              "This model failed to follow the agent protocol (could not produce valid JSON tool calls). Try a more capable model.",
          };
        }

        // Silently retry — parse errors are internal recovery, not user-facing
        // Truncate raw text in history to avoid wasting context on bad model output
        const truncatedResponse = (responseText || "(empty)").slice(0, 500);
        history.push({ role: "assistant", content: truncatedResponse });
        history.push({
          role: "user",
          content:
            'Error: Invalid response. You MUST respond with ONLY a JSON object. No markdown, no explanation, no thinking. Example: {"tool": "execute_command", "command": "ls"} or {"tool": "final_answer", "content": "Done."}',
        });
        continue;
      }
      parseFailures = 0; // Reset on successful parse

      history.push({ role: "assistant", content: JSON.stringify(action) });

      // Loop detection: track recent actions and break repetitive patterns
      // read_terminal is excluded — its output changes over time (monitoring processes)
      const actionKey =
        action.tool === "read_terminal"
          ? null
          : JSON.stringify({
            tool: action.tool,
            path: action.path,
            command: action.command,
            text: action.text,
          });

      // Block actions that previously triggered loop detection
      if (actionKey && blockedActions.has(actionKey)) {
        history.push({
          role: "user",
          content: `BLOCKED: "${action.tool}" with these parameters was previously blocked due to looping. You MUST use a different tool or different parameters. If you cannot proceed, use final_answer.`,
        });
        continue;
      }

      if (actionKey) recentActions.push(actionKey);
      if (recentActions.length > 8) recentActions.shift();

      // Consecutive loop: same action 2 times in a row (catch on 2nd attempt). 
      // For send_text, allow up to 5 repetitions to support menu navigation (e.g., arrow keys)
      const maxConsecutive = action.tool === "send_text" ? 5 : 2;
      let isConsecutiveLoop = false;
      if (actionKey != null && recentActions.length >= maxConsecutive) {
        isConsecutiveLoop = true;
        for (let i = 1; i <= maxConsecutive; i++) {
          if (recentActions[recentActions.length - i] !== actionKey) {
            isConsecutiveLoop = false;
            break;
          }
        }
      }

      // Alternating loop: A→B→A→B→A→B pattern
      const isAlternatingLoop =
        recentActions.length >= 6 &&
        recentActions[recentActions.length - 1] ===
        recentActions[recentActions.length - 3] &&
        recentActions[recentActions.length - 3] ===
        recentActions[recentActions.length - 5] &&
        recentActions[recentActions.length - 2] ===
        recentActions[recentActions.length - 4] &&
        recentActions[recentActions.length - 4] ===
        recentActions[recentActions.length - 6];

      if (isConsecutiveLoop || isAlternatingLoop) {
        loopBreaks++;
        // Permanently block this action from being retried
        if (actionKey) blockedActions.add(actionKey);
        recentActions.length = 0;

        // Escalating response
        if (loopBreaks >= 3) {
          // After 3 loop breaks, force termination
          return {
            success: false,
            message:
              "Agent terminated: stuck in repeated loops despite multiple interventions.",
            type: "failure",
          };
        }

        // Silent retry — don't show guard rejection to user
        history.push({
          role: "user",
          content:
            loopBreaks === 1
              ? `LOOP DETECTED: You repeated "${action.tool}" with the same parameters 3+ times. This action is now BLOCKED. Try a completely different approach — different tool, different command, or different parameters.`
              : `LOOP DETECTED AGAIN (${loopBreaks}/3). You are still stuck. If you cannot find an alternative approach, use final_answer NOW to explain what went wrong. One more loop will terminate the agent.`,
        });
        continue;
      }

      // 3. Execute Tool
      if (action.tool === "final_answer") {
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

        // Extract user's actual task from the augmented prompt (which includes terminal output, prior conversation, etc.)
        const rawPrompt = history[1]?.content || "";
        const taskLineMatch = rawPrompt.match(/\nTask:\s*(.+)\s*$/);
        const userTask = (taskLineMatch ? taskLineMatch[1] : rawPrompt)
          .toLowerCase()
          .trim();
        const isShortAck =
          userTask.length <= 12 &&
          /^(ok|okay|yes|no|sure|thanks|thank you|got it|alright|go|do it|good|great|cool|nice|fine|yep|nope|done|next)$/i.test(
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
          /\b(i'll|i will|let me|i'm going to|i need to)\b.+\b(create|build|implement|check|modify|fix|write|set up|configure|update|install|make|add|start)\b/.test(
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

        // Check for "Lazy Completion": User asked for action, but agent did almost nothing.
        const actionKeywords = [
          "start ",
          "create ",
          "install ",
          "configure ",
          "make ",
          "build ",
          "setup ",
          "find ",
          "locate ",
          "check ",
          "search ",
          "verify ",
          "test ",
          "show ",
          "list ",
          "get ",
          "run ",
          "open ",
          "set up ",
          "update ",
          "fix ",
          "debug ",
          "deploy ",
          "delete ",
          "remove ",
        ];
        const isQuestionPattern = /^(how\s+to|how\s+do\s+i|what\s+is|explain|can\s+you\s+explain|tell\s+me)\b/i.test(userTask);
        const hasActionRequest =
          !isShortAck &&
          !isQuestionPattern &&
          actionKeywords.some((kw) => userTask.toLowerCase().includes(kw));

        // If we executed no commands and wrote no files, almost certainly incomplete.
        if (
          hasActionRequest &&
          executedCommands.size === 0 &&
          !wroteFiles &&
          !terminalBusy
        ) {
          // Silent retry — don't show guard rejection to user
          history.push({
            role: "user",
            content: `REJECTED: The user asked you to "${userTask.slice(0, 60)}" but you have executed 0 commands and written 0 files. Reading files is NOT completing the task. You MUST take action — use execute_command, run_in_terminal, or write_file to actually DO the work.`,
          });
          continue;
        }
        return { success: true, message: action.content, type: "success", payload: action };
      }

      if (action.tool === "ask_question") {
        // Allow questions about credentials, secrets, preferences — things the agent can't check
        const q = (action.question || "").toLowerCase();
        const isCredentialQuestion =
          /\b(password|username|account|credential|api.?key|token|login|auth|secret|license|email|ssh)\b/.test(
            q,
          );
        const isPreferenceQuestion =
          /\b(prefer|want|choose|which|style|color|name|title)\b/.test(q);

        // Reject questions about system state that the agent can check itself
        if (!isCredentialQuestion && !isPreferenceQuestion) {
          const statePatterns = [
            /\b(is|are)\b.+\brunning\b/,
            /\b(is|are)\b.+\binstalled\b/,
            /\b(is|are)\b.+\blistening\b/,
            /\bwhat port\b/,
            /\bwhich port\b/,
            /\bwhat version\b/,
            /\bdo you have\b/,
            /\bis .+ (running|started|available|active|open|up)\b/,
          ];
          if (statePatterns.some((p) => p.test(q))) {
            history.push({
              role: "user",
              content: `Do NOT ask the user about system state. You can check it yourself with commands. Use execute_command to verify: processes ("ps aux | grep <name>"), ports ("lsof -i :<port>"), installed tools ("which <cmd>"), HTTP services ("curl -sS http://localhost:<port>/"). Try common defaults first and adapt based on results.`,
            });
            continue;
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
            lastWriteDir,
            terminalBusy,
          },
        };
      }

      if (action.tool === "run_in_terminal") {
        try {
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
              } else if (consecutiveBusy >= 5) {
                // Stuck for too long — stop polling and tell agent to change approach
                onUpdate(
                  "executed",
                  `(Terminal busy for ${consecutiveBusy} checks — skipping command)`,
                  action
                );
                history.push({
                  role: "user",
                  content: `(Terminal has been busy for ${consecutiveBusy} consecutive checks. The process may be stalled or waiting for input not detected as a prompt. You MUST either:\n1. Use send_text("\\x03") to Ctrl+C the process\n2. Use send_text to provide input\n3. Use final_answer to report the current state\nDo NOT attempt more run_in_terminal or execute_command calls.)`,
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
                  content: `(Command NOT executed because terminal is busy running a process. Here is the current output instead:)\n${output}\n\n(Use send_text to interact or Ctrl+C to stop it.)`,
                });
                continue;
              }
            } else if (state === "server") {
              // Dev server / listener running — don't silently kill it
              consecutiveBusy++;
              if (consecutiveBusy >= 3 || (usedScaffold && wroteFiles)) {
                // Task is likely done — dev server is running with code written
                onUpdate(
                  "warning",
                  "Dev server is already running — task may be complete",
                  action
                );
                history.push({
                  role: "user",
                  content: `STOP: The dev server is running and you have ${wroteFiles ? "already written code" : "not written code yet"}. You have tried to run commands ${consecutiveBusy} times while the server is active.\n${wroteFiles ? "The task appears COMPLETE. Use final_answer NOW to confirm the project is running." : "Do NOT stop the server. Use write_file NOW to implement the user's requested features — the dev server will hot-reload your code automatically."}\nDo NOT attempt more run_in_terminal or execute_command calls — only write_file and final_answer.`,
                });
                consecutiveGuardBlocks++;
                continue;
              }
              onUpdate("warning", "Terminal busy: Dev server running", action);
              history.push({
                role: "user",
                content: `(Command NOT executed — dev server is running.${usedScaffold ? " You can still use write_file to add/edit code — the dev server will hot-reload automatically." : ""} If you need to run a different terminal command, use send_text("\\x03") to stop the server first. Use final_answer when the task is complete.)`,
              });
              consecutiveGuardBlocks++;
              continue;
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

          // Prevent duplicate run_in_terminal commands (e.g. re-scaffolding)
          let runCmd = action.command;
          if (
            executedCommands.has(runCmd) ||
            isDuplicateScaffold(runCmd, executedCommands)
          ) {
            onUpdate(
              "failed",
              `Blocked: duplicate command "${runCmd.slice(0, 80)}"`,
              action
            );
            history.push({
              role: "user",
              content: `Error: You already ran a similar command ("${runCmd}"). If the project directory doesn't exist at the expected location, create it manually with mkdir via execute_command, then use write_file to create files. Do NOT re-scaffold.`,
            });
            consecutiveGuardBlocks++;
            continue;
          }
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
            content: `(Command started in terminal. Initial output:\n${snapshot || "(no output yet)"}\n\nYou MUST use read_terminal to monitor progress. Do NOT run another command until this one finishes or you explicitly stop it with send_text("\\x03").)`,
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
              content: `Command Failed: ${err.message}`,
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
          const output = await readTerminal(lines);

          // Check if user clicked "Continue" — inject signal into history
          if ((globalThis as any).__tronAgentContinue) {
            (globalThis as any).__tronAgentContinue = false;
            identicalReadCount = 0;
            lastReadTerminalOutput = "";
            onUpdate("executed", `User confirmed ready — continuing`, action);
            history.push({
              role: "user",
              content: `${output}\n\n✅ The user has confirmed they completed the required action (e.g. finished browser login, entered input). The terminal output above shows the current state. Proceed with the task.`,
            });
            continue;
          }

          // Track consecutive identical outputs for smart backoff
          const outputTrimmed = (output || "").trim();
          if (
            outputTrimmed === lastReadTerminalOutput &&
            outputTrimmed.length > 0
          ) {
            identicalReadCount++;
          } else {
            lastReadTerminalOutput = outputTrimmed;
            identicalReadCount = 0;
          }

          // Smart backoff: exponential delay 500ms → 1s → 2s → 3s (capped at 4s)
          if (readTerminalCount > 0) {
            const backoffMs = Math.min(500 * Math.pow(1.5, readTerminalCount - 1), 4000);
            await new Promise((r) => setTimeout(r, backoffMs));
          }
          readTerminalCount++;

          // Show a useful preview — use "read_terminal" step so UI merges consecutive reads
          const previewLines = output
            ? output
              .split("\n")
              .filter((l) => l.trim())
              .slice(-3)
            : [];
          const firstLine = previewLines[0]?.slice(0, 100) || "(No output)";
          const fullPreview =
            previewLines.join("\n").slice(0, 300) || "(No output)";
          const suffix =
            readTerminalCount > 1
              ? ` (${readTerminalCount}x)`
              : "";
          onUpdate(
            "read_terminal",
            `Checking terminal${suffix}: ${firstLine}\n---\n${fullPreview}`,
            action
          );

          // Detect if terminal is waiting for user input
          const termState = classifyTerminalOutput(output || "");
          if (termState === "input_needed") {
            // After 3+ identical reads with input_needed, force agent to use ask_question
            if (identicalReadCount >= 3) {
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
            // Running server/daemon with stable output — task is likely done
            history.push({
              role: "user",
              content: `${output}\n\n✅ A server/daemon process is running successfully. The process has started and is serving. You MUST use final_answer NOW to report the result to the user. Do NOT write more files, do NOT call read_terminal again — the server is running and the task is COMPLETE.`,
            });
          } else if (identicalReadCount >= 3) {
            // Terminal busy with unchanged output — likely a running process
            history.push({
              role: "user",
              content: `${output}\n\n⚠️ Terminal output has been identical for ${identicalReadCount} consecutive reads. The process is running with stable output — the task is likely complete. You MUST use final_answer to report the current state to the user. Do NOT keep calling read_terminal with unchanged output.`,
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
            content: `Read Failed: ${err.message} `,
          });
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
            content: `Write File Failed: ${err.message}`,
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
            content: `Edit File Failed: ${err.message}`,
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
              { dirPath },
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
            content: `list_dir was unable to read that directory (${err.message}). This is non-critical — proceed with your task using other tools.`,
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
              { dirPath, query },
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
            content: `search_dir was unable to search that directory (${err.message}). This is non-critical — proceed with your task using other tools.`,
          });
        }
        continue;
      }

      if (action.tool === "execute_command") {
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
            // Process still running — wait with exponential backoff before re-checking
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
            } else if (consecutiveBusy >= 5) {
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
                content: `(Command NOT executed because terminal is busy running a process. Here is the current output instead:)\n${output}\n\n(Use send_text to interact or Ctrl+C to stop it.)`,
              });
              continue;
            }
          } else if (state === "server") {
            // Dev server is running — warn agent, cap consecutive attempts
            consecutiveBusy++;
            if (consecutiveBusy >= 3 || (usedScaffold && wroteFiles)) {
              onUpdate(
                "warning",
                "Dev server is already running — task may be complete",
                action
              );
              history.push({
                role: "user",
                content: `STOP: The dev server is running and you have ${wroteFiles ? "already written code" : "not written code yet"}. You have tried to run commands ${consecutiveBusy} times while the server is active.\n${wroteFiles ? "The task appears COMPLETE. Use final_answer NOW." : "Do NOT stop the server. Use write_file NOW to implement the user's requested features — the dev server will hot-reload your code automatically."}\nDo NOT attempt more run_in_terminal or execute_command calls — only write_file and final_answer.`,
              });
              consecutiveGuardBlocks++;
              continue;
            }
            onUpdate("warning", "Terminal busy: Dev server running", action);
            history.push({
              role: "user",
              content: `Terminal is busy running a server. You cannot run execute_command while the server is active.${usedScaffold ? "\nYou CAN still use write_file to add/edit code — the dev server will hot-reload your changes automatically." : ""}\nIf the task is complete, use "final_answer".\nIf you need to run a different terminal command, use send_text("\\x03") to stop the server first.`,
            });
            consecutiveGuardBlocks++;
            continue;
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

        // Only block duplicate scaffold commands in execute_command — read-only commands (ls, cat, find) are safe to re-run
        if (isDuplicateScaffold(cmd, executedCommands)) {
          onUpdate(
            "failed",
            `Blocked: duplicate scaffold command "${cmd.slice(0, 80)}"`,
            action
          );
          history.push({
            role: "user",
            content: `Error: You already ran a similar scaffold command. The project may already exist. Check with ls or use write_file to create files manually if the scaffold put files in an unexpected location.`,
          });
          consecutiveGuardBlocks++;
          continue;
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
          history.push({
            role: "user",
            content: `Command Output: \n${output} `,
          });
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
              content: `Command Failed: \n${err.message}`,
            });
          }
        }
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
