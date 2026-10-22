"use strict";
// Pre-flight check for the in-app browser pane: an iframe can't report why a
// page failed (DNS, refused, TLS) — it just stays blank — so the main process
// / server fetches the URL once and classifies the outcome.
//
// server/handlers/browserProbe.ts is a byte-identical copy (the tsconfigs
// can't share files; browserProbe.test.ts fails on drift). No imports, so the
// same text compiles in both and in the renderer's test run.
Object.defineProperty(exports, "__esModule", { value: true });
exports.isFrameBlocked = isFrameBlocked;
exports.probeBrowserUrl = probeBrowserUrl;
function isFrameBlocked(xFrameOptions, csp) {
    const xfo = xFrameOptions.trim().toLowerCase();
    if (xfo === "deny" || xfo === "sameorigin")
        return true;
    const fa = /frame-ancestors\s+([^;]+)/i.exec(csp);
    if (!fa)
        return false;
    const value = fa[1].trim().toLowerCase();
    return value === "'none'" || value === "'self'";
}
function failure(err, url) {
    const e = err;
    const code = `${e.cause?.code ?? e.code ?? ""} ${e.cause?.message ?? ""} ${e.message ?? ""}`;
    const host = url.host;
    if (e.name === "TimeoutError" || e.name === "AbortError" || /UND_ERR_CONNECT_TIMEOUT|ETIMEDOUT/.test(code)) {
        return { ok: false, kind: "timeout", message: `${host} is taking too long to respond.` };
    }
    if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME/.test(code)) {
        return { ok: false, kind: "not-found", message: `Couldn't find ${url.hostname}. Check the address.` };
    }
    if (/ECONNREFUSED/.test(code)) {
        return { ok: false, kind: "refused", message: `Nothing is accepting connections at ${host} — is the server running?` };
    }
    if (url.protocol === "https:" && /WRONG_VERSION_NUMBER|PACKET_LENGTH_TOO_LONG|wrong version number|packet length too long|EPROTO|ECONNRESET/i.test(code)) {
        return { ok: false, kind: "http-only", message: `${host} doesn't speak HTTPS.` };
    }
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME|certificate/i.test(code)) {
        return { ok: false, kind: "tls", message: `${host}'s security certificate isn't trusted.` };
    }
    return { ok: false, kind: "error", message: `Couldn't open ${host}: ${(e.cause?.message ?? e.message ?? "unknown error").slice(0, 160)}` };
}
async function probeBrowserUrl(raw, timeoutMs = 6000) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return { ok: false, kind: "error", message: "That isn't a valid address." };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return { ok: false, kind: "error", message: "Only http and https pages can be shown here." };
    }
    try {
        const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        void res.body?.cancel().catch(() => { });
        const blocked = isFrameBlocked(res.headers.get("x-frame-options") ?? "", res.headers.get("content-security-policy") ?? "");
        return { ok: true, embeddable: !blocked, status: res.status };
    }
    catch (err) {
        return failure(err, url);
    }
}
//# sourceMappingURL=browserProbe.js.map