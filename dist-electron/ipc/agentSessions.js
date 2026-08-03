"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAgentSessionHandlers = registerAgentSessionHandlers;
/**
 * Resolve the EXACT session id of an AI CLI (Claude Code / Codex) that was
 * running in a terminal pane, by fingerprinting the pane's restored transcript
 * against the CLI's own on-disk session store. Used by auto-resume after an
 * app restart — a resume is only attempted on a confident unique match;
 * anything ambiguous returns null and the caller does nothing.
 *
 * Store layouts (verified against real installs):
 * - Claude Code: ~/.claude/projects/<cwd with non-alphanumerics → "-">/<uuid>.jsonl
 *   (filename is the session id)
 * - Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl, first line
 *   {"type":"session_meta","payload":{"id","cwd",…}}
 */
const electron_1 = require("electron");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const MAX_CANDIDATES = 10;
const TAIL_BYTES = 2000000;
const MAX_ROLLOUT_SCAN = 60;
function readSlice(filePath, bytes, fromEnd) {
    const fd = fs.openSync(filePath, "r");
    try {
        const size = fs.fstatSync(fd).size;
        const len = Math.min(size, bytes);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, fromEnd ? size - len : 0);
        return buf.toString("utf8");
    }
    finally {
        fs.closeSync(fd);
    }
}
/** Count how many transcript fragments appear in a session file. Fragments
 *  are plain text; the file stores JSON strings, so search the escaped form. */
function scoreFile(filePath, fragments) {
    let content;
    try {
        content = readSlice(filePath, TAIL_BYTES, true);
    }
    catch {
        return 0;
    }
    let hits = 0;
    for (const frag of fragments) {
        const escaped = JSON.stringify(frag).slice(1, -1);
        if (content.includes(escaped))
            hits++;
    }
    return hits;
}
/** Confident-or-nothing pick: the winner needs enough absolute hits AND clear
 *  separation from the runner-up (shared build output can cross-match). */
function pickConfident(scored, fragmentCount) {
    if (fragmentCount < 2)
        return null;
    const sorted = [...scored].sort((a, b) => b.hits - a.hits);
    const best = sorted[0];
    if (!best)
        return null;
    const second = sorted[1]?.hits ?? 0;
    if (best.hits < Math.min(3, fragmentCount))
        return null;
    if (best.hits < second * 2 || best.hits - second < 2)
        return null;
    return best.id;
}
function findClaudeSession(cwd, fragments) {
    const dirName = cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const dir = path.join(os.homedir(), ".claude", "projects", dirName);
    let candidates;
    try {
        candidates = fs.readdirSync(dir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => {
            const file = path.join(dir, f);
            return { id: f.slice(0, -6), file, mtime: fs.statSync(file).mtimeMs };
        })
            .sort((a, b) => b.mtime - a.mtime)
            .slice(0, MAX_CANDIDATES);
    }
    catch {
        return null;
    } // no store / never ran claude here
    const scored = candidates.map((c) => ({ id: c.id, hits: scoreFile(c.file, fragments) }));
    return pickConfident(scored, fragments.length);
}
/** Parse id+cwd out of a rollout file's session_meta first line. The line can
 *  be large (inlined base instructions), so fall back to a regex scan when the
 *  first newline is beyond the head read. */
function readRolloutMeta(filePath) {
    let head;
    try {
        head = readSlice(filePath, 65536, false);
    }
    catch {
        return null;
    }
    const nl = head.indexOf("\n");
    if (nl > -1) {
        try {
            const meta = JSON.parse(head.slice(0, nl));
            if (meta?.type === "session_meta" && meta.payload?.id && meta.payload?.cwd) {
                return { id: meta.payload.id, cwd: meta.payload.cwd };
            }
            return null;
        }
        catch { /* fall through to regex */ }
    }
    const m = head.match(/"type":"session_meta".*?"id":"([0-9a-fA-F-]{16,64})".*?"cwd":"((?:[^"\\]|\\.)*)"/);
    if (!m)
        return null;
    try {
        return { id: m[1], cwd: JSON.parse(`"${m[2]}"`) };
    }
    catch {
        return null;
    }
}
function findCodexSession(cwd, fragments) {
    const root = path.join(os.homedir(), ".codex", "sessions");
    const rollouts = [];
    try {
        const dateDirs = (dir, re) => fs.readdirSync(dir).filter((d) => re.test(d)).sort().reverse();
        outer: for (const y of dateDirs(root, /^\d{4}$/)) {
            for (const m of dateDirs(path.join(root, y), /^\d{2}$/)) {
                for (const d of dateDirs(path.join(root, y, m), /^\d{2}$/)) {
                    const dayDir = path.join(root, y, m, d);
                    for (const f of fs.readdirSync(dayDir)) {
                        if (f.startsWith("rollout-") && f.endsWith(".jsonl")) {
                            const file = path.join(dayDir, f);
                            rollouts.push({ file, mtime: fs.statSync(file).mtimeMs });
                        }
                    }
                    if (rollouts.length >= MAX_ROLLOUT_SCAN)
                        break outer;
                }
            }
        }
    }
    catch {
        return null;
    }
    const candidates = [];
    for (const r of rollouts.sort((a, b) => b.mtime - a.mtime)) {
        if (candidates.length >= MAX_CANDIDATES)
            break;
        const meta = readRolloutMeta(r.file);
        if (meta && meta.cwd === cwd)
            candidates.push({ id: meta.id, file: r.file });
    }
    const scored = candidates.map((c) => ({ id: c.id, hits: scoreFile(c.file, fragments) }));
    return pickConfident(scored, fragments.length);
}
function registerAgentSessionHandlers() {
    electron_1.ipcMain.handle("agent.findResumeSession", (_event, req) => {
        const { brand, cwd } = req || {};
        const fragments = Array.isArray(req?.fragments)
            ? req.fragments.filter((f) => typeof f === "string" && f.length >= 8).slice(0, 16)
            : [];
        if (!cwd || fragments.length < 2)
            return null;
        try {
            const sessionId = brand === "claude" ? findClaudeSession(cwd, fragments)
                : brand === "codex" ? findCodexSession(cwd, fragments)
                    : null;
            return sessionId ? { sessionId } : null;
        }
        catch {
            return null;
        }
    });
}
//# sourceMappingURL=agentSessions.js.map