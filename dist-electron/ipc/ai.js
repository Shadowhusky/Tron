"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAIHandlers = registerAIHandlers;
const electron_1 = require("electron");
function registerAIHandlers() {
    electron_1.ipcMain.handle("ai.testConnection", async (_event, { provider, model, apiKey, baseUrl }) => {
        try {
            if (provider === "ollama") {
                const url = baseUrl || "http://localhost:11434";
                const response = await fetch(`${url}/api/tags`, {
                    method: "GET",
                });
                // tags endpoint is better for connectivity check than generate
                return response.ok;
            }
            if (provider === "openai") {
                const response = await fetch("https://api.openai.com/v1/chat/completions", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${apiKey}`,
                    },
                    body: JSON.stringify({
                        model: model || "gpt-3.5-turbo",
                        messages: [{ role: "user", content: "hi" }],
                        max_tokens: 5,
                    }),
                });
                return response.ok;
            }
            if (provider === "anthropic") {
                const response = await fetch("https://api.anthropic.com/v1/messages", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "x-api-key": apiKey,
                        "anthropic-version": "2023-06-01",
                    },
                    body: JSON.stringify({
                        model: model || "claude-3-opus-20240229",
                        messages: [{ role: "user", content: "hi" }],
                        max_tokens: 5,
                    }),
                });
                return response.ok;
            }
            return false;
        }
        catch (e) {
            console.error("AI Connection Test Failed:", e);
            return false;
        }
    });
}
//# sourceMappingURL=ai.js.map