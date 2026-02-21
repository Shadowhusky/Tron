"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAIHandlers = registerAIHandlers;
const electron_1 = require("electron");
// Cloud providers that don't need a real API call to test — just validate config.
const CLOUD_PROVIDERS = new Set([
    "openai",
    "anthropic",
    "gemini",
    "deepseek",
    "kimi",
    "qwen",
    "glm",
    "minimax",
]);
function registerAIHandlers() {
    electron_1.ipcMain.handle("ai.testConnection", async (_event, { provider, model, apiKey, baseUrl }) => {
        try {
            // Cloud providers: just validate that API key is present.
            // No real API call — saves tokens. User will see errors on first agent run.
            if (CLOUD_PROVIDERS.has(provider)) {
                if (!apiKey)
                    return { success: false, error: "API key is required" };
                if (!model)
                    return { success: false, error: "Model name is required" };
                return { success: true };
            }
            // Ollama — test via real chat completion (local, no token cost)
            if (provider === "ollama") {
                const url = baseUrl || "http://localhost:11434";
                const headers = { "Content-Type": "application/json" };
                if (apiKey)
                    headers.Authorization = `Bearer ${apiKey}`;
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
                if (!response.ok) {
                    const text = await response.text().catch(() => "");
                    return { success: false, error: `HTTP ${response.status}: ${text || response.statusText}` };
                }
                const data = await response.json();
                return { success: !!data.message?.content };
            }
            // LM Studio — test via real chat completion (local, no token cost)
            if (provider === "lmstudio") {
                const url = (baseUrl || "http://127.0.0.1:1234").replace(/\/+$/, "");
                const headers = { "Content-Type": "application/json" };
                if (apiKey)
                    headers.Authorization = `Bearer ${apiKey}`;
                const response = await fetch(`${url}/v1/chat/completions`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        model: model || "loaded-model",
                        messages: [{ role: "user", content: "hi" }],
                        max_tokens: 5,
                    }),
                });
                if (!response.ok) {
                    const text = await response.text().catch(() => "");
                    return { success: false, error: `HTTP ${response.status}: ${text || response.statusText}` };
                }
                const data = await response.json();
                return { success: !!data.choices?.[0]?.message?.content };
            }
            // Custom compat providers — test connectivity with real call
            if (provider === "anthropic-compat") {
                if (!baseUrl)
                    return { success: false, error: "Base URL is required" };
                const u = baseUrl.replace(/\/+$/, "");
                const url = u.endsWith("/v1/messages") ? u : `${u}/v1/messages`;
                const headers = {
                    "Content-Type": "application/json",
                    "anthropic-version": "2023-06-01",
                };
                if (apiKey)
                    headers["x-api-key"] = apiKey;
                const response = await fetch(url, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        model: model || "claude-sonnet-4-6",
                        messages: [{ role: "user", content: "hi" }],
                        max_tokens: 5,
                    }),
                });
                if (!response.ok) {
                    const text = await response.text().catch(() => "");
                    return { success: false, error: `HTTP ${response.status}: ${text || response.statusText}` };
                }
                return { success: true };
            }
            if (provider === "openai-compat") {
                if (!baseUrl)
                    return { success: false, error: "Base URL is required" };
                const u = baseUrl.replace(/\/+$/, "");
                const chatUrl = u.endsWith("/chat/completions") ? u
                    : u.endsWith("/v1") ? `${u}/chat/completions`
                        : `${u}/v1/chat/completions`;
                const headers = { "Content-Type": "application/json" };
                if (apiKey)
                    headers.Authorization = `Bearer ${apiKey}`;
                const response = await fetch(chatUrl, {
                    method: "POST",
                    headers,
                    body: JSON.stringify({
                        model: model || "default",
                        messages: [{ role: "user", content: "hi" }],
                        max_tokens: 5,
                    }),
                });
                if (!response.ok) {
                    const text = await response.text().catch(() => "");
                    return { success: false, error: `HTTP ${response.status}: ${text || response.statusText}` };
                }
                return { success: true };
            }
            return { success: false, error: `Unknown provider: ${provider}` };
        }
        catch (e) {
            console.error("AI Connection Test Failed:", e);
            const msg = e.cause?.code || e.code || e.message || String(e);
            return { success: false, error: msg };
        }
    });
}
//# sourceMappingURL=ai.js.map