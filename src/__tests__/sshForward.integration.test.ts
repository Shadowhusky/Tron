import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "net";
import { Client, Server, utils } from "ssh2";
import { ForwardManager, type ForwardRecord } from "../../electron/ipc/sshForward";

// A real ssh2 client talking to an in-process ssh2 server that implements
// direct-tcpip (-L / -D) and tcpip-forward (-R), plus a TCP echo service.

let echo: net.Server;
let echoPort = 0;
let sshServer: Server;
let sshPort = 0;
let client: Client;
const remoteListeners: net.Server[] = [];

function listen(server: net.Server, port = 0): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
}

function roundTrip(port: number, payload: string, prelude?: (s: net.Socket) => Promise<void>): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", async () => {
      try {
        if (prelude) await prelude(sock);
        let got = "";
        sock.on("data", (d) => {
          got += d.toString();
          if (got.length >= payload.length) {
            sock.end();
            resolve(got);
          }
        });
        sock.write(payload);
      } catch (e) {
        reject(e);
      }
    });
    sock.on("error", reject);
    setTimeout(() => reject(new Error("round trip timed out")), 4000);
  });
}

function readExactly(sock: net.Socket, n: number): Promise<Buffer> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= n) {
        sock.off("data", onData);
        if (buf.length > n) sock.unshift(buf.subarray(n));
        resolve(buf.subarray(0, n));
      }
    };
    sock.on("data", onData);
  });
}

beforeAll(async () => {
  echo = net.createServer((s) => s.pipe(s));
  echoPort = await listen(echo);

  const hostKey = utils.generateKeyPairSync("ed25519").private;
  sshServer = new Server({ hostKeys: [hostKey] }, (conn) => {
    conn.on("authentication", (ctx) => ctx.accept());
    conn.on("ready", () => {
      conn.on("tcpip", (accept, _reject, info) => {
        const stream = accept();
        const sock = net.connect(info.destPort, info.destIP);
        stream.pipe(sock).pipe(stream);
        sock.on("error", () => stream.close());
      });
      conn.on("request", (accept, reject, name, info) => {
        if (name !== "tcpip-forward" || !accept || !reject) {
          accept?.();
          return;
        }
        const fwdInfo = info as { bindAddr: string; bindPort: number };
        const srv = net.createServer((sock) => {
          conn.forwardOut(fwdInfo.bindAddr, bound, sock.remoteAddress || "127.0.0.1", sock.remotePort || 0, (err, ch) => {
            if (err) return sock.destroy();
            sock.pipe(ch).pipe(sock);
          });
        });
        let bound = 0;
        remoteListeners.push(srv);
        listen(srv, fwdInfo.bindPort).then((p) => {
          bound = p;
          accept(p);
        });
      });
    });
  });
  await new Promise<void>((r) => sshServer.listen(0, "127.0.0.1", () => r()));
  sshPort = (sshServer.address() as net.AddressInfo).port;

  client = new Client();
  await new Promise<void>((resolve, reject) => {
    client.on("ready", () => resolve()).on("error", reject);
    client.connect({ host: "127.0.0.1", port: sshPort, username: "t", password: "t" });
  });
});

afterAll(async () => {
  client?.end();
  for (const s of remoteListeners) s.close();
  await new Promise((r) => sshServer.close(() => r(null)));
  await new Promise((r) => echo.close(() => r(null)));
});

describe("ForwardManager over a real SSH connection", () => {
  it("local (-L) forwards a loopback port to the remote target", async () => {
    const changes: ForwardRecord[][] = [];
    const mgr = new ForwardManager((_sid, list) => changes.push(list));
    const rec = await mgr.add("s1", client, { type: "local", remoteHost: "127.0.0.1", remotePort: echoPort });
    expect(rec.status).toBe("active");
    expect(rec.localHost).toBe("127.0.0.1");
    expect(await roundTrip(rec.localPort, "hello")).toBe("hello");
    expect(changes.at(-1)?.map((f) => f.id)).toEqual([rec.id]);
    mgr.closeSession("s1");
  });

  it("prefers the remote port number for the local listener", async () => {
    const mgr = new ForwardManager(() => {});
    const rec = await mgr.add("s1", client, { type: "local", remoteHost: "127.0.0.1", remotePort: echoPort });
    // the echo server already holds echoPort locally, so a different one is chosen
    expect(rec.localPort).not.toBe(echoPort);
    mgr.closeSession("s1");
  });

  it("reuses an active local forward to the same target", async () => {
    const mgr = new ForwardManager(() => {});
    const a = await mgr.add("s1", client, { type: "local", remoteHost: "127.0.0.1", remotePort: echoPort });
    const b = await mgr.add("s1", client, { type: "local", remoteHost: "127.0.0.1", remotePort: echoPort });
    expect(b.id).toBe(a.id);
    expect(mgr.list("s1")).toHaveLength(1);
    mgr.closeSession("s1");
  });

  it("dynamic (-D) serves SOCKS5 CONNECT through the tunnel", async () => {
    const mgr = new ForwardManager(() => {});
    const rec = await mgr.add("s1", client, { type: "dynamic" });
    const out = await roundTrip(rec.localPort, "ping", async (sock) => {
      sock.write(Buffer.from([0x05, 0x01, 0x00]));
      expect([...(await readExactly(sock, 2))]).toEqual([0x05, 0x00]);
      sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, echoPort >> 8, echoPort & 0xff]));
      const reply = await readExactly(sock, 10);
      expect(reply[1]).toBe(0x00);
    });
    expect(out).toBe("ping");
    mgr.closeSession("s1");
  });

  it("remote (-R) exposes a local service on the remote side", async () => {
    const mgr = new ForwardManager(() => {});
    const rec = await mgr.add("s1", client, { type: "remote", remotePort: 0, localPort: echoPort });
    expect(rec.status).toBe("active");
    expect(rec.remotePort).toBeGreaterThan(0);
    // the test ssh server's "remote side" listens on loopback too
    expect(await roundTrip(rec.remotePort, "over-r")).toBe("over-r");
    mgr.closeSession("s1");
  });

  it("remove() stops the listener", async () => {
    const mgr = new ForwardManager(() => {});
    const rec = await mgr.add("s1", client, { type: "local", remoteHost: "127.0.0.1", remotePort: echoPort });
    expect(mgr.remove("s1", rec.id)).toBe(true);
    expect(mgr.list("s1")).toEqual([]);
    await expect(roundTrip(rec.localPort, "x")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("closeSession() tears down every forward of that session only", async () => {
    const mgr = new ForwardManager(() => {});
    await mgr.add("s1", client, { type: "local", remoteHost: "127.0.0.1", remotePort: echoPort });
    await mgr.add("s1", client, { type: "dynamic" });
    const other = await mgr.add("s2", client, { type: "dynamic" });
    mgr.closeSession("s1");
    expect(mgr.list("s1")).toEqual([]);
    expect(mgr.list("s2").map((f) => f.id)).toEqual([other.id]);
    mgr.closeSession("s2");
  });
});
