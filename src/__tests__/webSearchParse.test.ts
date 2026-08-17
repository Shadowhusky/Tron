import { describe, it, expect } from "vitest";
import {
  decodeDdgRedirect,
  isBlockedResponse,
  parseBrave,
  parseBraveApi,
  parseDdgHtml,
  parseDdgLite,
  stripTags,
} from "../../electron/ipc/webSearchParse";
import { describeSearchFailure } from "../utils/searchFailure";

/** Real lite.duckduckgo.com markup, captured live 2026-08-18.
 *  Note `class='result-link'` — SINGLE quotes. The old parser required
 *  double quotes and silently matched nothing. */
const DDG_LITE = `
<table border="0">
<!-- Web results are present -->
<tr><td valign="top">1.&nbsp;</td><td>
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.bbc.com%2Fweather%2F2643743&amp;rut=4d96" class='result-link'>London - BBC Weather</a>
</td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;</td><td class='result-snippet'>
14-day <b>weather</b> forecast for <b>London</b>.
</td></tr>
<tr><td valign="top">2.&nbsp;</td><td>
<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fweather.metoffice.gov.uk%2Fforecast%2Fgcpvj" class='result-link'>London weather - Met Office</a>
</td></tr>
<tr><td>&nbsp;&nbsp;&nbsp;</td><td class='result-snippet'>Latest forecast for London.</td></tr>
</table>`;

/** The anti-bot interstitial DDG serves once it decides you're a scraper. */
const DDG_BLOCKED = `<!DOCTYPE html><html><head><title>DuckDuckGo</title></head>
<body><p>If this error persists, please let us know: DDG detected an anomaly in the request,
you are likely making requests too quickly.</p></body></html>`;

describe("isBlockedResponse", () => {
  it("treats rate-limit / challenge statuses as blocked, not empty", () => {
    expect(isBlockedResponse(429, "<html>whatever</html>")).toBe(true); // Brave
    expect(isBlockedResponse(202, DDG_BLOCKED)).toBe(true); // DuckDuckGo
    expect(isBlockedResponse(403, "")).toBe(true);
  });

  it("detects captcha/anomaly interstitials served with a 200", () => {
    expect(isBlockedResponse(200, DDG_BLOCKED)).toBe(true);
    expect(isBlockedResponse(200, "<html><head><title>Captcha</title></head>")).toBe(true); // Mojeek
    expect(isBlockedResponse(200, "<html>PoW Captcha required</html>")).toBe(true);
  });

  it("does not flag an ordinary results page", () => {
    expect(isBlockedResponse(200, DDG_LITE)).toBe(false);
  });

  it("only scans the head, so the word 'captcha' deep in a page is not a block", () => {
    const article = "<html><body>" + "x".repeat(5000) + "<p>how captcha systems work</p></body></html>";
    expect(isBlockedResponse(200, article)).toBe(false);
  });
});

describe("decodeDdgRedirect", () => {
  it("unwraps the uddg redirect and forces a scheme", () => {
    expect(decodeDdgRedirect("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1&rut=x"))
      .toBe("https://example.com/a?b=1");
  });
  it("passes through direct URLs untouched", () => {
    expect(decodeDdgRedirect("https://example.com/x")).toBe("https://example.com/x");
  });
  it("survives malformed percent-encoding", () => {
    expect(decodeDdgRedirect("//duckduckgo.com/l/?uddg=%E0%A4%A")).toContain("duckduckgo.com");
  });
});

describe("parseDdgLite", () => {
  it("parses the live single-quoted markup the old regex missed", () => {
    const r = parseDdgLite(DDG_LITE);
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({
      title: "London - BBC Weather",
      url: "https://www.bbc.com/weather/2643743",
      snippet: "14-day weather forecast for London.",
    });
    expect(r[1].url).toBe("https://weather.metoffice.gov.uk/forecast/gcpvj");
  });

  it("returns nothing for a blocked page rather than throwing", () => {
    expect(parseDdgLite(DDG_BLOCKED)).toEqual([]);
  });

  it("caps at 7 results", () => {
    const row = (i: number) =>
      `<a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fe${i}.com" class='result-link'>R${i}</a>`;
    expect(parseDdgLite(Array.from({ length: 12 }, (_, i) => row(i)).join(""))).toHaveLength(7);
  });
});

describe("parseDdgHtml / parseBrave", () => {
  it("parses the html.duckduckgo.com layout", () => {
    const html = `<div class="result results_links">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org">Example</a>
      <a class="result__snippet">A <b>snippet</b> here</a></div>`;
    expect(parseDdgHtml(html)).toEqual([
      { title: "Example", url: "https://example.org", snippet: "A snippet here" },
    ]);
  });

  it("parses Brave snippets and drops self-links", () => {
    const html =
      `<div class="snippet foo"><a href="https://good.example/x"></a>` +
      `<div class="snippet-title">Good</div><p class="snippet-description">desc</p></div>` +
      `<div class="snippet bar"><a href="https://brave.com/ad"></a>` +
      `<div class="snippet-title">Ad</div></div>`;
    const r = parseBrave(html);
    expect(r).toHaveLength(1);
    expect(r[0].title).toBe("Good");
  });
});

describe("parseBraveApi", () => {
  it("maps the API JSON shape", () => {
    expect(
      parseBraveApi({ web: { results: [{ title: "T", url: "https://a.test", description: "<b>d</b>" }] } }),
    ).toEqual([{ title: "T", url: "https://a.test", snippet: "d" }]);
  });
  it("tolerates junk", () => {
    expect(parseBraveApi(null)).toEqual([]);
    expect(parseBraveApi({ web: {} })).toEqual([]);
  });
});

describe("stripTags", () => {
  it("removes markup and decodes entities", () => {
    expect(stripTags("<b>a</b> &amp; &quot;b&quot;&nbsp;c")).toBe('a & "b" c');
  });
});

describe("describeSearchFailure — the log 39172cb246 regression", () => {
  it("tells the agent to STOP searching when backends are blocked", () => {
    const m = describeSearchFailure("london weather", "blocked");
    expect(m).toMatch(/UNAVAILABLE/);
    expect(m).toMatch(/must NOT call web_search again/i);
    expect(m).toMatch(/web_fetch/);
    // The old message said this for blocked backends too — that's the bug.
    expect(m).not.toMatch(/Reformulate/i);
  });

  it("still asks for reformulation on a genuinely empty result set", () => {
    const m = describeSearchFailure("asdfqwerzxcv", "empty");
    expect(m).toMatch(/Reformulate/i);
    expect(m).not.toMatch(/UNAVAILABLE/);
  });
});
