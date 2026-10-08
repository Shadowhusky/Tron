import { describe, it, expect, afterEach, vi } from "vitest";
import { EventEmitter } from "events";
import fs from "fs";
import net from "net";
import path from "path";
import { PassThrough } from "stream";
import type { Client } from "ssh2";
import {
  parseSocks5Greeting,
  parseSocks5Request,
  socks5Reply,
  listenOnFreePort,
  validateForwardSpec,
  toPersistedSpec,
  sameForwardSpec,
  preserveProfileForwards,
  missingRememberedForwards,
  ForwardManager,
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

  // Binding 127.0.0.1:P succeeds even when a local server holds [::1]:P or
  // *:P (SO_REUSEADDR), and browsers resolve localhost to ::1 first — the
  // forward would silently shadow the user's own server.
  const occupyOn = async (host: string, port = 0): Promise<number | null> => {
    const s = net.createServer();
    const ok = await new Promise<boolean>((r) => {
      s.once("error", () => r(false));
      s.listen(port, host, () => r(true));
    });
    if (!ok) return null;
    servers.push(s);
    return (s.address() as net.AddressInfo).port;
  };

  it("skips a port a local server answers on over IPv6 loopback", async () => {
    const busy = await occupyOn("::1");
    if (busy === null) return; // no IPv6 loopback on this machine
    const s = net.createServer();
    servers.push(s);
    expect(await listenOnFreePort(s, busy)).not.toBe(busy);
  });

  it("skips a port a local server holds on the wildcard address", async () => {
    const busy = await occupyOn("0.0.0.0");
    const s = net.createServer();
    servers.push(s);
    expect(await listenOnFreePort(s, busy!)).not.toBe(busy);
  });
});

/** Just enough of ssh2's Client for ForwardManager; forwardOut answers via `onForwardOut`. */
function fakeClient(onForwardOut: (cb: (err: Error | undefined, ch: PassThrough) => void) => void = () => {}) {
  const ee = new EventEmitter() as EventEmitter & Record<string, unknown>;
  ee.forwardOut = (_a: string, _b: number, _c: string, _d: number, cb: (err: Error | undefined, ch: PassThrough) => void) =>
    onForwardOut(cb);
  ee.forwardIn = (_addr: string, port: number, cb: (err: Error | undefined, port: number) => void) => cb(undefined, port || 40000);
  ee.unforwardIn = () => {};
  return ee as unknown as Client;
}

/** A channel that echoes what it is sent, standing in for the remote end. */
function echoChannel(): PassThrough {
  const ch = new PassThrough() as PassThrough & { close: () => void };
  ch.close = () => ch.destroy();
  return ch;
}

