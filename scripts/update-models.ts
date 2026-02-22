import fs from "fs";
import path from "path";
import https from "https";

// ---------------------------------------------------------------------------
// Load environment variables from .env file
// ---------------------------------------------------------------------------
function loadEnv(envPath: string): Record<string, string> {
    const env: Record<string, string> = {};
    if (!fs.existsSync(envPath)) return env;
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        env[key] = value;
    }
    return env;
}

const envPath = path.resolve(".env");
const env = loadEnv(envPath);

const OPENAI_API_KEY = env.OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
const ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "";
const GEMINI_API_KEY = env.GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";
const DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || "";
const KIMI_API_KEY = env.KIMI_API_KEY || process.env.KIMI_API_KEY || "";
const QWEN_API_KEY = env.QWEN_API_KEY || process.env.QWEN_API_KEY || "";
const GLM_API_KEY = env.GLM_API_KEY || process.env.GLM_API_KEY || "";
const MINIMAX_API_KEY = env.MINIMAX_API_KEY || process.env.MINIMAX_API_KEY || "";

const FILE_PATH = path.resolve("src", "constants", "models.json");

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------
const fetchJson = (url: string, headers: Record<string, string> = {}) => {
    return new Promise<any>((resolve, reject) => {
        https
            .get(url, { headers }, (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(e);
                    }
                });
            })
            .on("error", reject);
    });
};

// ---------------------------------------------------------------------------
// Provider fetchers
// ---------------------------------------------------------------------------

async function fetchOpenAI(apiKey: string): Promise<string[]> {
    console.log("Fetching OpenAI models...");
    const data = await fetchJson("https://api.openai.com/v1/models", {
        Authorization: `Bearer ${apiKey}`,
    });
    const models = data.data
        .filter((m: any) => m.id.startsWith("gpt") || m.id.startsWith("o"))
        .filter((m: any) => !m.id.includes("audio") && !m.id.includes("realtime") && !m.id.includes("tts") && !m.id.includes("transcribe") && !m.id.includes("embedding"))
        .sort((a: any, b: any) => b.created - a.created)
        .slice(0, 10)
        .map((m: any) => m.id);
    return models;
}

