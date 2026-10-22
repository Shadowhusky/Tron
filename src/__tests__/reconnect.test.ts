import { describe, it, expect } from "vitest";
import { cleanConnectError, isPermanentConnectError, reconnectDelay } from "../utils/reconnect";

describe("reconnectDelay", () => {
  it("backs off exponentially from 5s and caps at 60s", () => {
    expect([1, 2, 3, 4, 5, 10].map(reconnectDelay)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });
});

describe("isPermanentConnectError", () => {
  it("holds auth and missing-profile failures for manual retry", () => {
    expect(isPermanentConnectError("All configured authentication methods failed")).toBe(true);
    expect(isPermanentConnectError("SSH profile not found")).toBe(true);
    expect(isPermanentConnectError("Permission denied (publickey)")).toBe(true);
    expect(isPermanentConnectError("Unexpected server response: 401")).toBe(true);
  });

  it("keeps retrying network failures", () => {
    expect(isPermanentConnectError("connect ECONNREFUSED 10.0.0.2:22")).toBe(false);
    expect(isPermanentConnectError("Timed out while waiting for handshake")).toBe(false);
    expect(isPermanentConnectError("getaddrinfo ENOTFOUND devbox")).toBe(false);
    expect(isPermanentConnectError("Reconnect timed out")).toBe(false);
  });
});

describe("cleanConnectError", () => {
  it("drops Electron's IPC wrapper", () => {
    expect(cleanConnectError("Error invoking remote method 'ssh.connect': Error: connect ECONNREFUSED 10.0.0.2:22"))
      .toBe("connect ECONNREFUSED 10.0.0.2:22");
    expect(cleanConnectError("connect ETIMEDOUT")).toBe("connect ETIMEDOUT");
  });
});
