import type {
  AIConfig,
  AIModel,
  AIProvider,
  AgentResult as BaseAgentResult,
} from "../../types";
import { STORAGE_KEYS } from "../../constants/storage";
import agentPrompt from "./agent.md?raw";

// Extend AgentResult locally if not updating types.d.ts yet, or assume it's there
interface AgentResult extends BaseAgentResult {
  type?: "success" | "failure" | "question";
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
    defaultModels: ["gpt-5.2", "gpt-5.2-codex", "o3", "o4-mini", "gpt-4.1", "gpt-4o"],
    placeholder: "gpt-5.2",
    label: "OpenAI",
  },
  anthropic: {
    chatUrl: "https://api.anthropic.com/v1/messages",
    defaultModels: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
    placeholder: "claude-sonnet-4-6",
    label: "Anthropic",
  },
  gemini: {
    chatUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    defaultModels: ["gemini-3-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash"],
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
    chatUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
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
};

/** Get the provider info, or undefined if not a known cloud provider. */
export function getCloudProvider(provider: string): ProviderInfo | undefined {
  return CLOUD_PROVIDERS[provider];
}

/** Get all cloud provider entries for settings UI. */
export function getCloudProviderList(): { id: string; info: ProviderInfo }[] {
  return Object.entries(CLOUD_PROVIDERS).map(([id, info]) => ({ id, info }));
}

