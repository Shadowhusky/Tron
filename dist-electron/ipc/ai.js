"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAIHandlers = registerAIHandlers;
const electron_1 = require("electron");
// Provider chat URLs — must match src/services/ai/index.ts CLOUD_PROVIDERS
const PROVIDER_URLS = {
    openai: "https://api.openai.com/v1/chat/completions",
    deepseek: "https://api.deepseek.com/chat/completions",
    kimi: "https://api.moonshot.cn/v1/chat/completions",
    gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    glm: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
};
function registerAIHandlers() {
    electron_1.ipcMain.handle("ai.testConnection", async (_event, { provider, model, apiKey, baseUrl }) => {
        try {
            if (provider === "ollama") {
                const url = baseUrl || "http://localhost:11434";
                const response = await fetch(`${url}/api/tags`, { method: "GET" });
                return response.ok;
            }
            if (provider === "anthropic") {
                const response = await fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": apiKey || "",
                        "anthropic-version": "2023-06-01",
                    },
                    body: JSON.stringify({
                        model: model || "claude-sonnet-4-6",
                        messages: [{ role: "user", content: "hi" }],
                        max_tokens: 5,
                    }),
                });
                return response.ok;
            }
            // All OpenAI-compatible providers (openai, deepseek, kimi, gemini, qwen, glm)
            const chatUrl = baseUrl
                ? `${baseUrl.replace(/\/+$/, "")}/chat/completions`
                : PROVIDER_URLS[provider];
            if (!chatUrl)
                return false;
            const response = await fetch(chatUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: model || "gpt-4o",
                    messages: [{ role: "user", content: "hi" }],
                    max_tokens: 5,
                }),
            });
            return response.ok;
        }
        catch (e) {
            console.error("AI Connection Test Failed:", e);
            return false;
        }
    });
}
//# sourceMappingURL=ai.js.map