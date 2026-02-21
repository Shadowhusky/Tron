import fs from "fs";
import path from "path";
import https from "https";
import { parseArgs } from "util";

const args = parseArgs({
    options: {
        openai: { type: "string" },
        anthropic: { type: "string" },
        gemini: { type: "string" },
        deepseek: { type: "string" },
    },
}).values;

const FILE_PATH = path.resolve("src", "services", "ai", "index.ts");
const code = fs.readFileSync(FILE_PATH, "utf-8");

// Fetch helper
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

// Replace models in source code string for a specific provider
function replaceModels(code: string, provider: string, models: string[]) {
    // Finds: { ... chatUrl: "...", defaultModels: ["...", "..."], ... label: "..." }
    const regex = new RegExp(`(${provider}:\\s*{[^}]*?defaultModels:\\s*\\[)([^\\]]*?)(\\])`, "g");
    const match = code.match(regex);
    if (!match) {
        console.warn(`Could not find provider: ${provider} in CLOUD_PROVIDERS`);
        return code;
    }
    const formattedModels = models.map((m) => `\n      "${m}"`).join(",") + "\n    ";
    return code.replace(regex, `$1${formattedModels}$3`);
}

async function updateModels() {
    let newCode = code;

    // 1. OpenAI (requires API Key)
    if (args.openai) {
        console.log("Fetching OpenAI models...");
        try {
            const data = await fetchJson("https://api.openai.com/v1/models", {
                Authorization: `Bearer ${args.openai}`,
            });
            const models = data.data
                .filter((m: any) => m.id.startsWith("gpt") || m.id.startsWith("o"))
                .sort((a: any, b: any) => b.created - a.created)
                .slice(0, 10) // Keep top 10 newest
                .map((m: any) => m.id);

            console.log("OpenAI models:", models);
            newCode = replaceModels(newCode, "openai", models);
        } catch (err: any) {
            console.error("OpenAI failed:", err.message);
        }
    } else {
        // Hardcoded fallback for OpenAI
        console.log("Using default OpenAI models");
        newCode = replaceModels(newCode, "openai", [
            "o3-mini",
            "o1",
            "gpt-4.5-preview",
            "gpt-4o",
            "gpt-4o-mini"
        ]);
    }

    // 2. Anthropic (requires API key)
    if (args.anthropic) {
        console.log("Fetching Anthropic models...");
        try {
            const data = await fetchJson("https://api.anthropic.com/v1/models", {
                "x-api-key": args.anthropic,
                "anthropic-version": "2023-06-01",
            });
            const models = data.data
                .filter((m: any) => m.type === "model" && m.id.includes("claude"))
                // Approximate sorting by date parsing ID or using created_at
                .sort((a: any, b: any) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime())
                .map((m: any) => m.id);

            console.log("Anthropic models:", models);
            newCode = replaceModels(newCode, "anthropic", models);
        } catch (err: any) {
            console.error("Anthropic failed:", err.message);
        }
    } else {
        // Hardcoding Anthropic standard models
        console.log("Using default Anthropic models");
        newCode = replaceModels(newCode, "anthropic", [
            "claude-3-7-sonnet-20250219",
            "claude-3-5-sonnet-20241022",
            "claude-3-5-haiku-20241022",
            "claude-3-opus-20240229"
        ]);
    }

    // 3. Gemini (requires API key)
    if (args.gemini) {
        console.log("Fetching Gemini models...");
        try {
            const data = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models?key=${args.gemini}`);
            const models = data.models
                .filter((m: any) => m.name.includes("gemini"))
                // Keep the latest 10
                .slice(0, 10)
                .map((m: any) => m.name.replace("models/", ""));

            console.log("Gemini models:", models);
            newCode = replaceModels(newCode, "gemini", models);
        } catch (err: any) {
            console.error("Gemini failed:", err.message);
        }
    } else {
        // Hardcoding Gemini newest models
        console.log("Using default Gemini models");
        newCode = replaceModels(newCode, "gemini", [
            "gemini-2.5-pro",
            "gemini-2.5-flash",
            "gemini-2.0-pro-exp-0205",
            "gemini-2.0-flash-thinking-exp-0121",
            "gemini-2.0-flash"
        ]);
    }

    // Write changes
    if (newCode !== code) {
        fs.writeFileSync(FILE_PATH, newCode);
        console.log(`Successfully updated models in ${FILE_PATH}`);
    } else {
        console.log("No changes made to models.");
    }
}

updateModels();
