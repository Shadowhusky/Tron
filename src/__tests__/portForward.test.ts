import { describe, it, expect } from "vitest";
import {
  parseLoopbackUrl,
  rewriteToForward,
  forwardOpensLocally,
  describeForward,
  forwardLocalAddress,
} from "../utils/portForward";
import type { PortForward } from "../types";

describe("parseLoopbackUrl", () => {
  it("recognizes localhost URLs with an explicit port", () => {
    expect(parseLoopbackUrl("http://localhost:5173/")).toEqual({ port: 5173, forwardHost: "localhost" });
  });

  it("keeps 127.0.0.1 and maps 0.0.0.0 to localhost for the tunnel target", () => {
    expect(parseLoopbackUrl("http://127.0.0.1:8000/docs")).toEqual({ port: 8000, forwardHost: "127.0.0.1" });
    expect(parseLoopbackUrl("http://0.0.0.0:3000")).toEqual({ port: 3000, forwardHost: "localhost" });
  });

  it("handles IPv6 loopback", () => {
    expect(parseLoopbackUrl("http://[::1]:4000/")).toEqual({ port: 4000, forwardHost: "::1" });
  });

  it("falls back to the scheme's default port", () => {
    expect(parseLoopbackUrl("http://localhost/")).toEqual({ port: 80, forwardHost: "localhost" });
    expect(parseLoopbackUrl("https://localhost/")).toEqual({ port: 443, forwardHost: "localhost" });
  });

  it("ignores non-loopback hosts, other schemes and garbage", () => {
    expect(parseLoopbackUrl("https://example.com:5173/")).toBeNull();
    expect(parseLoopbackUrl("http://192.168.1.4:5173/")).toBeNull();
    expect(parseLoopbackUrl("ftp://localhost:21/")).toBeNull();
    expect(parseLoopbackUrl("not a url")).toBeNull();
    expect(parseLoopbackUrl("http://constructor:80/")).toBeNull();
  });
});

describe("rewriteToForward", () => {
  // The listener binds 127.0.0.1 only; "localhost" may resolve to ::1 first
  // and reach a different local server on the same port.
  it("points the URL at the IPv4 loopback listener and keeps path, query and hash", () => {
    expect(rewriteToForward("http://0.0.0.0:3000/a/b?x=1#top", 3001)).toBe("http://127.0.0.1:3001/a/b?x=1#top");
    expect(rewriteToForward("http://localhost:5173/", 5174)).toBe("http://127.0.0.1:5174/");
  });

  it("keeps https", () => {
    expect(rewriteToForward("https://127.0.0.1:8443/", 8443)).toBe("https://127.0.0.1:8443/");
  });
});

describe("forwardLocalAddress", () => {
  const f = (over: Partial<PortForward>): PortForward => ({
    id: "1", type: "local", localHost: "127.0.0.1", localPort: 5174,
    remoteHost: "localhost", remotePort: 5173, status: "active", ...over,
  });

  it("is an http URL for a local forward and host:port for SOCKS", () => {
    expect(forwardLocalAddress(f({}))).toBe("http://127.0.0.1:5174");
    expect(forwardLocalAddress(f({ type: "dynamic", localPort: 1080 }))).toBe("127.0.0.1:1080");
  });
});

describe("forwardOpensLocally", () => {
  it("is true in the desktop app", () => {
    expect(forwardOpensLocally({ isElectron: true, locationHostname: "", sessionRemote: false })).toBe(true);
  });

  it("is true in web mode only when the browser runs on the server machine", () => {
    expect(forwardOpensLocally({ isElectron: false, locationHostname: "localhost", sessionRemote: false })).toBe(true);
    expect(forwardOpensLocally({ isElectron: false, locationHostname: "127.0.0.1", sessionRemote: false })).toBe(true);
    expect(forwardOpensLocally({ isElectron: false, locationHostname: "tron.example.com", sessionRemote: false })).toBe(false);
    expect(forwardOpensLocally({ isElectron: false, locationHostname: "toString", sessionRemote: false })).toBe(false);
  });

  it("is false for sessions living on a remote Tron server", () => {
    expect(forwardOpensLocally({ isElectron: true, locationHostname: "", sessionRemote: true })).toBe(false);
  });
});

describe("describeForward", () => {
  const f = (over: Partial<PortForward>): PortForward => ({
    id: "1", type: "local", localHost: "127.0.0.1", localPort: 5174,
    remoteHost: "localhost", remotePort: 5173, status: "active", ...over,
  });

  it("reads in the direction traffic flows", () => {
    expect(describeForward(f({}))).toBe("127.0.0.1:5174 → localhost:5173");
    expect(describeForward(f({ type: "remote", remoteHost: "127.0.0.1", remotePort: 9000, localPort: 3000 }))).toBe(
      "remote 127.0.0.1:9000 → 127.0.0.1:3000",
    );
    expect(describeForward(f({ type: "dynamic", localPort: 1080 }))).toBe("SOCKS5 127.0.0.1:1080");
  });
});