describe("ForwardManager edge cases", () => {
  const managers: ForwardManager[] = [];
  afterEach(() => {
    for (const m of managers.splice(0)) m.closeSession("s1");
  });
  const manager = (onChange: (sid: string, list: ForwardRecord[]) => void = () => {}) => {
    const m = new ForwardManager(onChange);
    managers.push(m);
    return m;
  };

  it("survives a client resetting the connection before the tunnel opens", async () => {
    const mgr = manager();
    const rec = await mgr.add("s1", fakeClient(), { type: "local", remoteHost: "localhost", remotePort: 5173 });
    const errors: unknown[] = [];
    const onUncaught = (e: unknown) => errors.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      await new Promise<void>((resolve) => {
        const sock = net.connect(rec.localPort, "127.0.0.1", () => {
          sock.resetAndDestroy();
          setTimeout(resolve, 150);
        });
      });
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    expect(errors).toEqual([]);
  });

  it("shares one listener between concurrent identical requests", async () => {
    const mgr = manager();
    const client = fakeClient();
    const [a, b] = await Promise.all([
      mgr.add("s1", client, { type: "local", remoteHost: "localhost", remotePort: 5173 }),
      mgr.add("s1", client, { type: "local", remoteHost: "localhost", remotePort: 5173 }),
    ]);
    expect(b.id).toBe(a.id);
    expect(mgr.list("s1")).toHaveLength(1);
  });

  it("tracks every forward when different ones are added concurrently", async () => {
    const mgr = manager();
    const client = fakeClient();
    await Promise.all([
      mgr.add("s1", client, { type: "local", remoteHost: "localhost", remotePort: 5173 }),
      mgr.add("s1", client, { type: "dynamic" }),
    ]);
    expect(mgr.list("s1").map((f) => f.type).sort()).toEqual(["dynamic", "local"]);
  });

  it("marks an existing forward as remembered and reports the change", async () => {
    const changes: ForwardRecord[][] = [];
    const mgr = manager((_sid, list) => changes.push(list));
    const client = fakeClient();
    const first = await mgr.add("s1", client, { type: "local", remoteHost: "localhost", remotePort: 5173 });
    expect(first.persist).toBeUndefined();
    const again = await mgr.add("s1", client, { type: "local", remoteHost: "localhost", remotePort: 5173 }, { persist: true });
    expect(again.id).toBe(first.id);
    expect(again.persist).toBe(true);
    expect(changes.at(-1)?.[0].persist).toBe(true);
  });

  it("does not drop SOCKS client data sent while the tunnel is opening", async () => {
    let open: ((err: Error | undefined, ch: PassThrough) => void) | undefined;
    const mgr = manager();
    const rec = await mgr.add("s1", fakeClient((cb) => { open = cb; }), { type: "dynamic" });
    const received = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(rec.localPort, "127.0.0.1");
      let stage = 0;
      let buf = Buffer.alloc(0);
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        if (stage === 0 && buf.length >= 2) {
          buf = buf.subarray(2);
          stage = 1;
          sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90]));
          setTimeout(() => {
            sock.write("early");
            setTimeout(() => open?.(undefined, echoChannel()), 50);
          }, 50);
        }
        if (stage === 1 && buf.length >= 10 + 5) {
          sock.destroy();
          resolve(buf.subarray(10).toString());
        }
      });
      sock.on("error", reject);
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
      setTimeout(() => reject(new Error("timed out")), 2000);
    });
    expect(received).toBe("early");
  });

  it("rejects remote connections that match no forward", async () => {
    const mgr = manager();
    const client = fakeClient();
    await mgr.add("s1", client, { type: "remote", remotePort: 9000, localPort: 3000 });
    const accept = vi.fn();
    const reject = vi.fn();
    (client as unknown as EventEmitter).emit("tcp connection", { destPort: 9999 }, accept, reject);
    expect(reject).toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it("closes forwards that finish starting after their session is gone", async () => {
    const mgr = manager();
    const pending = mgr.add("s1", fakeClient(), { type: "dynamic" });
    mgr.closeSession("s1");
    const rec = await pending;
    expect(mgr.list("s1")).toEqual([]);
    await expect(
      new Promise((resolve, reject) => {
        const sock = net.connect(rec.localPort, "127.0.0.1", () => { sock.destroy(); resolve("connected"); });
        sock.on("error", reject);
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
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
    expect(toPersistedSpec(rec({ type: "dynamic", localPort: 1080, remoteHost: "", remotePort: 0, requestedLocalPort: 1080 }))).toEqual({
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

  it("remembers the local port the user chose, not a fallback", () => {
    expect(toPersistedSpec(rec({ localPort: 8000, requestedLocalPort: 8000 }))).toEqual({
      type: "local", remoteHost: "localhost", remotePort: 5173, localPort: 8000,
    });
    // SOCKS fell back from 1080 to 1081: next connect should try 1080 again
    expect(toPersistedSpec(rec({ type: "dynamic", localPort: 1081, remoteHost: "", remotePort: 0 }))).toEqual({ type: "dynamic" });
  });
});

describe("preserveProfileForwards", () => {
  const fwd = [{ type: "local" as const, remoteHost: "localhost", remotePort: 5173 }];

  it("carries remembered forwards onto a profile rebuilt without them", () => {
    const out = preserveProfileForwards([{ id: "p1", host: "a", forwards: fwd }], [{ id: "p1", host: "b" }]);
    expect(out).toEqual([{ id: "p1", host: "b", forwards: fwd }]);
  });

  it("respects an explicit forwards list, including an empty one", () => {
    expect(preserveProfileForwards([{ id: "p1", forwards: fwd }], [{ id: "p1", forwards: [] }])).toEqual([{ id: "p1", forwards: [] }]);
  });

  it("leaves new and forward-less profiles untouched", () => {
    expect(preserveProfileForwards([{ id: "p1" }], [{ id: "p1" }, { id: "p2" }])).toEqual([{ id: "p1" }, { id: "p2" }]);
  });
});

describe("missingRememberedForwards", () => {
  const live = (over: Partial<ForwardRecord>): ForwardRecord => ({
    id: "x", type: "local", localHost: "127.0.0.1", localPort: 5174,
    remoteHost: "localhost", remotePort: 5173, status: "active", ...over,
  });
  const web = { type: "local" as const, remoteHost: "localhost", remotePort: 5173 };
  const socks = { type: "dynamic" as const };

  it("skips forwards another session of the profile already runs", () => {
    expect(missingRememberedForwards([web, socks], [live({})])).toEqual([socks]);
  });

  it("returns everything when nothing is running", () => {
    expect(missingRememberedForwards([web, socks], [])).toEqual([web, socks]);
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
