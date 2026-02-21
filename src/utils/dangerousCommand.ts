/**
 * Smart dangerous command detection.
 *
 * Commands flagged here always require explicit user confirmation,
 * even when auto-execution is enabled.
 */

// ── Pattern-based detection ────────────────────────────────────────────

const DANGEROUS_PATTERNS: RegExp[] = [
  // ─── File/directory deletion ───
  /\brm\s+(-[a-zA-Z]*)?.*(-r|-f|--force|--recursive|\*)/, // rm with destructive flags or glob
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/,                         // rm -rf combined
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/,                         // rm -fr combined
  /\brm\s+(-[a-zA-Z]*\s+)*\/(?!tmp\b)/,                   // rm targeting root paths (except /tmp)
  /\bsudo\s+rm\b/,                                         // sudo rm anything
  /\bfind\s.*-delete\b/,                                   // find -delete
  /\bfind\s.*-exec\s+rm\b/,                                // find -exec rm

  // ─── Filesystem-level destruction ───
  /\bmkfs\b/,                                              // format filesystem
  /\bdd\s+.*of=/,                                          // dd write to device/file
  />\s*\/dev\/(sda|hda|nvme|disk|vd)/,                     // redirect to raw device

  // ─── System power / process kill ───
  /\b(shutdown|reboot|halt|poweroff)\b/,                   // system power commands
  /\bkill\s+-9\s+-1\b/,                                    // kill all processes
  /\bkillall\s/,                                           // killall (mass process kill)
  /\bpkill\s+-9\b/,                                        // pkill -9

  // ─── Permission / ownership changes ───
  /\bchmod\s+(-R\s+)?[0-7]*777\b/,                        // world-writable permissions
  /\bchown\s+-R\b/,                                        // recursive ownership change
  /\bchmod\s+-R\b/,                                        // recursive permission change

  // ─── Git destructive operations ───
  /\bgit\s+push\s+.*--force\b/,                            // force push
  /\bgit\s+push\s+-f\b/,                                   // force push shorthand
  /\bgit\s+reset\s+--hard\b/,                              // hard reset
  /\bgit\s+clean\s+-[a-zA-Z]*f/,                           // git clean -f
  /\bgit\s+branch\s+-D\b/,                                 // force delete branch
  /\bgit\s+checkout\s+\.\s*$/,                             // discard all changes
  /\bgit\s+restore\s+\.\s*$/,                              // discard all changes

  // ─── Database destructive ───
  /\b(drop|truncate)\s+(database|table|schema|collection)\b/i,
  /\bDELETE\s+FROM\s+\w+\s*;\s*$/i,                       // DELETE without WHERE
  /\bdb\.\w+\.(drop|remove)\(/i,                           // MongoDB drop/remove

  // ─── Package manager destructive ───
  /\bnpm\s+uninstall\s+-g\b/,                              // global npm uninstall
  /\bpip\s+uninstall\b/,                                   // pip uninstall
  /\bbrew\s+uninstall\b/,                                  // brew uninstall

  // ─── Container / infra destructive ───
  /\bdocker\s+(rm|rmi)\s/,                                 // docker remove containers/images
  /\bdocker\s+system\s+prune\b/,                           // docker system prune
  /\bdocker\s+volume\s+rm\b/,                              // docker volume remove
  /\bkubectl\s+delete\b/,                                  // k8s delete resources

  // ─── Remote code execution / injection ───
  /\bcurl\s.*\|\s*(sudo\s+)?(ba)?sh\b/,                   // curl pipe to shell
  /\bwget\s.*\|\s*(sudo\s+)?(ba)?sh\b/,                   // wget pipe to shell
  /\bcurl\s.*\|\s*(sudo\s+)?python/,                       // curl pipe to python
  /\beval\s*\(/,                                           // eval()

  // ─── Miscellaneous destructive ───
  /\b:()\s*\{\s*:\|:&\s*\}\s*;\s*:/,                      // fork bomb
  /\bmv\s+.*\s+\/dev\/null\b/,                             // move to /dev/null
  />\s*\/etc\//,                                           // overwrite system config
  /\blaunchctl\s+(unload|remove)\b/,                       // macOS service removal
  /\bsystemctl\s+(disable|mask|stop)\b/,                   // Linux service control
];

// ── Heuristic checks ───────────────────────────────────────────────────

/** sudo escalation with any modifying command */
function isSudoModify(cmd: string): boolean {
  if (!/\bsudo\s/.test(cmd)) return false;
  // sudo with safe read commands is fine
  const safeAfterSudo = /\bsudo\s+(cat|ls|less|head|tail|grep|find|which|whoami|id|ps|top|df|du|mount|lsof|stat|file|wc|sort|uniq|diff)\b/;
  return !safeAfterSudo.test(cmd);
}

/** Redirect that overwrites (> not >>) important files */
function isDestructiveRedirect(cmd: string): boolean {
  // Single > (overwrite) to a path that isn't /dev/null or a temp file
  const overwriteMatch = cmd.match(/(?<![>|])>\s*([^\s>|&]+)/);
  if (!overwriteMatch) return false;
  const target = overwriteMatch[1];
  // Overwriting system paths is dangerous
  if (/^\/(etc|usr|bin|sbin|lib|boot|sys|proc)\//.test(target)) return true;
  // Overwriting dotfiles like .bashrc, .zshrc, .gitconfig
  if (/\/\.(bash|zsh|fish|profile|gitconfig|ssh)/.test(target)) return true;
  return false;
}

/** Commands that wipe environment or shell config */
function isEnvDestruction(cmd: string): boolean {
  return /\bunset\s+-f\b/.test(cmd) || /\benv\s+-i\b/.test(cmd);
}

// ── Public API ─────────────────────────────────────────────────────────

export function isDangerousCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!trimmed) return false;

  // Check regex patterns
  if (DANGEROUS_PATTERNS.some((p) => p.test(trimmed))) return true;

  // Check heuristics
  if (isSudoModify(trimmed)) return true;
  if (isDestructiveRedirect(trimmed)) return true;
  if (isEnvDestruction(trimmed)) return true;

  return false;
}
