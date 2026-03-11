"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWebHandlers = registerWebHandlers;
const electron_1 = require("electron");
/** Strip HTML tags and decode entities. */
function stripTags(s) {
    return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}
/** Brave Search HTML scraping. */
async function braveSearch(query) {
    const resp = await fetch(`https://search.brave.com/search?q=${encodeURIComponent(query)}`, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        },
        signal: AbortSignal.timeout(8000),
        redirect: "follow",
    });
    const html = await resp.text();
    // Detect rate limiting (PoW Captcha page)
    if (html.includes("PoW Captcha") || html.includes("captcha")) {
        throw new Error("Brave rate limited");
    }
    const results = [];
    const blocks = html.split(/class="snippet\s+svelte/);
    for (const block of blocks.slice(1, 10)) {
        const urlMatch = block.match(/href="(https?:\/\/[^"]+)"/);
        const titleMatch = block.match(/class="[^"]*snippet-title[^"]*"[^>]*>([\s\S]*?)<\/div>/)
            || block.match(/class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/);
        const descMatch = block.match(/class="snippet-description[^"]*"[^>]*>([\s\S]*?)<\/p>/)
            || block.match(/class="content[^"]*line-clamp[^"]*"[^>]*>([\s\S]*?)<\/div>/);
        if (urlMatch && titleMatch) {
            const url = urlMatch[1];
            const title = stripTags(titleMatch[1]);
            const snippet = descMatch ? stripTags(descMatch[1]).slice(0, 300) : "";
            if (title && !url.includes("brave.com") && !url.includes("imgs.search")) {
                results.push({ title, url, snippet });
            }
        }
        if (results.length >= 7)
            break;
    }
    return results;
}
/** DuckDuckGo fallback via duck-duck-scrape npm package. */
async function ddgSearch(query) {
    // Dynamic import — package may not be installed in all environments
    const DDG = await Promise.resolve().then(() => __importStar(require("duck-duck-scrape")));
    const searchFn = DDG.search || DDG.default?.search;
    if (!searchFn)
        throw new Error("duck-duck-scrape API changed");
    const data = await searchFn(query, { safeSearch: DDG.SafeSearchType?.MODERATE ?? 0 });
    return (data.results || []).slice(0, 7).map((r) => ({
        title: r.title || "",
        url: r.url || r.href || "",
        snippet: (r.description || r.body || "").slice(0, 300),
    }));
}
/** Startpage (Google proxy) HTML scraping. */
async function startpageSearch(query) {
    const resp = await fetch("https://www.startpage.com/sp/search", {
        method: "POST",
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `query=${encodeURIComponent(query)}&cat=web`,
        signal: AbortSignal.timeout(8000),
        redirect: "follow",
    });
    const html = await resp.text();
    const results = [];
    const blocks = html.split(/class="result\s+css/);
    for (const block of blocks.slice(1, 10)) {
        const titleMatch = block.match(/class="result-title result-link[^"]*"[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        const descMatch = block.match(/<p[^>]*class="[^"]*"[^>]*>([\s\S]*?)<\/p>/);
        if (titleMatch) {
            const url = titleMatch[1];
            // Strip inline CSS from title (Startpage embeds <style> classes in title text)
            const title = stripTags(titleMatch[2]).replace(/\.css-[a-z0-9]+\{[^}]*\}(@media[^{]*\{[^}]*\})?\s*/g, "").replace(/^[{}]\s*/g, "").trim();
            const snippet = descMatch ? stripTags(descMatch[1]).slice(0, 300) : "";
            if (title && !url.includes("startpage.com")) {
                results.push({ title, url, snippet });
            }
        }
        if (results.length >= 7)
            break;
    }
    return results;
}
/** Search with fallback chain: Brave → DuckDuckGo → Startpage. */
async function webSearch(query) {
    // Try Brave first
    try {
        const results = await braveSearch(query);
        if (results.length > 0)
            return { results };
    }
    catch { /* fall through */ }
    // Fallback: duck-duck-scrape
    try {
        const results = await ddgSearch(query);
        if (results.length > 0)
            return { results };
    }
    catch { /* fall through */ }
    // Fallback: Startpage (Google proxy)
    try {
        const results = await startpageSearch(query);
        if (results.length > 0)
            return { results };
    }
    catch { /* fall through */ }
    return { results: [], error: "All search providers failed (rate limited). Try again later." };
}
/** Fetch a URL and return plain text content (HTML stripped). */
async function webFetch(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return { content: "", error: "Only http/https URLs allowed" };
        }
        const resp = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,text/plain,application/json,*/*",
            },
            signal: AbortSignal.timeout(10000),
            redirect: "follow",
        });
        const contentType = resp.headers.get("content-type") || "";
        let text;
        if (contentType.includes("json")) {
            const json = await resp.json();
            text = JSON.stringify(json, null, 2);
        }
        else if (contentType.includes("html")) {
            const html = await resp.text();
            text = html
                .replace(/<script[\s\S]*?<\/script>/gi, "")
                .replace(/<style[\s\S]*?<\/style>/gi, "")
                .replace(/<nav[\s\S]*?<\/nav>/gi, "")
                .replace(/<header[\s\S]*?<\/header>/gi, "")
                .replace(/<footer[\s\S]*?<\/footer>/gi, "")
                .replace(/<[^>]+>/g, " ")
                .replace(/&nbsp;/g, " ")
                .replace(/&amp;/g, "&")
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">")
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/\s+/g, " ")
                .trim();
        }
        else {
            text = await resp.text();
        }
        if (text.length > 15000)
            text = text.slice(0, 15000) + "\n\n[Content truncated at 15KB]";
        return { content: text };
    }
    catch (err) {
        return { content: "", error: err.message };
    }
}
function registerWebHandlers() {
    electron_1.ipcMain.handle("web.search", async (_event, { query }) => {
        return webSearch(query || "");
    });
    electron_1.ipcMain.handle("web.fetch", async (_event, { url }) => {
        return webFetch(url || "");
    });
}
//# sourceMappingURL=web.js.map