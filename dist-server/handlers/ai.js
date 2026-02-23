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
export async function testConnection({ provider, model, apiKey, baseUrl }) {
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
}
/**
 * Server-side model fetching proxy.
 * In web mode, the browser can't reliably fetch from local providers (CORS, auth).
 * This runs server-side where the provider is reachable on localhost.
 */
export async function getModels({ provider, baseUrl, apiKey }) {
    try {
        if (provider === "ollama") {
            const url = baseUrl || "http://localhost:11434";
            const headers = {};
            if (apiKey)
                headers.Authorization = `Bearer ${apiKey}`;
            const response = await fetch(`${url}/api/tags`, { headers });
            if (!response.ok)
                return [];
            const data = await response.json();
            return (data.models || []).map((m) => ({ name: m.name, provider: "ollama" }));
        }
        if (provider === "lmstudio") {
            const url = (baseUrl || "http://127.0.0.1:1234").replace(/\/+$/, "");
            const headers = {};
            if (apiKey)
                headers.Authorization = `Bearer ${apiKey}`;
            const response = await fetch(`${url}/api/v1/models`, { headers });
            if (!response.ok)
                return [];
            const data = await response.json();
            const allModels = data.models || data.data || [];
            return allModels
                .filter((m) => !m.type || m.type === "llm")
                .map((m) => {
                const caps = [];
                if (m.capabilities?.vision)
                    caps.push("vision");
                if (m.capabilities?.trained_for_tool_use)
                    caps.push("tools");
                return {
                    name: m.key || m.id || m.name,
                    provider: "lmstudio",
                    capabilities: caps.length > 0 ? caps : undefined,
                };
            });
        }
        if (provider === "openai-compat") {
            if (!baseUrl)
                return [];
            const url = baseUrl.replace(/\/+$/, "");
            const headers = {};
            if (apiKey)
                headers.Authorization = `Bearer ${apiKey}`;
            const response = await fetch(`${url}/v1/models`, { headers });
            if (!response.ok)
                return [];
            const data = await response.json();
            return (data.data || []).map((m) => ({ name: m.id || m.name, provider: "openai-compat" }));
        }
        if (provider === "anthropic-compat") {
            if (!baseUrl)
                return [];
            const url = baseUrl.replace(/\/+$/, "");
            const headers = { "anthropic-version": "2023-06-01" };
            if (apiKey)
                headers["x-api-key"] = apiKey;
            const response = await fetch(`${url}/v1/models`, { headers });
            if (!response.ok)
                return [];
            const data = await response.json();
            return (data.data || []).map((m) => ({ name: m.id || m.name, provider: "anthropic-compat" }));
        }
        return [];
    }
    catch (e) {
        console.error("getModels failed:", e?.message || e);
        return [];
    }
}
export async function getModelCapabilities({ provider, modelName, baseUrl, apiKey }) {
    try {
        if (provider === "lmstudio") {
            const url = (baseUrl || "http://127.0.0.1:1234").replace(/\/+$/, "");
            const headers = {};
            if (apiKey)
                headers.Authorization = `Bearer ${apiKey}`;
            const response = await fetch(`${url}/api/v1/models`, { headers });
            if (!response.ok)
                return [];
            const data = await response.json();
            const allModels = data.models || data.data || [];
            const model = allModels.find((m) => (m.key || m.id || m.name) === modelName);
            if (model?.capabilities) {
                const caps = [];
                if (model.capabilities.vision)
                    caps.push("vision");
                if (model.capabilities.trained_for_tool_use)
                    caps.push("tools");
                if (model.capabilities.reasoning || model.capabilities.thinking)
                    caps.push("thinking");
                return caps;
            }
            const key = (model?.key || model?.id || modelName || "").toLowerCase();
            if (/\b(think|reason|r1|qwq)\b/.test(key))
                return ["thinking"];
            return [];
        }
        if (provider === "ollama") {
            const url = baseUrl || "http://localhost:11434";
            const headers = { "Content-Type": "application/json" };
            if (apiKey)
                headers.Authorization = `Bearer ${apiKey}`;
            const response = await fetch(`${url}/api/show`, {
                method: "POST",
                headers,
                body: JSON.stringify({ model: modelName }),
            });
            if (!response.ok)
                return [];
            const data = await response.json();
            if (data.capabilities && Array.isArray(data.capabilities)) {
                return data.capabilities.filter((c) => c !== "completion");
            }
            const capabilities = [];
            const modelInfo = data.model_info || {};
            const template = data.template || "";
            const parameters = data.parameters || "";
            if (template.includes("<think>") || template.includes("thinking") || parameters.includes("think")) {
                capabilities.push("thinking");
            }
            if (Object.keys(modelInfo).some((k) => k.includes("vision") || k.includes("projector") || k.includes("mmproj"))) {
                capabilities.push("vision");
            }
            if (template.includes("<tool_call>") || template.includes("tools") || template.includes("<function")) {
                capabilities.push("tools");
            }
            return capabilities;
        }
        return [];
    }
    catch (e) {
        console.error("getModelCapabilities failed:", e?.message || e);
        return [];
    }
}
//# sourceMappingURL=ai.js.map