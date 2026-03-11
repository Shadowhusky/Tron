import { ipcMain } from "electron";

/** Strip HTML tags and decode entities. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

type SearchResult = { title: string; url: string; snippet: string };

/** Brave Search HTML scraping. */
async function braveSearch(query: string): Promise<SearchResult[]> {
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
  const results: SearchResult[] = [];
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
    if (results.length >= 7) break;
  }
  return results;
}

/** DuckDuckGo fallback via duck-duck-scrape npm package. */
async function ddgSearch(query: string): Promise<SearchResult[]> {
  // Dynamic import — package may not be installed in all environments
  const DDG = await import("duck-duck-scrape");
  const searchFn = DDG.search || DDG.default?.search;
  if (!searchFn) throw new Error("duck-duck-scrape API changed");
  const data = await searchFn(query, { safeSearch: DDG.SafeSearchType?.MODERATE ?? 0 });
  return (data.results || []).slice(0, 7).map((r: any) => ({
    title: r.title || "",
    url: r.url || r.href || "",
    snippet: (r.description || r.body || "").slice(0, 300),
  }));
}

/** Startpage (Google proxy) HTML scraping. */
async function startpageSearch(query: string): Promise<SearchResult[]> {
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
  const results: SearchResult[] = [];
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
    if (results.length >= 7) break;
  }
  return results;
}

/** Search with fallback chain: Brave → DuckDuckGo → Startpage. */
async function webSearch(query: string): Promise<{ results: SearchResult[]; error?: string }> {
  // Try Brave first
  try {
    const results = await braveSearch(query);
    if (results.length > 0) return { results };
  } catch { /* fall through */ }

  // Fallback: duck-duck-scrape
  try {
    const results = await ddgSearch(query);
    if (results.length > 0) return { results };
  } catch { /* fall through */ }

  // Fallback: Startpage (Google proxy)
  try {
    const results = await startpageSearch(query);
    if (results.length > 0) return { results };
  } catch { /* fall through */ }

  return { results: [], error: "All search providers failed (rate limited). Try again later." };
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
