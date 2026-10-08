import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import net from "net";
import path from "path";
import {
  parseSocks5Greeting,
  parseSocks5Request,
  socks5Reply,
  listenOnFreePort,
  validateForwardSpec,
  toPersistedSpec,
  sameForwardSpec,
  type ForwardRecord,
} from "../../electron/ipc/sshForward";

describe("parseSocks5Greeting", () => {
  it("accepts a version-5 greeting and reports the offered methods", () => {
    expect(parseSocks5Greeting(Buffer.from([0x05, 0x02, 0x00, 0x02]))).toEqual({
      ok: true,
      consumed: 4,
      methods: [0x00, 0x02],
    });
  });

  it("asks for more bytes when the method list is incomplete", () => {
    expect(parseSocks5Greeting(Buffer.from([0x05, 0x02, 0x00]))).toEqual({ ok: false, need: true });
    expect(parseSocks5Greeting(Buffer.from([0x05]))).toEqual({ ok: false, need: true });
  });

  it("rejects other SOCKS versions", () => {
    const r = parseSocks5Greeting(Buffer.from([0x04, 0x01, 0x00]));
    expect(r.ok).toBe(false);
    expect("error" in r && r.error).toMatch(/version/i);
  });
});

describe("parseSocks5Request", () => {
  it("parses a CONNECT to an IPv4 address", () => {
    const buf = Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90]);
    expect(parseSocks5Request(buf)).toEqual({
      ok: true,
      consumed: 10,
      cmd: 0x01,
      host: "127.0.0.1",
      port: 8080,
    });
  });

  it("parses a CONNECT to a domain name", () => {
    const name = Buffer.from("example.com");
    const buf = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]),
      name,
      Buffer.from([0x01, 0xbb]),
    ]);
    expect(parseSocks5Request(buf)).toEqual({
      ok: true,
      consumed: buf.length,
      cmd: 0x01,
      host: "example.com",
      port: 443,
    });
  });

  it("parses a CONNECT to an IPv6 address", () => {
    const addr = Buffer.alloc(16);
    addr[15] = 1;
    const buf = Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x04]), addr, Buffer.from([0x00, 0x50])]);
    const r = parseSocks5Request(buf);
    expect(r).toMatchObject({ ok: true, consumed: 22, host: "0:0:0:0:0:0:0:1", port: 80 });
  });

  it("asks for more bytes on a truncated request", () => {
    expect(parseSocks5Request(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0]))).toEqual({ ok: false, need: true });
    expect(parseSocks5Request(Buffer.from([0x05, 0x01, 0x00, 0x03]))).toEqual({ ok: false, need: true });
  });

  it("returns non-CONNECT commands so the caller can refuse them", () => {
    const buf = Buffer.from([0x05, 0x02, 0x00, 0x01, 127, 0, 0, 1, 0, 80]);
    expect(parseSocks5Request(buf)).toMatchObject({ ok: true, cmd: 0x02 });
  });

  it("rejects an unknown address type with reply code 0x08", () => {
    const r = parseSocks5Request(Buffer.from([0x05, 0x01, 0x00, 0x09, 0, 0]));
    expect(r).toMatchObject({ ok: false, replyCode: 0x08 });
  });
});

describe("socks5Reply", () => {
  it("encodes a reply with an empty IPv4 bind address", () => {
    expect([...socks5Reply(0x00)]).toEqual([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
    expect(socks5Reply(0x05)[1]).toBe(0x05);
  });
});

describe("listenOnFreePort", () => {
  const servers: net.Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  });

  const occupy = async (): Promise<number> => {
    const s = net.createServer();
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    return (s.address() as net.AddressInfo).port;
  };

  it("binds the preferred port when it is free", async () => {
    const probe = await occupy();
    await new Promise((r) => servers.pop()!.close(() => r(null)));
    const s = net.createServer();
    servers.push(s);
    expect(await listenOnFreePort(s, probe)).toBe(probe);
  });

  it("moves to another free port when the preferred one is taken", async () => {
    const busy = await occupy();
    const s = net.createServer();
    servers.push(s);
    const port = await listenOnFreePort(s, busy);
    expect(port).not.toBe(busy);
    expect(port).toBeGreaterThan(0);
  });

  it("lets the OS choose when no port is preferred", async () => {
    const s = net.createServer();
    servers.push(s);
    expect(await listenOnFreePort(s)).toBeGreaterThan(0);
  });

  it("only listens on loopback", async () => {
    const s = net.createServer();
    servers.push(s);
    await listenOnFreePort(s);
    expect((s.address() as net.AddressInfo).address).toBe("127.0.0.1");
  });
});

