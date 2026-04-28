"use strict";
/**
 * Agent Skills loader — discovers and reads SKILL.md files from the
 * directories Anthropic, Warp, Claude Code, Cursor, Codex, etc. all read
 * from. The format is the published Anthropic Agent Skills convention:
 * `<dir>/<skill-name>/SKILL.md` with YAML front-matter. By scanning
 * multiple well-known parent directories, Tron gives users free interop
 * with their existing skill libraries — no rewrite required.
 *
 * Pattern reference: warp/crates/ai/src/skills/skill_provider.rs (which
 * enumerates Warp/Agents/Claude/Codex/Cursor/Gemini/Copilot/Droid/Github/
 * OpenCode as candidate parent directories) and warp/crates/ai/src/skills/
 * parse_skill.rs (which defines the SKILL.md YAML front-matter schema).
 */
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
exports.registerSkillsHandlers = registerSkillsHandlers;
const electron_1 = require("electron");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
/** Standard skill directory names checked under both the project cwd and
 *  the user's home directory. Matches the published convention so users
 *  bring their existing libraries without moving files. */
const SKILL_PARENT_DIRS = [
    ".tron/skills",
    ".agents/skills",
    ".claude/skills",
    ".codex/skills",
    ".cursor/skills",
    ".warp/skills",
    ".github/skills",
];
/**
 * Parse the YAML front-matter at the top of a SKILL.md file. We don't pull
 * in a full YAML library — front-matter for skills is well-constrained
 * (`name`, `description`, optional `version`/`license`/`activation`), and
 * a small line-based parser handles everything we care about while keeping
 * the binary lean.
 */
function parseFrontMatter(text) {
    // Front-matter must be the very first thing in the file: `---\n…\n---\n`.
    if (!text.startsWith("---"))
        return {};
    const end = text.indexOf("\n---", 3);
    if (end < 0)
        return {};
    const body = text.slice(3, end).trim();
    const out = {};
    let collecting = null;
    let collected = "";
    for (const rawLine of body.split(/\r?\n/)) {
        // YAML continuation: a line indented relative to the previous key
        // belongs to that key's value (covers multi-line description: > blocks).
        const indented = /^\s+\S/.test(rawLine);
        if (indented && collecting) {
            collected += " " + rawLine.trim();
            continue;
        }
        // Flush any prior multi-line value
        if (collecting) {
            out[collecting] = collected.replace(/\s+/g, " ").trim();
            collecting = null;
            collected = "";
        }
        const m = rawLine.match(/^(\w+)\s*:\s*(.*)$/);
        if (!m)
            continue;
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        if (key !== "name" && key !== "description")
            continue;
        if (value === "" || value === ">" || value === "|") {
            // Multi-line scalar follows
            collecting = key;
            collected = "";
            continue;
        }
        // Strip surrounding quotes if present
        out[key] = value.replace(/^["']|["']$/g, "");
    }
    if (collecting) {
        out[collecting] = collected.replace(/\s+/g, " ").trim();
    }
    return out;
}
/**
 * Walk one skill parent directory (e.g. `~/foo/.claude/skills/`) and
 * yield each immediate child subdirectory that contains a SKILL.md.
 */
function discoverInParent(parent, source) {
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(parent, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const skillDir = path.join(parent, entry.name);
        // SKILL.md or skill.md (case variations seen in the wild)
        const skillFile = ["SKILL.md", "skill.md", "Skill.md"]
            .map((n) => path.join(skillDir, n))
            .find((p) => fs.existsSync(p));
        if (!skillFile)
            continue;
        let content;
        try {
            content = fs.readFileSync(skillFile, "utf-8");
        }
        catch {
            continue;
        }
        const fm = parseFrontMatter(content);
        out.push({
            name: fm.name || entry.name,
            description: fm.description || "",
            path: skillFile,
            source,
        });
    }
    return out;
}
/**
 * Discover skills from both the project cwd and the user's home directory.
 * Project-local skills take precedence on name collision.
 */
function discoverSkills(cwd) {
    const home = electron_1.app.getPath("home");
    const projectRoot = cwd || process.cwd();
    const seen = new Map();
    const sources = [];
    // Project-scoped first so they win on name collision
    for (const sub of SKILL_PARENT_DIRS) {
        sources.push({ root: path.join(projectRoot, sub), tag: sub });
    }
    for (const sub of SKILL_PARENT_DIRS) {
        sources.push({ root: path.join(home, sub), tag: `~/${sub}` });
    }
    for (const { root, tag } of sources) {
        for (const skill of discoverInParent(root, tag)) {
            if (!seen.has(skill.name))
                seen.set(skill.name, skill);
        }
    }
    return [...seen.values()];
}
function registerSkillsHandlers() {
    electron_1.ipcMain.handle("skills.discover", async (_event, { cwd }) => {
        try {
            return discoverSkills(cwd);
        }
        catch {
            return [];
        }
    });
    electron_1.ipcMain.handle("skills.read", async (_event, { path: filePath }) => {
        try {
            // Cap at 256KB — skill bodies should be well under that, anything
            // larger is probably someone trying to weaponise read_skill as a
            // file-reader. Use read_file for general-purpose reads.
            const stat = fs.statSync(filePath);
            if (stat.size > 256 * 1024) {
                return { success: false, error: `Skill file too large (${stat.size} bytes; max 256KB)` };
            }
            const content = fs.readFileSync(filePath, "utf-8");
            return { success: true, content };
        }
        catch (err) {
            return { success: false, error: err.message };
        }
    });
}
//# sourceMappingURL=skills.js.map