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
    defaultModels: [
      "gpt-5.2",
      "gpt-5.2-codex",
      "o3",
      "o4-mini",
      "gpt-4.1",
      "gpt-4o",
    ],
    placeholder: "gpt-5.2",
    label: "OpenAI",
  },
  anthropic: {
    chatUrl: "https://api.anthropic.com/v1/messages",
    defaultModels: [
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-haiku-4-5-20251001",
    ],
    placeholder: "claude-sonnet-4-6",
    label: "Anthropic",
  },
  gemini: {
    chatUrl:
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    defaultModels: [
      "gemini-3-pro-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-pro",
      "gemini-2.5-flash",
    ],
    placeholder: "gemini-2.5-flash",
    label: "Gemini (Google)",
  },
  deepseek: {
    chatUrl: "https://api.deepseek.com/chat/completions",
    defaultModels: ["deepseek-chat", "deepseek-reasoner"],
    placeholder: "deepseek-chat",
    label: "DeepSeek",
  },
  kimi: {
    chatUrl: "https://api.moonshot.ai/v1/chat/completions",
    defaultModels: ["kimi-k2.5", "kimi-k2", "moonshot-v1-128k"],
    placeholder: "kimi-k2.5",
    label: "Kimi (Moonshot)",
  },
  qwen: {
    chatUrl:
      "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    defaultModels: ["qwen3.5-plus", "qwen3-max", "qwen-plus-latest"],
    placeholder: "qwen3.5-plus",
    label: "Qwen (Alibaba)",
  },
  glm: {
    chatUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    defaultModels: ["glm-5", "glm-4.5", "glm-4-plus"],
    placeholder: "glm-5",
    label: "GLM (Zhipu)",
  },
  minimax: {
    chatUrl: "https://api.minimax.io/v1/text/chatcompletion_v2",
    defaultModels: ["MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-M2", "M2-her"],
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
      } catch {}

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
    localStorage.setItem(STORAGE_KEYS.AI_CONFIG, JSON.stringify(this.config));
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
        const response = await fetch(`${url}/api/v1/models`, { headers });
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
        const response = await fetch(`${url}/api/show`, {
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

    // Other providers don't support capability introspection
    return [];
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
        const response = await fetch(`${url}/api/tags`, { headers });
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
        const response = await fetch(`${url}/api/v1/models`, {
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
        const response = await fetch(`${url}/v1/models`, { headers });
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
        const response = await fetch(`${url}/v1/models`, { headers });
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
  async getAllConfiguredModels(): Promise<AIModel[]> {
    let providerConfigs: Record<
      string,
      { model?: string; apiKey?: string; baseUrl?: string }
    > = {};
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.PROVIDER_CONFIGS);
      if (raw) providerConfigs = JSON.parse(raw);
    } catch {}

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
          } catch {}
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
        const response = await fetch(
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
        const response = await fetch(getAnthropicChatUrl(provider, baseUrl), {
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
    const response = await fetch(`${baseUrl}/api/generate`, {
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
    let response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });

    // Retry without format/think if model still returns 400
    if (response.status === 400 && (body.format || body.think)) {
      const retryBody: any = { model, messages, stream: true };
      response = await fetch(`${baseUrl}/api/chat`, {
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

  /** Non-streaming OpenAI-compatible chat completion. */
  private async openAIChatSimple(
    provider: string,
    model: string,
    apiKey: string,
    messages: any[],
    maxTokens?: number,
    baseUrl?: string,
  ): Promise<string> {
    const url = this.getOpenAIChatUrl(provider, baseUrl);
    const body: any = { model, messages, stream: false };
    if (maxTokens) body.max_tokens = maxTokens;

    const response = await fetch(url, {
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
    return data.choices?.[0]?.message?.content?.trim() || "";
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
    const url = this.getOpenAIChatUrl(provider, baseUrl);
    const body: any = { model, messages, stream: true };
    // Only send response_format for cloud providers that support json_object.
    // Local/compat providers (lmstudio, openai-compat, ollama) often reject it.
    if (responseFormat === "json" && !providerUsesBaseUrl(provider)) {
      body.response_format = { type: "json_object" };
    }

    const response = await fetch(url, {
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
      throw new Error(
        `Unexpected JSON response: ${JSON.stringify(errJson).slice(0, 200)}`,
      );
    }

    return this.parseOpenAIStream(response, onToken);
  }

  /** Parse an SSE stream from an OpenAI-compatible API. */
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") continue;

        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          // Handle reasoning_content (DeepSeek, GLM, Kimi K2)
          if (delta.reasoning_content) {
            thinkingText += delta.reasoning_content;
            if (onToken) onToken("", delta.reasoning_content);
          }
          if (delta.content) {
            fullText += delta.content;
            if (onToken) onToken(delta.content);
          }
        } catch {
          /* skip malformed SSE lines */
        }
      }
    }
    return { content: fullText, thinking: thinkingText };
  }

  async generateCommand(
    prompt: string,
    onToken?: (token: string) => void,
  ): Promise<string> {
    const { provider, model, apiKey, baseUrl } = this.config;

    const systemPrompt = `Terminal assistant. OS: ${navigator.platform}.
Reply ONLY in this format, nothing else:
COMMAND: <raw command, no backticks>
TEXT: <one short sentence>
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
        const response = await fetch(getAnthropicChatUrl(provider, baseUrl), {
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
        const response = await fetch(
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
        const response = await fetch(getAnthropicChatUrl(provider, baseUrl), {
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
          const response = await fetch(
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
        const response = await fetch(getAnthropicChatUrl(provider, baseUrl), {
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
      const response = await fetch(getAnthropicChatUrl(provider, baseUrl), {
        method: "POST",
        headers: this.anthropicHeaders(apiKey),
        body: JSON.stringify({
          model,
          max_tokens: 4096,
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
          } catch {}
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
    onUpdate: (step: string, output: string) => void,
    sessionConfig?: AIConfig,
    signal?: AbortSignal,
    thinkingEnabled: boolean = true,
    continuation?: AgentContinuation,
    images?: AttachedImage[],
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
          content: `Terminal agent. OS: ${navigator.platform}. Respond ONLY with valid JSON.

TOOLS:
1. {"tool":"execute_command","command":"..."} — Run a non-interactive command, get output. For: ls, mkdir, grep, git, npm install.
2. {"tool":"run_in_terminal","command":"..."} — Run interactive/long-running commands (npm create, dev servers). Monitor with read_terminal after.
3. {"tool":"read_terminal","lines":50} — Read last N lines of terminal output.
4. {"tool":"send_text","text":"...","description":"..."} — Send keystrokes. Include description. Keys: \\r=Enter, \\x1B[B=Down, \\x1B[A=Up, \\x03=Ctrl+C.
5. {"tool":"ask_question","question":"..."} — Ask user for clarification.
6. {"tool":"final_answer","content":"..."} — Task complete. 1-3 lines.
7. {"tool":"write_file","path":"/absolute/path","content":"..."} — Write/overwrite a file directly. Use INSTEAD of cat/heredoc for creating or editing files. Much more reliable than heredoc.
8. {"tool":"read_file","path":"/absolute/path"} — Read a file's content directly. Use INSTEAD of cat through execute_command for reading files.
9. {"tool":"edit_file","path":"/absolute/path","search":"...","replace":"..."} — exact string search-and-replace. efficient for changing specific config lines or code blocks.

RULES:
1. Execute commands directly. Do not explain what you would do.
2. On failure, read error, fix root cause.
3. If user denies permission, STOP.
4. FILE OPERATIONS: Use read_file to read, write_file to create/overwrite, and edit_file to modify. Do NOT use cat, heredoc, or printf through the terminal.
5. After interactive command: read_terminal → if menu, send_text → read_terminal again. Loop until done.
6. START DEV SERVER ONLY AS THE VERY LAST STEP. Do not start it until all files are written, dependencies installed, and configuration is complete. Once started, the terminal is blocked.
7. SCAFFOLDING: If the target directory might exist, run "rm -rf <dir>" FIRST. Do NOT run "mkdir" before scaffolding tools (npm create, git clone) — let them create the directory. This avoids "Directory not empty" prompts. Use non-interactive flags (e.g. --yes) where possible.
8. AUTONOMY & STATE: Do NOT ask the user questions about system state (e.g. "Is the server running?", "Is the file created?", "What is on port X?"). CHECK IT YOURSELF using commands like "ps aux | grep <name>", "curl -I localhost:<port>", "lsof -i :<port>", or "ls -F". Only ask if you cannot determine the state programmatically after trying.
9. PROBLEM SOLVING: If a command fails or results are unexpected, do NOT just give up or retry blindly. ANALYZE the error message to find the root cause (missing file, permission denied, wrong path, dependency needed). PROACTIVELY FIX the issue (create the missing file, chmod, npm install, correct the path) and then retry. You have permission to fix environment issues to achieve the goal.
10. CONTEXT AWARENESS: The [PROJECT FILES] section shows existing files. Do NOT recreate files that already exist — use read_file or edit_file to modify them. Do NOT scaffold a new project if one already exists. Always check the project structure before creating files.
11. IMAGES: If the user mentions images or screenshots, they were already analyzed in a prior step. Use the description provided — do NOT try to access image files with read_file, execute_command, or ls.
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
          const response = await fetch(getAnthropicChatUrl(provider, baseUrl), {
            method: "POST",
            headers: this.anthropicHeaders(apiKey),
            body: JSON.stringify({
              model,
              max_tokens: 4096,
              system: history[0].content,
              messages: history.slice(1),
              stream: true,
            }),
            signal,
          });
          if (!response.ok)
            throw new Error(
              `${CLOUD_PROVIDERS[provider]?.label || provider} server error(${response.status})`,
            );
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
              } catch {}
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
        onUpdate("error", `${label} server error: ${e.message} `);
        return {
          success: false,
          message: `${label} server returned an error: ${e.message}. Check that the server is running and your configuration is correct.`,
        };
      }

      // 2. Parse Tool Call — try content first, then extract from thinking
      let action: any;
      // Convert \xHH escapes (invalid JSON) to \u00HH (valid JSON) inside strings
      const fixJsonEscapes = (raw: string): string =>
        raw.replace(/\\x([0-9a-fA-F]{2})/g, "\\u00$1");

      const tryParseJson = (text: string): any => {
        if (!text.trim()) return null;

        // 1. Try direct parse first (with \x escape fix)
        try {
          return JSON.parse(fixJsonEscapes(text));
        } catch {}

        // 2. Markdown code block extraction (handles ```json, ```JSON, ```, etc.)
        const mdMatch = text.match(/```\w*\s*([\s\S]*?)```/);
        if (mdMatch) {
          try {
            return JSON.parse(fixJsonEscapes(mdMatch[1].trim()));
          } catch {}
        }

        // 3. Robust extraction: find first '{' and count braces
        const firstOpen = text.indexOf("{");
        if (firstOpen === -1) return null;

        let balance = 0;
        let inString = false;
        let escape = false;

        for (let i = firstOpen; i < text.length; i++) {
          const char = text[i];

          if (escape) {
            escape = false;
            continue;
          }

          if (char === "\\") {
            escape = true;
            continue;
          }

          if (char === '"') {
            inString = !inString;
            continue;
          }

          if (!inString) {
            if (char === "{") {
              balance++;
            } else if (char === "}") {
              balance--;
              if (balance === 0) {
                const candidate = fixJsonEscapes(text.slice(firstOpen, i + 1));
                try {
                  const obj = JSON.parse(candidate);
                  if (obj.tool || obj.content) return obj;
                } catch {
                  // Try fixing trailing commas: ,} → }
                  const fixed = candidate
                    .replace(/,\s*}/g, "}")
                    .replace(/,\s*]/g, "]");
                  try {
                    const obj = JSON.parse(fixed);
                    if (obj.tool || obj.content) return obj;
                  } catch {}
                }
                break;
              }
            }
          }
        }

        return null;
      };

      action = tryParseJson(responseText);
      // Fallback: model may put JSON in thinking instead of content
      if (!action?.tool && thinkingText) {
        action = tryParseJson(thinkingText);
      }
      // Coerce {"content":"..."} without "tool" into final_answer so rejection filters can process it
      if (action && !action.tool && typeof action.content === "string") {
        action.tool = "final_answer";
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

        // Log parse failures so they appear in the session log
        const preview = (responseText || "").slice(0, 120).replace(/\n/g, " ");
        onUpdate(
          "failed",
          `Parse error (${parseFailures}/3): ${preview || "(empty response)"}...`,
        );
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

      // Consecutive loop: same action 2 times in a row (catch on 2nd attempt)
      const isConsecutiveLoop =
        actionKey != null &&
        recentActions.length >= 2 &&
        recentActions[recentActions.length - 1] === actionKey &&
        recentActions[recentActions.length - 2] === actionKey;

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

        onUpdate("failed", `Loop detected (${loopBreaks}/3): ${action.tool}`);
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
            onUpdate("failed", "Premature completion: Dev server not running");
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
        if (
          !isShortAck &&
          (isAskingToContinue ||
            isFuturePlan ||
            (hasUnfinishedSteps && !loopBreaks))
        ) {
          onUpdate(
            "failed",
            "Rejected: final_answer describes unfinished work",
          );
          history.push({
            role: "user",
            content: `REJECTED: Your final_answer describes unfinished work. You are an ACTION agent — do NOT ask permission to continue. Just DO the remaining steps yourself (fix errors, install dependencies, write code, etc.) and THEN give final_answer when everything is actually done and working.`,
          });
          continue;
        }
        // Reject if answer mentions unfixed errors (unless agent is stuck from loops or user reported the error)
        if (mentionsError && !loopBreaks && !userMentionedError) {
          onUpdate("failed", "Rejected: final_answer mentions unfixed errors");
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
            onUpdate(
              "failed",
              `Rejected: delegation — agent should run "${cmdMatch[1].slice(0, 40)}" itself`,
            );
            history.push({
              role: "user",
              content: `REJECTED: Do NOT tell the user to run commands. You are an ACTION agent — execute "${cmdMatch[1]}" yourself using run_in_terminal or execute_command. Then give final_answer when done.`,
            });
            continue;
          }
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
        ];
        const hasActionRequest =
          !isShortAck && actionKeywords.some((kw) => userTask.includes(kw));

        // If we executed no commands and wrote no files, almost certainly incomplete.
        if (
          hasActionRequest &&
          executedCommands.size === 0 &&
          !wroteFiles &&
          !terminalBusy
        ) {
          onUpdate(
            "failed",
            "Rejected: lazy completion — no commands executed, no files written",
          );
          history.push({
            role: "user",
            content: `REJECTED: The user asked you to "${userTask.slice(0, 60)}" but you have executed 0 commands and written 0 files. Reading files is NOT completing the task. You MUST take action — use execute_command, run_in_terminal, or write_file to actually DO the work.`,
          });
          continue;
        }
        return { success: true, message: action.content, type: "success" };
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
          message: action.question,
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
              onUpdate("executed", `Terminal waiting for input`);
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
                );
                history.push({
                  role: "user",
                  content: `STOP: The dev server is running and you have ${wroteFiles ? "already written code" : "not written code yet"}. You have tried to run commands ${consecutiveBusy} times while the server is active.\n${wroteFiles ? "The task appears COMPLETE. Use final_answer NOW to confirm the project is running." : "Do NOT stop the server. Use write_file NOW to implement the user's requested features — the dev server will hot-reload your code automatically."}\nDo NOT attempt more run_in_terminal or execute_command calls — only write_file and final_answer.`,
                });
                consecutiveGuardBlocks++;
                continue;
              }
              onUpdate("warning", "Terminal busy: Dev server running");
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
            onUpdate("failed", "Blocked: dev server before code written");
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
          );
          history.push({
            role: "user",
            content: `(Command started in terminal. You MUST use read_terminal to monitor progress. Do NOT run another command until this one finishes or you explicitly stop it with send_text("\\x03").)`,
          });
        } catch (err: any) {
          terminalBusy = false; // Reset — command never actually ran
          const isDeny = err.message === "User denied command execution.";
          onUpdate("failed", action.command + "\n---\n" + err.message);
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
          // Process escape sequences in the text before sending
          let processedText = action.text;
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
          onUpdate("executed", desc + "\n---\n" + (snapshot || "(no output)"));
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
          onUpdate("failed", "Send text failed: " + err.message);
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
            onUpdate("executed", `User confirmed ready — continuing`);
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

          // Smart backoff: if terminal output hasn't changed, wait longer each time
          if (identicalReadCount >= 2) {
            const backoffMs = Math.min(1000 * identicalReadCount, 10000);
            await new Promise((r) => setTimeout(r, backoffMs));
          }

          // Show a useful preview of what was read — first line as collapsed summary
          // Suppress duplicate UI entries: only show update on first or every 5th identical read
          const previewLines = output
            ? output
                .split("\n")
                .filter((l) => l.trim())
                .slice(-3)
            : [];
          const firstLine = previewLines[0]?.slice(0, 100) || "(No output)";
          const fullPreview =
            previewLines.join("\n").slice(0, 300) || "(No output)";
          if (identicalReadCount <= 1 || identicalReadCount % 5 === 0) {
            const suffix =
              identicalReadCount > 1
                ? ` (${identicalReadCount}x unchanged)`
                : "";
            onUpdate(
              "executed",
              `Checked terminal${suffix}: ${firstLine}\n---\n${fullPreview}`,
            );
          }

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
          } else if (termState === "server" && identicalReadCount >= 2) {
            // Running server/daemon with stable output — task is likely done
            history.push({
              role: "user",
              content: `${output}\n\n✅ A server/daemon process is running with stable output (${identicalReadCount} identical reads). The process has started successfully. You MUST use final_answer NOW to report the result to the user. Do NOT call read_terminal again — the process will keep running in the background.`,
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
          onUpdate("failed", "Read terminal failed: " + err.message);
          history.push({
            role: "user",
            content: `Read Failed: ${err.message} `,
          });
        }
        continue;
      }

      // Reset identical-read counter when agent takes any other action
      identicalReadCount = 0;
      lastReadTerminalOutput = "";

      if (action.tool === "write_file") {
        const filePath = action.path;
        const content = action.content;
        // Silently retry if AI sent malformed write_file (missing path/content) — don't show error to user
        if (!filePath || typeof content !== "string") {
          history.push({
            role: "user",
            content: `Error: write_file requires "path" (string) and "content" (string). You sent: path=${JSON.stringify(filePath)}, content type=${typeof content}. Fix and retry.`,
          });
          continue;
        }
        try {
          onUpdate("executing", `Writing file: ${filePath}`);
          const result = await (window as any).electron.ipcRenderer.invoke(
            "file.writeFile",
            {
              filePath,
              content,
            },
          );
          if (result.success) {
            const MAX_PREVIEW = 5000;
            const preview =
              content.length > MAX_PREVIEW
                ? content.slice(0, MAX_PREVIEW) +
                  `\n... (${content.length - MAX_PREVIEW} more characters)`
                : content;
            onUpdate("executed", `Wrote file: ${filePath}\n---\n${preview}`);
            wroteFiles = true;
            consecutiveGuardBlocks = 0;
            // Track project root — use the shallowest (shortest) directory written to
            const dir = filePath.substring(0, filePath.lastIndexOf("/"));
            if (dir && (!lastWriteDir || dir.length < lastWriteDir.length)) {
              lastWriteDir = dir;
            }
            history.push({
              role: "user",
              content: `(File written successfully: ${filePath})`,
            });
          } else {
            throw new Error(result.error || "Unknown write error");
          }
        } catch (err: any) {
          onUpdate("failed", "Write file failed: " + err.message);
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
          onUpdate("executing", `Reading file: ${filePath}`);
          const result = await (window as any).electron.ipcRenderer.invoke(
            "file.readFile",
            {
              filePath,
            },
          );
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
          onUpdate("failed", "Read file failed: " + errMsg);
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
          onUpdate("executing", `Editing file: ${filePath}`);
          const result = await (window as any).electron.ipcRenderer.invoke(
            "file.editFile",
            {
              filePath,
              search,
              replace,
            },
          );
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
            );
            history.push({
              role: "user",
              content: `(File edited successfully: ${filePath}. Made ${result.replacements} replacements.)`,
            });
          } else {
            throw new Error(result.error || "Unknown edit error");
          }
        } catch (err: any) {
          onUpdate("failed", "Edit file failed: " + err.message);
          history.push({
            role: "user",
            content: `Edit File Failed: ${err.message}`,
          });
        }
        continue;
      }

      if (action.tool === "execute_command") {
        // Interactive commands MUST use run_in_terminal — sentinel exec can't handle TUI prompts
        const INTERACTIVE_CMD_RE =
          /\b(npm\s+create|npx\s+create|npm\s+init|yarn\s+create|pnpm\s+create|bun\s+create|npx\s+degit|npx\s+giget)\b/i;
        if (INTERACTIVE_CMD_RE.test(action.command)) {
          if (usedScaffold) {
            // Project already scaffolded — redirect to write_file, NOT run_in_terminal (which would also block)
            onUpdate(
              "failed",
              `Blocked: project already scaffolded — use write_file to implement features`,
            );
            history.push({
              role: "user",
              content: `Error: A scaffold command was already run. Do NOT re-run scaffold commands (npm create, npx create, etc.). If the project directory doesn't exist at the expected location (scaffold may have placed it elsewhere), create it manually with mkdir via execute_command, then use write_file to create files.${terminalBusy ? " The dev server is running and will hot-reload your changes automatically." : ""}`,
            });
          } else {
            onUpdate(
              "failed",
              `Blocked: interactive command "${action.command.slice(0, 60)}" — use run_in_terminal`,
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
            onUpdate("executed", `Terminal waiting for input`);
            history.push({
              role: "user",
              content: `(Command NOT executed — terminal is waiting for user input.)\n${output}\n\nUse ask_question to ask the user what to enter, then send_text to type it. The user may also type directly in the terminal — read_terminal again after to check.`,
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
              );
              history.push({
                role: "user",
                content: `STOP: The dev server is running and you have ${wroteFiles ? "already written code" : "not written code yet"}. You have tried to run commands ${consecutiveBusy} times while the server is active.\n${wroteFiles ? "The task appears COMPLETE. Use final_answer NOW." : "Do NOT stop the server. Use write_file NOW to implement the user's requested features — the dev server will hot-reload your code automatically."}\nDo NOT attempt more run_in_terminal or execute_command calls — only write_file and final_answer.`,
              });
              consecutiveGuardBlocks++;
              continue;
            }
            onUpdate("warning", "Terminal busy: Dev server running");
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

        // Only block duplicate scaffold commands in execute_command — read-only commands (ls, cat, find) are safe to re-run
        if (isDuplicateScaffold(cmd, executedCommands)) {
          onUpdate(
            "failed",
            `Blocked: duplicate scaffold command "${cmd.slice(0, 80)}"`,
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
          /^\s*(mkdir)\b/.test(cmd.replace(/^cd\s+[^\s&;|]+\s*&&\s*/, ""))
        ) {
          onUpdate(
            "failed",
            `Blocked: "${cmd.slice(0, 60)}" — use write_file instead`,
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

        onUpdate("executing", cmd);
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
          onUpdate("executed", cmd + "\n---\n" + output);
          history.push({
            role: "user",
            content: `Command Output: \n${output} `,
          });
        } catch (err: any) {
          const isDeny = err.message === "User denied command execution.";
          onUpdate("failed", cmd + "\n---\n" + err.message);
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