describe("validateForwardSpec", () => {
  it("accepts a local forward and defaults the remote host", () => {
    expect(validateForwardSpec({ type: "local", remotePort: 5173 })).toEqual({
      type: "local",
      remoteHost: "localhost",
      remotePort: 5173,
    });
  });

  it("requires a remote port for local forwards", () => {
    expect(validateForwardSpec({ type: "local" })).toMatch(/remote port/i);
  });

  it("requires a local target port for remote forwards", () => {
    expect(validateForwardSpec({ type: "remote", remotePort: 9000 })).toMatch(/local port/i);
    expect(validateForwardSpec({ type: "remote", remotePort: 0, localPort: 3000 })).toEqual({
      type: "remote",
      remoteHost: "127.0.0.1",
      remotePort: 0,
      localPort: 3000,
    });
  });

  it("accepts a bare dynamic forward", () => {
    expect(validateForwardSpec({ type: "dynamic" })).toEqual({ type: "dynamic" });
  });

  it("rejects unknown types and out-of-range or non-integer ports", () => {
    expect(validateForwardSpec({ type: "tunnel" })).toMatch(/type/i);
    expect(validateForwardSpec({ type: "local", remotePort: 70000 })).toMatch(/port/i);
    expect(validateForwardSpec({ type: "local", remotePort: 80.5 })).toMatch(/port/i);
    expect(validateForwardSpec({ type: "dynamic", localPort: -1 })).toMatch(/port/i);
    expect(validateForwardSpec(null)).toMatch(/type/i);
  });

  it("rejects host names with whitespace or shell metacharacters", () => {
    expect(validateForwardSpec({ type: "local", remotePort: 80, remoteHost: "a b" })).toMatch(/host/i);
  });
});

describe("persisted forward specs", () => {
  const rec = (over: Partial<ForwardRecord>): ForwardRecord => ({
    id: "x", type: "local", localHost: "127.0.0.1", localPort: 5174,
    remoteHost: "localhost", remotePort: 5173, status: "active", ...over,
  });

  it("keeps only what is needed to recreate the forward", () => {
    expect(toPersistedSpec(rec({}))).toEqual({ type: "local", remoteHost: "localhost", remotePort: 5173 });
    expect(toPersistedSpec(rec({ type: "dynamic", localPort: 1080, remoteHost: "", remotePort: 0 }))).toEqual({
      type: "dynamic",
      localPort: 1080,
    });
    expect(toPersistedSpec(rec({ type: "remote", localPort: 3000, remoteHost: "127.0.0.1", remotePort: 9000 }))).toEqual({
      type: "remote",
      localPort: 3000,
      remoteHost: "127.0.0.1",
      remotePort: 9000,
    });
  });

  it("matches local forwards by remote target, ignoring the chosen local port", () => {
    expect(sameForwardSpec({ type: "local", remoteHost: "localhost", remotePort: 5173 }, toPersistedSpec(rec({ localPort: 9999 })))).toBe(true);
    expect(sameForwardSpec({ type: "local", remoteHost: "localhost", remotePort: 8080 }, toPersistedSpec(rec({})))).toBe(false);
  });

  it("never matches across types", () => {
    expect(sameForwardSpec({ type: "dynamic", localPort: 5173 }, { type: "local", remoteHost: "localhost", remotePort: 5173 })).toBe(false);
  });
});

describe("server mirror", () => {
  it("server/handlers/sshForward.ts is an exact copy of electron/ipc/sshForward.ts", () => {
    const root = path.resolve(__dirname, "../..");
    const a = fs.readFileSync(path.join(root, "electron/ipc/sshForward.ts"), "utf-8");
    const b = fs.readFileSync(path.join(root, "server/handlers/sshForward.ts"), "utf-8");
    expect(b).toBe(a);
  });
});
