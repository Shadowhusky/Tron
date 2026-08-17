"use strict";
/**
 * Pure parsing + blocked-response detection for web search.
 *
 * No network, no electron imports, so vitest covers it directly
 * (src/__tests__/webSearchParse.test.ts). server/index.ts mirrors the
 * behaviour (rootDir isolation prevents a shared import).
 *
 * Background: every keyless search endpoint (Brave HTML, DuckDuckGo
 * html/lite, Startpage, Mojeek) rate-limits or captcha-walls scrapers
 * aggressively — verified live 2026-08-18, all four blocked from one
 * dev machine after a handful of queries. The chain is therefore
 * BEST-EFFORT, and the important part is telling the caller WHY it came
 * back empty: "blocked/unavailable" must never be reported to the agent
 * as "no results", because the agent then rewords the query and burns
 * turns against a dead service (observed in log 39172cb246).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripTags = stripTags;
exports.isBlockedResponse = isBlockedResponse;
exports.decodeDdgRedirect = decodeDdgRedirect;
exports.parseDdgLite = parseDdgLite;
exports.parseDdgHtml = parseDdgHtml;
exports.parseBrave = parseBrave;
exports.parseBraveApi = parseBraveApi;
function stripTags(s) {
    return s
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#x27;|&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
/**
 * True when a response is a rate-limit / captcha / anti-bot challenge
 * rather than a real result page. DuckDuckGo answers 200/202 with an
 * "anomaly" interstitial; Brave answers 429; Mojeek serves a page
 * titled "Captcha". Detecting this is what separates "search is down"
 * from "this query has no hits".
 */
function isBlockedResponse(status, html) {
    if (status === 429 || status === 403 || status === 202)
        return true;
    const head = html.slice(0, 4000);
    return (/<title>\s*captcha/i.test(head) ||
        /detected an anomaly|unusual traffic|are you a robot|pow captcha/i.test(head));
}
/** DuckDuckGo wraps result links as //duckduckgo.com/l/?uddg=<encoded>. */
function decodeDdgRedirect(href) {
    let url = href;
    const m = url.match(/[?&]uddg=([^&]+)/);
    if (m) {
        try {
            url = decodeURIComponent(m[1]);
        }
        catch {
            /* leave as-is */
        }
    }
    if (url.startsWith("//"))
        url = "https:" + url;
    return url;
}
/**
 * Parse the lite.duckduckgo.com result table.
 *
 * NOTE the quoting: DDG emits `class='result-link'` with SINGLE quotes.
 * The previous implementation required double quotes and therefore
 * matched nothing even on a perfectly good response — a silent 0-results
 * bug independent of the rate limiting.
 */
function parseDdgLite(html) {
    const links = [
        ...html.matchAll(/<a[^>]*href=["']([^"']+)["'][^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/g),
    ];
    const snippets = [
        ...html.matchAll(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g),
    ].map((m) => stripTags(m[1]));
    const out = [];
    links.forEach((m, i) => {
        const url = decodeDdgRedirect(m[1]);
        const title = stripTags(m[2]);
        if (!title || !/^https?:\/\//.test(url))
            return;
        out.push({ title, url, snippet: (snippets[i] || "").slice(0, 300) });
    });
    return out.slice(0, 7);
}
/** Parse the html.duckduckgo.com layout (different class names to lite). */
function parseDdgHtml(html) {
    const blocks = html.split(/class="(?:web-)?result[\s"]/).slice(1);
    const out = [];
    for (const b of blocks) {
        const link = b.match(/<a[^>]*class="result__a"[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/);
        if (!link)
            continue;
        const url = decodeDdgRedirect(link[1]);
        const title = stripTags(link[2]);
        const snip = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
        if (title && /^https?:\/\//.test(url)) {
            out.push({ title, url, snippet: snip ? stripTags(snip[1]).slice(0, 300) : "" });
        }
        if (out.length >= 7)
            break;
    }
    return out;
}
/** Parse search.brave.com result snippets. */
function parseBrave(html) {
    const out = [];
    const blocks = html.split(/class="snippet[\s"]/).slice(1, 12);
    for (const b of blocks) {
        const urlMatch = b.match(/href="(https?:\/\/[^"]+)"/);
        const titleMatch = b.match(/class="[^"]*snippet-title[^"]*"[^>]*>([\s\S]*?)<\/div>/) ||
            b.match(/class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/);
        const descMatch = b.match(/class="snippet-description[^"]*"[^>]*>([\s\S]*?)<\/p>/) ||
            b.match(/class="[^"]*line-clamp[^"]*"[^>]*>([\s\S]*?)<\/div>/);
        if (!urlMatch || !titleMatch)
            continue;
        const url = urlMatch[1];
        const title = stripTags(titleMatch[1]);
        if (!title || url.includes("brave.com") || url.includes("imgs.search"))
            continue;
        out.push({
            title,
            url,
            snippet: descMatch ? stripTags(descMatch[1]).slice(0, 300) : "",
        });
        if (out.length >= 7)
            break;
    }
    return out;
}
/** Parse Brave Search API JSON (used when the user configured an API key). */
function parseBraveApi(json) {
    const web = json?.web?.results;
    if (!Array.isArray(web))
        return [];
    return web.slice(0, 7).map((r) => {
        const o = r;
        return {
            title: stripTags(o.title || ""),
            url: o.url || "",
            snippet: stripTags(o.description || "").slice(0, 300),
        };
    }).filter((r) => r.title && r.url);
}
//# sourceMappingURL=webSearchParse.js.map