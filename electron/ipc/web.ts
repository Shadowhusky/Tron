import { ipcMain } from "electron";
import {
  isBlockedResponse,
  parseBrave,
  parseBraveApi,
  parseDdgHtml,
  parseDdgLite,
  type SearchFailure,
  type SearchResult,
} from "./webSearchParse";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Thrown when a backend answers with a captcha / rate-limit page. */
class BlockedError extends Error {}

/** Fetch a URL with a browser-ish UA, raising BlockedError on a challenge page. */
async function getHtml(
  url: string,
  init: RequestInit = {},
): Promise<string> {
  const resp = await fetch(url, {
    ...init,
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(8000),
    redirect: "follow",
  });
  const html = await resp.text();
  if (isBlockedResponse(resp.status, html)) throw new BlockedError(String(resp.status));
  return html;
}

/** Brave Search API — only used when the user configured a key. */
async function braveApiSearch(query: string, key: string): Promise<SearchResult[]> {
  const resp = await fetch(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=7`,
    {
      headers: { Accept: "application/json", "X-Subscription-Token": key },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (resp.status === 429 || resp.status === 403) throw new BlockedError(String(resp.status));
  if (!resp.ok) throw new Error(`Brave API ${resp.status}`);
  return parseBraveApi(await resp.json());
}

async function ddgLiteSearch(query: string): Promise<SearchResult[]> {
  return parseDdgLite(
    await getHtml("https://lite.duckduckgo.com/lite/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ q: query }).toString(),
    }),
  );
}

async function ddgHtmlSearch(query: string): Promise<SearchResult[]> {
  return parseDdgHtml(
    await getHtml(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`),
  );
}

async function braveScrapeSearch(query: string): Promise<SearchResult[]> {
  return parseBrave(
    await getHtml(`https://search.brave.com/search?q=${encodeURIComponent(query)}`),
  );
}

/**
 * Search with a best-effort backend chain.
 *
 * Returns `failure: "blocked"` when every backend was rate-limited or
 * captcha-walled (as opposed to genuinely returning nothing) so the caller
 * can tell the agent to stop searching instead of rewording its query.
 */
async function webSearch(
  query: string,
): Promise<{ results: SearchResult[]; error?: string; failure?: SearchFailure }> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY || "";
  const backends: Array<() => Promise<SearchResult[]>> = [
    ...(apiKey ? [() => braveApiSearch(query, apiKey)] : []),
    () => ddgLiteSearch(query),
    () => ddgHtmlSearch(query),
    () => braveScrapeSearch(query),
  ];

  // A backend "answered" only if it returned a parseable page without being
  // blocked or erroring. If NONE answered, search is unavailable — that
  // includes timeouts and network errors, not just explicit rate limits.
  let answered = 0;
  for (const run of backends) {
    try {
      const results = await run();
      answered++;
      if (results.length > 0) return { results };
    } catch {
      /* blocked, timed out, or transport error — try the next backend */
    }
  }

  if (answered === 0) {
    return {
      results: [],
      failure: "blocked",
      error: "All search backends are rate-limited, blocked, or unreachable.",
    };
  }
  return { results: [], failure: "empty" };
}


/** Fetch a URL and return plain text content (HTML stripped). */
async function webFetch(url: string): Promise<{ content: string; error?: string }> {
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
    let text: string;
    if (contentType.includes("json")) {
      const json = await resp.json();
      text = JSON.stringify(json, null, 2);
    } else if (contentType.includes("html")) {
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
    } else {
      text = await resp.text();
    }
    if (text.length > 15000) text = text.slice(0, 15000) + "\n\n[Content truncated at 15KB]";
    return { content: text };
  } catch (err: any) {
    return { content: "", error: err.message };
  }
}

export function registerWebHandlers() {
  ipcMain.handle("web.search", async (_event, { query }: { query: string }) => {
    return webSearch(query || "");
  });

  ipcMain.handle("web.fetch", async (_event, { url }: { url: string }) => {
    return webFetch(url || "");
  });
}
