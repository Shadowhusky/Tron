import { ipcMain } from "electron";

// Provider chat URLs — must match src/services/ai/index.ts CLOUD_PROVIDERS
const PROVIDER_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  deepseek: "https://api.deepseek.com/chat/completions",
  kimi: "https://api.moonshot.ai/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  glm: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  minimax: "https://api.minimax.io/v1/text/chatcompletion_v2",
};

export function registerAIHandlers() {
  ipcMain.handle(
    "ai.testConnection",
    async (_event, { provider, model, apiKey, baseUrl }) => {
      try {
        if (provider === "ollama") {
          const url = baseUrl || "http://localhost:11434";
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
          const response = await fetch(`${url}/api/chat`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: model || "llama3",
              messages: [{ role: "user", content: "hi" }],
              stream: false,
              options: { num_predict: 5 },
            }),
          });
          if (!response.ok) return false;
          const data = await response.json();
          return !!data.message?.content;
        }

        // LM Studio — test via real chat completion
        if (provider === "lmstudio") {
          const url = (baseUrl || "http://127.0.0.1:1234").replace(/\/+$/, "");
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
          const response = await fetch(`${url}/v1/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: model || "loaded-model",
              messages: [{ role: "user", content: "hi" }],
              max_tokens: 5,
            }),
          });
          if (!response.ok) return false;
          const data = await response.json();
          return !!data.choices?.[0]?.message?.content;
        }

        // Anthropic and Anthropic-compatible
        if (provider === "anthropic" || provider === "anthropic-compat") {
          const url = provider === "anthropic-compat" && baseUrl
            ? (() => { const u = baseUrl.replace(/\/+$/, ""); return u.endsWith("/v1/messages") ? u : `${u}/v1/messages`; })()
            : "https://api.anthropic.com/v1/messages";
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
          };
          if (apiKey) headers["x-api-key"] = apiKey;
          const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              model: model || "claude-sonnet-4-6",
              messages: [{ role: "user", content: "hi" }],
              max_tokens: 5,
            }),
          });
          return response.ok;
        }

        // All OpenAI-compatible providers (openai, deepseek, kimi, gemini, qwen, glm, lmstudio, openai-compat)
        const chatUrl = baseUrl
          ? (() => {
              const url = baseUrl.replace(/\/+$/, "");
              if (url.endsWith("/chat/completions")) return url;
              if (url.endsWith("/v1")) return `${url}/chat/completions`;
              return `${url}/v1/chat/completions`;
            })()
          : PROVIDER_URLS[provider];
        if (!chatUrl) return false;

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

        const response = await fetch(chatUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: model || "gpt-4o",
            messages: [{ role: "user", content: "hi" }],
            max_tokens: 5,
          }),
        });
        return response.ok;
      } catch (e) {
        console.error("AI Connection Test Failed:", e);
        return false;
      }
    },
  );
}