async function fetchAnthropic(apiKey: string): Promise<string[]> {
    console.log("Fetching Anthropic models...");
    const data = await fetchJson("https://api.anthropic.com/v1/models", {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
    });
    const models = data.data
        .filter((m: any) => m.type === "model" && m.id.includes("claude"))
        .sort((a: any, b: any) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
        .map((m: any) => m.id);
    return models;
}

async function fetchGemini(apiKey: string): Promise<string[]> {
    console.log("Fetching Gemini models...");
    const data = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const models = data.models
        .filter((m: any) => m.name.includes("gemini"))
        .slice(0, 10)
        .map((m: any) => m.name.replace("models/", ""));
    return models;
}

async function fetchDeepSeek(apiKey: string): Promise<string[]> {
    console.log("Fetching DeepSeek models...");
    const data = await fetchJson("https://api.deepseek.com/models", {
        Authorization: `Bearer ${apiKey}`,
    });
    const models = data.data
        .sort((a: any, b: any) => b.created - a.created)
        .map((m: any) => m.id);
    return models;
}

async function fetchKimi(apiKey: string): Promise<string[]> {
    console.log("Fetching Kimi models...");
    const data = await fetchJson("https://api.moonshot.ai/v1/models", {
        Authorization: `Bearer ${apiKey}`,
    });
    const models = data.data
        .filter((m: any) => m.id.includes("kimi") || m.id.includes("moonshot"))
        .sort((a: any, b: any) => b.created - a.created)
        .map((m: any) => m.id);
    return models;
}

async function fetchQwen(apiKey: string): Promise<string[]> {
    console.log("Fetching Qwen models...");
    // Use DashScope OpenAI compatible endpoint
    const data = await fetchJson("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models", {
        Authorization: `Bearer ${apiKey}`,
    });
    const models = data.data
        .filter((m: any) => m.id.includes("qwen"))
        .sort((a: any, b: any) => b.created - a.created)
        .map((m: any) => m.id);
    return models;
}

async function fetchGLM(apiKey: string): Promise<string[]> {
    console.log("Fetching GLM models...");
    const data = await fetchJson("https://open.bigmodel.cn/api/paas/v4/models", {
        Authorization: `Bearer ${apiKey}`,
    });
    const models = data.data
        .filter((m: any) => m.id.includes("glm"))
        .sort((a: any, b: any) => b.created - a.created)
        .map((m: any) => m.id);
    return models;
}

async function fetchMiniMax(apiKey: string): Promise<string[]> {
    console.log("Fetching MiniMax models...");
    const data = await fetchJson("https://api.minimax.io/v1/models", {
        Authorization: `Bearer ${apiKey}`,
    });
    const models = data.data
        .filter((m: any) => m.id.includes("MiniMax") || m.id.includes("M2"))
        .sort((a: any, b: any) => b.created - a.created)
        .map((m: any) => m.id);
    return models;
}

// ---------------------------------------------------------------------------
// Hardcoded fallbacks (used when no API key is provided)
// ---------------------------------------------------------------------------

const FALLBACK_MODELS: Record<string, string[]> = {
    openai: [
        "gpt-5.2",
        "o3-mini",
        "o1",
        "gpt-4.5-preview",
        "gpt-4o",
        "gpt-4o-mini",
    ],
    anthropic: [
        "claude-sonnet-4-6",
        "claude-opus-4-6",
        "claude-haiku-4-5-20251001",
        "claude-3-7-sonnet-20250219",
        "claude-3-5-sonnet-20241022",
    ],
    gemini: [
        "gemini-3.1-pro-preview",
        "gemini-3-pro-preview",
        "gemini-3-flash-preview",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
    ],
    deepseek: ["deepseek-chat", "deepseek-reasoner"],
    kimi: ["kimi-k2.5", "kimi-k2", "moonshot-v1-128k"],
    qwen: ["qwen3.5-plus", "qwen3-max", "qwen-plus-latest"],
    glm: ["glm-5", "glm-4.5", "glm-4-plus"],
    minimax: ["MiniMax-M2.5", "MiniMax-M2.1", "MiniMax-M2", "M2-her"],
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function updateModels() {
    let modelsJson: Record<string, string[]> = {};
    if (fs.existsSync(FILE_PATH)) {
        modelsJson = JSON.parse(fs.readFileSync(FILE_PATH, "utf-8"));
    }
    let changed = false;

    const providers: { name: string; key: string; fetcher: (key: string) => Promise<string[]> }[] = [
        { name: "openai", key: OPENAI_API_KEY, fetcher: fetchOpenAI },
        { name: "anthropic", key: ANTHROPIC_API_KEY, fetcher: fetchAnthropic },
        { name: "gemini", key: GEMINI_API_KEY, fetcher: fetchGemini },
        { name: "deepseek", key: DEEPSEEK_API_KEY, fetcher: fetchDeepSeek },
        { name: "kimi", key: KIMI_API_KEY, fetcher: fetchKimi },
        { name: "qwen", key: QWEN_API_KEY, fetcher: fetchQwen },
        { name: "glm", key: GLM_API_KEY, fetcher: fetchGLM },
        { name: "minimax", key: MINIMAX_API_KEY, fetcher: fetchMiniMax },
    ];

    for (const { name, key, fetcher } of providers) {
        let newModels: string[] | null = null;
        if (key) {
            try {
                newModels = await fetcher(key);
                console.log(`${name} models:`, newModels);
            } catch (err: any) {
                console.error(`${name} failed:`, err.message);
                console.log(`Using fallback ${name} models`);
                newModels = FALLBACK_MODELS[name];
            }
        } else {
            console.log(`No API key for ${name}, using fallback models`);
            newModels = FALLBACK_MODELS[name];
        }

        if (newModels && JSON.stringify(modelsJson[name]) !== JSON.stringify(newModels)) {
            modelsJson[name] = newModels;
            changed = true;
        }
    }

    if (changed) {
        fs.writeFileSync(FILE_PATH, JSON.stringify(modelsJson, null, 2) + "\n");
        console.log(`\nSuccessfully updated models in ${FILE_PATH}`);
    } else {
        console.log("\nNo changes made to models.");
    }
}

updateModels();
