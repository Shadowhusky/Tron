/**
 * Smart dangerous command detection with severity levels.
 *
 * "danger" — truly destructive / irreversible (red UI)
 * "warning" — needs review but not catastrophic (yellow UI)
 *
 * Commands flagged here always require explicit user confirmation,
 * even when auto-execution is enabled.
 */

export type DangerLevel = "danger" | "warning";

export interface DangerResult {
  level: DangerLevel;
  reason: string;
}

// ── Pattern-based detection ────────────────────────────────────────────

interface DangerRule {
  pattern: RegExp;
  level: DangerLevel;
  reason: string;
}

const RULES: DangerRule[] = [
  // ─── File/directory deletion (danger) ───
  { pattern: /\brm\s+(-[a-zA-Z]*)?.*(-r|-f|--force|--recursive|\*)/,
    level: "danger", reason: "Recursive or forced file deletion" },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/,
    level: "danger", reason: "rm -rf can permanently delete files" },
  { pattern: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/,
    level: "danger", reason: "rm -fr can permanently delete files" },
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*\/(?!tmp\b)/,
    level: "danger", reason: "Deleting from root filesystem path" },
  { pattern: /\bsudo\s+rm\b/,
    level: "danger", reason: "Elevated file deletion" },
  { pattern: /\bfind\s.*-delete\b/,
    level: "danger", reason: "find -delete can bulk-remove files" },
  { pattern: /\bfind\s.*-exec\s+rm\b/,
    level: "danger", reason: "find -exec rm can bulk-remove files" },

  // ─── Filesystem-level destruction (danger) ───
  { pattern: /\bmkfs\b/,
    level: "danger", reason: "Formats a filesystem — destroys all data" },
  { pattern: /\bdd\s+.*of=/,
    level: "danger", reason: "dd writes raw data to a device or file" },
  { pattern: />\s*\/dev\/(sda|hda|nvme|disk|vd)/,
    level: "danger", reason: "Redirect to raw disk device" },

  // ─── System power / process kill ───
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/,
    level: "danger", reason: "System power command" },
  { pattern: /\bkill\s+-9\s+-1\b/,
    level: "danger", reason: "Kills all user processes" },
  { pattern: /\bkillall\s/,
    level: "warning", reason: "Mass process termination" },
  { pattern: /\bpkill\s+-9\b/,
    level: "warning", reason: "Force-kills matching processes" },

  // ─── Permission / ownership changes ───
  { pattern: /\bchmod\s+(-R\s+)?[0-7]*777\b/,
    level: "warning", reason: "Sets world-writable permissions" },
  { pattern: /\bchown\s+-R\b/,
    level: "warning", reason: "Recursive ownership change" },
  { pattern: /\bchmod\s+-R\b/,
    level: "warning", reason: "Recursive permission change" },

  // ─── Git destructive operations ───
  { pattern: /\bgit\s+push\s+.*--force\b/,
    level: "danger", reason: "Force push can overwrite remote history" },
  { pattern: /\bgit\s+push\s+-f\b/,
    level: "danger", reason: "Force push can overwrite remote history" },
  { pattern: /\bgit\s+reset\s+--hard\b/,
    level: "danger", reason: "Hard reset discards uncommitted changes" },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/,
    level: "warning", reason: "Removes untracked files" },
  { pattern: /\bgit\s+branch\s+-D\b/,
    level: "warning", reason: "Force-deletes a branch" },
  { pattern: /\bgit\s+checkout\s+\.\s*$/,
    level: "warning", reason: "Discards all unstaged changes" },
  { pattern: /\bgit\s+restore\s+\.\s*$/,
    level: "warning", reason: "Discards all unstaged changes" },

  // ─── Database destructive ───
  { pattern: /\b(drop|truncate)\s+(database|table|schema|collection)\b/i,
    level: "danger", reason: "Drops or truncates database objects" },
  { pattern: /\bDELETE\s+FROM\s+\w+\s*;\s*$/i,
    level: "danger", reason: "DELETE without WHERE — removes all rows" },
  { pattern: /\bdb\.\w+\.(drop|remove)\(/i,
    level: "danger", reason: "MongoDB drop/remove operation" },

  // ─── Package manager ───
  { pattern: /\bnpm\s+uninstall\s+-g\b/,
    level: "warning", reason: "Removes a global npm package" },
  { pattern: /\bpip\s+uninstall\b/,
    level: "warning", reason: "Removes a Python package" },
  { pattern: /\bbrew\s+uninstall\b/,
    level: "warning", reason: "Removes a Homebrew package" },

  // ─── Container / infra ───
  { pattern: /\bdocker\s+(rm|rmi)\s/,
    level: "warning", reason: "Removes Docker containers or images" },
  { pattern: /\bdocker\s+system\s+prune\b/,
    level: "warning", reason: "Prunes unused Docker resources" },
  { pattern: /\bdocker\s+volume\s+rm\b/,
    level: "warning", reason: "Removes Docker volumes (data loss)" },
  { pattern: /\bkubectl\s+delete\b/,
    level: "warning", reason: "Deletes Kubernetes resources" },

  // ─── Remote code execution / injection ───
  // Pipes to `bash` / `sh` / `zsh` with NO further argument (or only `-`,
  // `-s`, `-i`, `-l` which all read from stdin). Whitelist explicit script
  // arguments — `curl URL | bash script.sh` doesn't actually evaluate the
  // curl payload as code.
  { pattern: /\bcurl\s[^|]*\|\s*(sudo\s+)?(ba|z)?sh\s*(-[silSL]\s*)*(\||;|$)/,
    level: "danger", reason: "Pipes remote content to shell execution" },
  { pattern: /\bwget\s[^|]*\|\s*(sudo\s+)?(ba|z)?sh\s*(-[silSL]\s*)*(\||;|$)/,
    level: "danger", reason: "Pipes remote content to shell execution" },
  // Pipes to Python only when Python is invoked WITHOUT -m (run named local
  // module) and WITHOUT -c (run inline code from the args). Bare `python`
  // and `python -` read the piped curl output and execute it as code;
  // `python -m json.tool`, `python -m http.server` etc. only consume the
  // pipe as data and are safe (this is the false positive that flagged the
  // benign `curl … | python3 -m json.tool` JSON-formatting idiom).
  { pattern: /\bcurl\s[^|]*\|\s*(sudo\s+)?python[0-9]*(\b(?!\s+-(?:m|c)\b))/,
    level: "danger", reason: "Pipes remote content to Python execution" },
  { pattern: /\beval\s*\(/,
    level: "warning", reason: "eval() executes arbitrary code" },

  // ─── Miscellaneous ───
  { pattern: /\b:()\s*\{\s*:\|:&\s*\}\s*;\s*:/,
    level: "danger", reason: "Fork bomb — crashes the system" },
  { pattern: /\bmv\s+.*\s+\/dev\/null\b/,
    level: "danger", reason: "Moves files to /dev/null (permanent loss)" },
  { pattern: />\s*\/etc\//,
    level: "danger", reason: "Overwrites system configuration" },
  { pattern: /\blaunchctl\s+(unload|remove)\b/,
    level: "warning", reason: "Removes a macOS system service" },
  { pattern: /\bsystemctl\s+(disable|mask|stop)\b/,
    level: "warning", reason: "Disables or stops a Linux service" },
];

// ── Heuristic checks ───────────────────────────────────────────────────

/** sudo escalation with any modifying command */
function checkSudoModify(cmd: string): DangerResult | null {
  if (!/\bsudo\s/.test(cmd)) return null;
  const safeAfterSudo = /\bsudo\s+(cat|ls|less|head|tail|grep|find|which|whoami|id|ps|top|df|du|mount|lsof|stat|file|wc|sort|uniq|diff)\b/;
  if (safeAfterSudo.test(cmd)) return null;
  return { level: "warning", reason: "Runs with elevated (sudo) privileges" };
}

/** Redirect that overwrites (> not >>) important files */
function checkDestructiveRedirect(cmd: string): DangerResult | null {
  const overwriteMatch = cmd.match(/(?<![>|])>\s*([^\s>|&]+)/);
  if (!overwriteMatch) return null;
  const target = overwriteMatch[1];
  if (/^\/(etc|usr|bin|sbin|lib|boot|sys|proc)\//.test(target))
    return { level: "danger", reason: "Overwrites a system file" };
  if (/\/\.(bash|zsh|fish|profile|gitconfig|ssh)/.test(target))
    return { level: "warning", reason: "Overwrites a shell/config dotfile" };
  return null;
}

/** Commands that wipe environment or shell config */
function checkEnvDestruction(cmd: string): DangerResult | null {
  if (/\bunset\s+-f\b/.test(cmd))
    return { level: "warning", reason: "Unsets shell functions" };
  if (/\benv\s+-i\b/.test(cmd))
    return { level: "warning", reason: "Clears the environment" };
  return null;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Classify a command's danger level and reason.
 * Returns null if the command is safe.
 */
export function classifyCommand(cmd: string): DangerResult | null {
  const trimmed = cmd.trim();
  if (!trimmed) return null;

  // Check regex patterns — return first match (rules ordered by severity)
  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) {
      return { level: rule.level, reason: rule.reason };
    }
  }

  // Check heuristics
  return (
    checkSudoModify(trimmed) ??
    checkDestructiveRedirect(trimmed) ??
    checkEnvDestruction(trimmed) ??
    null
  );
}

/**
 * Backwards-compatible boolean check.
 * Returns true if the command is flagged at any level.
 */
export function isDangerousCommand(cmd: string): boolean {
  return classifyCommand(cmd) !== null;
}