function isOpenAICompatible(provider: string): boolean {
  return provider !== "ollama" && provider !== "anthropic" && provider in CLOUD_PROVIDERS;
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
    // Cloud providers must never use a baseUrl (Ollama's localhost leaks via
    // JSON.stringify stripping undefined values — on reload the default
    // "http://localhost:11434" survives the merge).
    if (this.config.provider !== "ollama") {
      this.config.baseUrl = undefined;
    }
  }

  saveConfig(config: Partial<AIConfig>) {
    this.config = { ...this.config, ...config };
    localStorage.setItem(STORAGE_KEYS.AI_CONFIG, JSON.stringify(this.config));
  }

  getConfig() {
    return this.config;
  }

  async getModelCapabilities(
    modelName: string,
    baseUrl?: string,
  ): Promise<string[]> {
    const url = baseUrl || this.config.baseUrl || "http://localhost:11434";
    try {
      const response = await fetch(`${url}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

  async getModels(baseUrl?: string): Promise<AIModel[]> {
    const models: AIModel[] = [];

    // 1. Ollama — only if reachable
    try {
      const url = baseUrl || this.config.baseUrl || "http://localhost:11434";
      const response = await fetch(`${url}/api/tags`);
      if (response.ok) {
        const data = await response.json();
        const ollamaModels: AIModel[] = (data.models || []).map((m: any) => ({
          name: m.name,
          provider: "ollama" as const,
        }));

        models.push(...ollamaModels);
      }
    } catch (e) {
      console.warn("Failed to fetch Ollama models", e);
    }

    // 2. Cloud models — show defaults for current provider if API key is set
    const provider = this.config.provider;
    if (this.config.apiKey && provider !== "ollama") {
      const info = CLOUD_PROVIDERS[provider];
      if (info) {
        for (const name of info.defaultModels) {
          models.push({ name, provider: provider as AIProvider });
        }
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
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, prompt, stream: false }),
          },
        );
        if (!response.ok) throw new Error(`Ollama: ${response.status}`);
        const data = await response.json();
        return data.response?.trim() || history;
      }

      if (provider === "anthropic" && apiKey) {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 500,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const data = await response.json();
        return data.content?.[0]?.text?.trim() || history;
      }

      // OpenAI-compatible providers (openai, deepseek, kimi, gemini, glm)
      if (apiKey && isOpenAICompatible(provider)) {
        const result = await this.openAIChatSimple(
          provider, model, apiKey,
          [{ role: "user", content: prompt }],
          500, baseUrl,
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
  ): Promise<string> {
    const response = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  ): Promise<{ content: string; thinking: string }> {
    // Many models reject think + format:"json" together — never send both
    const body: any = { model, messages, stream: true };
    if (format) {
      body.format = format;
      // Don't enable think when requesting structured output
    } else if (think) {
      body.think = true;
    }

    let response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    // Retry without format/think if model still returns 400
    if (response.status === 400 && (body.format || body.think)) {
      const retryBody: any = { model, messages, stream: true };
      response = await fetch(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      // User override — append /chat/completions if not already there
      const url = baseUrl.replace(/\/+$/, "");
      return url.endsWith("/chat/completions") ? url : `${url}/chat/completions`;
    }
    return CLOUD_PROVIDERS[provider]?.chatUrl || `${baseUrl}/v1/chat/completions`;
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
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`${provider} API error ${response.status}: ${errText.slice(0, 200)}`);
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
    if (responseFormat === "json") {
      body.response_format = { type: "json_object" };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    // Retry without response_format if 400 (some models don't support it)
    if (response.status === 400 && body.response_format) {
      delete body.response_format;
      const retry = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (!retry.ok) throw new Error(`${provider} API error: ${retry.status}`);
      return this.parseOpenAIStream(retry, onToken);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`${provider} API error ${response.status}: ${errText.slice(0, 200)}`);
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

    const systemPrompt = `You are a terminal assistant. The user wants to perform a task. Output ONLY the exact command to run. No markdown, no explanation. If the task is simple, output a single command. If it requires multiple steps, output only the FIRST step. User OS: ${navigator.platform}.`;

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

      if (provider === "anthropic") {
        if (!apiKey) throw new Error("Anthropic API Key required");
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: model,
            max_tokens: 100,
            system: systemPrompt,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const data = await response.json();
        return data.content[0].text.trim();
      }

      // OpenAI-compatible providers (openai, deepseek, kimi, gemini, glm)
      if (isOpenAICompatible(provider)) {
        if (!apiKey) throw new Error(`${CLOUD_PROVIDERS[provider]?.label || provider} API Key required`);
        return await this.openAIChatSimple(
          provider, model, apiKey,
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt },
          ],
          100, baseUrl,
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

  async generatePlaceholder(context: string): Promise<string> {
    const { provider, model, apiKey, baseUrl } = this.config;
    if (!model) return "";

    const systemPrompt = `You predict what the user will type next in a terminal. Based on the recent terminal output, suggest a short one-line command or action. Output ONLY the suggestion text, nothing else. Do not use backticks. Keep it under 60 characters. If unsure, output an empty string.`;

    try {
      if (provider === "ollama") {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        try {
          const response = await fetch(
            `${baseUrl || "http://localhost:11434"}/api/generate`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model,
                prompt: `${systemPrompt}\n\nRecent terminal output:\n${context.slice(-500)}\n\nSuggestion:`,
                stream: false,
              }),
              signal: controller.signal,
            },
          );
          clearTimeout(timeout);
          if (!response.ok) return "";
          const data = await response.json();
          const result = (data.response || "").trim().replace(/^`+|`+$/g, "");
          return result.length <= 80 ? result : "";
        } catch {
          clearTimeout(timeout);
          return "";
        }
      }

      if (provider === "anthropic" && apiKey) {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 30,
            system: systemPrompt,
            messages: [
              {
                role: "user",
                content: `Recent terminal output:\n${context.slice(-500)}`,
              },
            ],
          }),
        });
        const data = await response.json();
        const result = (data.content?.[0]?.text || "")
          .trim()
          .replace(/^`+|`+$/g, "");
        return result.length <= 80 ? result : "";
      }

      // OpenAI-compatible providers
      if (apiKey && isOpenAICompatible(provider)) {
        const result = await this.openAIChatSimple(
          provider, model, apiKey,
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Recent terminal output:\n${context.slice(-500)}` },
          ],
          30, baseUrl,
        );
        const clean = result.replace(/^`+|`+$/g, "");
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
    const baseUrl = provider === "ollama" ? cfg.baseUrl : undefined;
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
              headers: { "Content-Type": "application/json" },
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
          const result = (data.response || "").trim().replace(/^["'`]+|["'`]+$/g, "");
          return result.length > 0 && result.length <= 30 ? result : "";
        } catch {
          clearTimeout(timeout);
          return "";
        }
      }

      if (provider === "anthropic" && apiKey) {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 15,
            system: systemPrompt,
            messages: [{ role: "user", content: prompt.slice(0, 200) }],
          }),
        });
        const data = await response.json();
        const result = (data.content?.[0]?.text || "").trim().replace(/^["'`]+|["'`]+$/g, "");
        return result.length > 0 && result.length <= 30 ? result : "";
      }

      // OpenAI-compatible providers
      if (apiKey && isOpenAICompatible(provider)) {
        const result = await this.openAIChatSimple(
          provider, model, apiKey,
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: prompt.slice(0, 200) },
          ],
          15, baseUrl,
        );
        const clean = result.replace(/^["'`]+|["'`]+$/g, "");
        return clean.length > 0 && clean.length <= 30 ? clean : "";
      }
    } catch {
      // Non-critical
    }
    return "";
  }

  async runAgent(
    prompt: string,
    executeCommand: (cmd: string) => Promise<string>,
    writeToTerminal: (cmd: string) => void,
    onUpdate: (step: string, output: string) => void,
    sessionConfig?: AIConfig,
    signal?: AbortSignal,
    thinkingEnabled: boolean = true,
  ): Promise<AgentResult> {
    const cfg = sessionConfig || this.config;
    const provider = cfg.provider;
    const model = cfg.model;
    // Fall back to global apiKey if session config doesn't have one (e.g.
    // model selected via ContextBar before settings propagated).
    const apiKey = cfg.apiKey || this.config.apiKey;
    // Never send a baseUrl to cloud providers — prevents Ollama localhost leak.
    const baseUrl = provider === "ollama" ? cfg.baseUrl : undefined;

    const history: any[] = [
      {
        role: "system",
        content: `Terminal agent. OS: ${navigator.platform}. Respond ONLY with valid JSON.

TOOLS:
1. {"tool":"execute_command","command":"..."} — Run command, get output. Use for ALL file read/write/create operations.
2. {"tool":"run_in_terminal","command":"..."} — Fire-and-forget in user's terminal. ONLY for: cd, servers, interactive apps, open. NO file writing.
3. {"tool":"ask_question","question":"..."} — Ask user for clarification or confirmation.
4. {"tool":"final_answer","content":"..."} — Done or can't do it.

RULES:
1. SELF-SOLVE FIRST: Before asking the user anything, try to find the answer yourself using execute_command. Need system specs? Run "uname -a", "sysctl hw.memsize", "system_profiler SPHardwareDataType", etc. Need project info? Run "ls", "cat package.json", etc. Only use ask_question as a LAST RESORT when you truly cannot determine the answer by running commands.
2. VERIFY: After running a command, analyze the output. Did it succeed? If not, FIX IT.
3. RECOVER: If a command fails (e.g. missing dependency), try to install it or use an alternative.
4. COMPLETION: Do not say "Done" until you have VERIFIED the task is actually complete based on command output.
5. CONCISENESS: Keep final_answer short (under 3 lines) if possible. If long, summarize.
6. JSON: Output ONLY valid JSON.
`,
      },
    ];

    history.push({ role: "user", content: prompt });

    const maxSteps = sessionConfig?.maxAgentSteps || 100;
    const executedCommands = new Set<string>();
    let hasActed = false; // Track if agent has executed or sent any command

    history[0].content += `
For file operations always use execute_command with cat heredoc or printf. Use run_in_terminal only for cd/servers/interactive.

${agentPrompt}
`;

    let parseFailures = 0;
    for (let i = 0; i < maxSteps; i++) {
      if (signal?.aborted) {
        throw new Error("Agent aborted by user.");
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
          );
          responseText = result.content;
          thinkingText = result.thinking;
          if (thinkingAccumulated) {
            onUpdate("thinking_complete", thinkingAccumulated);
          } else {
            // For non-thinking models: ensure thinking state is cleared
            onUpdate("thinking_done", "");
          }
        } else if (provider === "anthropic" && apiKey) {
          // Anthropic Messages API with streaming
          let contentAccumulated = "";
          const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({
              model,
              max_tokens: 4096,
              system: history[0].content,
              messages: history.slice(1),
              stream: true,
            }),
            signal,
          });
          if (!response.ok) throw new Error(`Anthropic API error: ${response.status}`);
          if (!response.body) throw new Error("No response body");

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
        } else if (isOpenAICompatible(provider) && apiKey) {
          // OpenAI-compatible cloud providers with streaming
          let thinkingAccumulated = "";
          let contentAccumulated = "";
          const result = await this.streamOpenAIChat(
            provider, model, apiKey, history,
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
            signal, "json", baseUrl,
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
            `Provider "${provider}" requires an API key. Configure it in Settings.`,
          );
        }
      } catch (e: any) {
        if (signal?.aborted || e.name === "AbortError") {
          throw new Error("Agent aborted by user.");
        }
        onUpdate("error", `LLM Error: ${e.message}`);
        return {
          success: false,
          message: `Agent stopped due to LLM error: ${e.message}`,
        };
      }

      // 2. Parse Tool Call — try content first, then extract from thinking
      let action: any;
      const tryParseJson = (text: string): any => {
        if (!text.trim()) return null;

        // 1. Try direct parse first
        try {
          return JSON.parse(text);
        } catch {}

        // 2. Markdown code block extraction
        const mdMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (mdMatch) {
          try {
            return JSON.parse(mdMatch[1]);
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
                const candidate = text.slice(firstOpen, i + 1);
                try {
                  const obj = JSON.parse(candidate);
                  if (obj.tool) return obj;
                } catch {
                  // Try fixing trailing commas: ,} → }
                  const fixed = candidate.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]");
                  try {
                    const obj = JSON.parse(fixed);
                    if (obj.tool) return obj;
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

      if (!action || !action.tool) {
        parseFailures++;

        // After enough failures, treat raw text as a final answer rather than erroring
        if (parseFailures >= 3) {
          const fallbackText = (responseText || thinkingText || "").trim();
          if (fallbackText.length > 0) {
            return { success: true, message: fallbackText, type: "success" };
          }
          return {
            success: false,
            message: "Agent could not complete the task.",
          };
        }

        // Silent retry — no visible error step shown to user
        history.push({ role: "assistant", content: responseText || "(empty)" });
        history.push({
          role: "user",
          content:
            'Error: Invalid JSON format. You MUST respond with valid JSON containing a "tool" field. Example: {"tool": "final_answer", "content": "Done."}',
        });
        continue;
      }
      parseFailures = 0; // Reset on successful parse

      history.push({ role: "assistant", content: JSON.stringify(action) });

      // 3. Execute Tool
      if (action.tool === "final_answer") {
        // Guard: require at least one command execution before accepting final_answer
        if (!hasActed) {
          history.push({
            role: "user",
            content:
              'You have not executed any commands yet. Do NOT give a final_answer without first using execute_command or run_in_terminal to actually perform the task. Start by running a command.',
          });
          continue;
        }
        return { success: true, message: action.content, type: "success" };
      }

      if (action.tool === "ask_question") {
        return {
          success: true,
          message: action.question,
          type: "question",
        };
      }

      if (action.tool === "run_in_terminal") {
        hasActed = true;
        writeToTerminal(action.command + "\n");
        onUpdate("executed", action.command);
        history.push({
          role: "user",
          content: `(Command sent to terminal. Assume success.)`,
        });
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      if (action.tool === "execute_command") {
        if (executedCommands.has(action.command)) {
          const errorMsg = `Error: You have already executed this command: "${action.command}". Do not repeat commands. Check previous output or try a different approach.`;
          history.push({ role: "user", content: errorMsg });
          continue;
        }
        executedCommands.add(action.command);
        hasActed = true;

        onUpdate("executing", action.command);
        try {
          let output = await executeCommand(action.command);
          if (!output || output.trim() === "") {
            output = "(Command executed successfully with no output)";
          }
          onUpdate("executed", output);
          history.push({ role: "user", content: `Command Output:\n${output}` });
        } catch (err: any) {
          onUpdate("failed", `${action.command}\n${err.message}`);
          history.push({
            role: "user",
            content: `Command Failed:\n${err.message}`,
          });
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
