import { describe, it, expect, afterAll, beforeAll } from "vitest";
import fs from "fs";
import http from "http";
import net from "net";
import path from "path";
import type { AddressInfo } from "net";
import { probeBrowserUrl, isFrameBlocked } from "../../electron/ipc/browserProbe";

describe("isFrameBlocked", () => {
  it("honours X-Frame-Options and CSP frame-ancestors", () => {
    expect(isFrameBlocked("DENY", "")).toBe(true);
    expect(isFrameBlocked("sameorigin", "")).toBe(true);
    expect(isFrameBlocked("", "default-src 'self'; frame-ancestors 'none'")).toBe(true);
    expect(isFrameBlocked("", "frame-ancestors 'self'")).toBe(true);
    expect(isFrameBlocked("", "frame-ancestors *")).toBe(false);
    expect(isFrameBlocked("", "")).toBe(false);
  });
});

describe("probeBrowserUrl (real local servers)", () => {
  let server: http.Server;
  let base = "";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/deny") res.setHeader("X-Frame-Options", "DENY");
      if (req.url === "/csp") res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
      res.end("<h1>hi</h1>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("reports an embeddable page", async () => {
    expect(await probeBrowserUrl(`http://${base}/`)).toEqual({ ok: true, embeddable: true, status: 200 });
  });

  it("reports pages that refuse to be framed", async () => {
    expect(await probeBrowserUrl(`http://${base}/deny`)).toMatchObject({ ok: true, embeddable: false });
    expect(await probeBrowserUrl(`http://${base}/csp`)).toMatchObject({ ok: true, embeddable: false });
  });

  it("reports a closed port as refused", async () => {
    const free = net.createServer();
    await new Promise<void>((r) => free.listen(0, "127.0.0.1", r));
    const port = (free.address() as AddressInfo).port;
    await new Promise<void>((r) => free.close(() => r()));
    expect(await probeBrowserUrl(`http://127.0.0.1:${port}/`)).toMatchObject({ ok: false, kind: "refused" });
  });

  it("reports https to a plain-http server as http-only", async () => {
    expect(await probeBrowserUrl(`https://${base}/`)).toMatchObject({ ok: false, kind: "http-only" });
  });

  it("reports an unknown host as not found", async () => {
    expect(await probeBrowserUrl("http://tron-probe-test.invalid/")).toMatchObject({ ok: false, kind: "not-found" });
  });

  it("refuses non-web schemes", async () => {
    expect(await probeBrowserUrl("ftp://example.com/")).toMatchObject({ ok: false, kind: "error" });
  });
});

describe("server mirror", () => {
  it("server/handlers/browserProbe.ts is an exact copy of electron/ipc/browserProbe.ts", () => {
    const root = path.resolve(__dirname, "../..");
    const a = fs.readFileSync(path.join(root, "electron/ipc/browserProbe.ts"), "utf-8");
    const b = fs.readFileSync(path.join(root, "server/handlers/browserProbe.ts"), "utf-8");
    expect(b).toBe(a);
  });
});
