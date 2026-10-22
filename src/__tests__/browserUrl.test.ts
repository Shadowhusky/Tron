import { describe, it, expect } from "vitest";
import { normalizeBrowserInput, isMixedContentBlocked, httpFallback } from "../utils/browserUrl";

describe("normalizeBrowserInput", () => {
  it("uses http for local and LAN addresses (dev servers rarely speak https)", () => {
    expect(normalizeBrowserInput("localhost:3000")).toEqual({ url: "http://localhost:3000", autoScheme: true });
    expect(normalizeBrowserInput("127.0.0.1:8080/x").url).toBe("http://127.0.0.1:8080/x");
    expect(normalizeBrowserInput("192.168.1.5:8080").url).toBe("http://192.168.1.5:8080");
    expect(normalizeBrowserInput("[::1]:3000").url).toBe("http://[::1]:3000");
    expect(normalizeBrowserInput("router.local").url).toBe("http://router.local");
    expect(normalizeBrowserInput("devbox:8080/app").url).toBe("http://devbox:8080/app");
  });

  it("uses https for public domains", () => {
    expect(normalizeBrowserInput("example.com")).toEqual({ url: "https://example.com", autoScheme: true });
    expect(normalizeBrowserInput("docs.github.com/en").url).toBe("https://docs.github.com/en");
  });

  it("keeps an explicit scheme", () => {
    expect(normalizeBrowserInput(" http://example.com ")).toEqual({ url: "http://example.com", autoScheme: false });
  });

  it("searches for anything that isn't an address", () => {
    const r = normalizeBrowserInput("how to rebase");
    expect(r.url).toBe("https://www.google.com/search?q=how%20to%20rebase");
    expect(r.autoScheme).toBe(false);
  });
});

describe("isMixedContentBlocked", () => {
  it("blocks http pages inside an https app", () => {
    expect(isMixedContentBlocked("https:", "http://example.com")).toBe(true);
  });

  it("allows loopback, which browsers treat as trustworthy", () => {
    expect(isMixedContentBlocked("https:", "http://localhost:3000")).toBe(false);
    expect(isMixedContentBlocked("https:", "http://127.0.0.1:3000")).toBe(false);
  });

  it("never blocks when the app itself isn't https (desktop file://, plain-http web)", () => {
    expect(isMixedContentBlocked("file:", "http://example.com")).toBe(false);
    expect(isMixedContentBlocked("http:", "http://example.com")).toBe(false);
  });
});

describe("httpFallback", () => {
  it("swaps https for http and keeps the rest", () => {
    expect(httpFallback("https://devbox:8443/app?x=1")).toBe("http://devbox:8443/app?x=1");
  });

  it("has nothing to offer for http URLs", () => {
    expect(httpFallback("http://example.com")).toBeNull();
  });
});
