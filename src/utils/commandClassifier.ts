// Common English glue words that never appear as shell arguments
const NL_INDICATORS = new Set([
  "the",
  "a",
  "an",
  "my",
  "me",
  "i",
  "you",
  "your",
  "we",
  "our",
  "its",
  "his",
  "her",
  "their",
  "all",
  "some",
  "any",
  "how",
  "what",
  "where",
  "why",
  "when",
  "which",
  "who",
  "if",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "has",
  "have",
  "had",
  "will",
  "would",
  "could",
  "should",
  "shall",
  "might",
  "may",
  "can",
  "cannot",
  "and",
  "or",
  "but",
  "for",
  "to",
  "in",
  "of",
  "on",
  "at",
  "by",
  "with",
  "from",
  "about",
  "into",
  "that",
  "this",
  "these",
  "those",
  "it",
  "out",
  "up",
  "not",
  "don't",
  "doesn't",
  "didn't",
  "isn't",
  "aren't",
  "won't",
  "can't",
  "couldn't",
  "shouldn't",
  "wouldn't",
  "there",
  "then",
  "than",
  "also",
  "just",
  "like",
  "still",
  "already",
  "currently",
  "please",
  "need",
  "want",
  "try",
  "know",
  "think",
  "look",
  "see",
  "give",
  "get",
  "let",
  "something",
  "anything",
  "everything",
  "nothing",
]);

// Words that almost always start a natural language question/request,
// even though some (e.g. "what") are real executables on macOS/BSD.
const QUESTION_STARTERS = new Set([
  "what",
  "why",
  "how",
  "where",
  "when",
  "who",
  "can",
  "could",
  "should",
  "would",
  "will",
  "does",
  "do",
  "is",
  "are",
  "was",
  "were",
  "has",
  "have",
  "please",
  "tell",
  "explain",
  "describe",
  "show",
  "help",
  "list",
]);

/**
 * Returns true if the input contains natural language patterns anywhere.
 * Checks for English glue words in any position beyond the first word.
 */
function hasNaturalLanguagePattern(words: string[]): boolean {
  if (words.length < 2) return false;

  // If the first word is a question/request starter, it's natural language
  if (QUESTION_STARTERS.has(words[0].toLowerCase())) return true;

  // Check if any word (after the first) is a natural language indicator
  let nlCount = 0;
  for (let i = 1; i < words.length; i++) {
    if (NL_INDICATORS.has(words[i].toLowerCase())) nlCount++;
  }
  // If 2+ NL words, or if the second word is NL, it's natural language
  return nlCount >= 2 || NL_INDICATORS.has(words[1].toLowerCase());
}

/**
 * Returns true if the input has shell command syntax (flags, paths, pipes, etc.)
 */
function hasCommandSyntax(input: string, words: string[]): boolean {
  // Pipe, redirect, chain, semicolon
  if (/[|><;&]/.test(input)) return true;
  // Any word starts with - (flag) or ./ or / or ~ (path)
  for (let i = 1; i < words.length; i++) {
    if (/^[-./~$]/.test(words[i])) return true;
  }
  return false;
}

/**
 * Returns true if the input looks like a pasted error message rather than a command.
 * Examples: "zsh: command not found: foo", "Error: failed to connect", etc.
 */
function isLikelyErrorPaste(input: string): boolean {
  const lower = input.toLowerCase();
  const errorPatterns = [
    "command not found",
    "no such file or directory",
    "permission denied",
    "connection refused",
    "fatal error",
    "syntax error",
    "uncaught exception",
    "traceback (most recent call last)",
    "error:",
    "fatal:",
    "exception:",
    "stack trace:",
  ];
  return errorPatterns.some((pattern) => lower.includes(pattern));
}

// Imperative verbs: words that exist in PATH (e.g. /usr/bin/install) but are
// almost always natural-language requests when followed by a plain noun.
const IMPERATIVE_VERBS = new Set([
  "install", "uninstall", "reinstall",
  "setup", "configure",
  "deploy", "upgrade", "downgrade",
  "enable", "disable",
  "update", "add", "remove",
  "fix", "debug", "troubleshoot",
  "create", "init", "initialize",
  "start", "stop", "restart",
  "build", "compile", "run",
]);

/**
 * Returns true if the input looks like an imperative natural-language request
 * (e.g. "install nvm", "setup docker") rather than a real shell command.
 * Single-word inputs return false (let shell decide).
 * Inputs with shell syntax (flags, pipes, paths) return false.
 */
export function isLikelyImperative(input: string): boolean {
  const words = input.trim().split(/\s+/);
  if (words.length < 2) return false;
  if (!IMPERATIVE_VERBS.has(words[0].toLowerCase())) return false;
  // If remaining args have shell syntax (flags, paths, pipes), it's a real command
  return !hasCommandSyntax(input, words);
}

// Unambiguous commands — names that are never English verbs/nouns in common
// usage.  This is the fast-path baseline; the dynamic scan (phase 2) and live
// `which` check (phase 3) cover everything else.
const UNAMBIGUOUS_COMMANDS = new Set([
  // ── Shell builtins & core POSIX ────────────────────────────────────────
  "cd", "ls", "pwd", "mkdir", "rmdir", "rm", "cp", "mv", "ln",
  "touch", "cat", "less", "more", "head", "tail", "tee",
  "echo", "printf", "readlink", "realpath", "basename", "dirname",
  "find", "grep", "egrep", "fgrep", "sed", "awk", "sort", "uniq",
  "wc", "tr", "cut", "paste", "xargs", "tee",
  "chmod", "chown", "chgrp", "chflags", "umask",
  "diff", "comm", "cmp", "patch",
  "source", "export", "unset", "alias", "unalias",
  "history", "clear", "exit", "logout", "exec",
  "env", "printenv", "which", "whence", "whereis", "type",
  "man", "info", "apropos",
  "true", "false", "yes", "test",
  "sleep", "date", "cal", "bc",
  "whoami", "id", "groups", "hostname", "uname",
  "sudo", "su", "doas",

  // ── File & Disk ────────────────────────────────────────────────────────
  "tar", "zip", "unzip", "gzip", "gunzip", "bzip2", "xz", "zstd",
  "file", "stat", "dd", "df", "du", "mount", "umount",
  "rsync", "scp", "sftp",
  "mdls", "mdfind", "xattr",                  // macOS
  "lsblk", "fdisk", "mkfs",                   // Linux

  // ── Process & System ───────────────────────────────────────────────────
  "ps", "kill", "killall", "pkill", "pgrep",
  "top", "htop", "btop", "atop",
  "lsof", "fuser", "nohup", "disown", "jobs", "fg", "bg", "wait",
  "nice", "renice", "ionice",
  "strace", "dtrace", "ltrace",               // tracing
  "dmesg", "journalctl", "sysctl", "systemctl", "launchctl",
  "crontab", "at",
  "uptime", "free", "vmstat", "iostat",

  // ── Network ────────────────────────────────────────────────────────────
  "curl", "wget", "httpie",
  "ssh", "ssh-keygen", "ssh-add", "ssh-agent",
  "ping", "traceroute", "mtr", "dig", "nslookup", "host",
  "nc", "ncat", "netcat", "socat",
  "netstat", "ss", "ip", "ifconfig", "route", "arp",
  "iptables", "nft", "ufw",
  "telnet", "ftp",
  "openssl",

  // ── Git & VCS ──────────────────────────────────────────────────────────
  "git", "gh", "hub",
  "svn", "hg",

  // ── Editors ────────────────────────────────────────────────────────────
  "vi", "vim", "nvim", "nano", "emacs", "pico",
  "code", "subl", "atom", "zed",
  "ed", "ex",

  // ── JavaScript / TypeScript ────────────────────────────────────────────
  "node", "npm", "npx", "yarn", "pnpm", "bun", "bunx",
  "deno", "tsx", "ts-node",
  "esbuild", "vite", "webpack", "rollup", "parcel", "turbo",
  "eslint", "prettier", "tsc", "swc",
  "jest", "vitest", "mocha", "cypress", "playwright",
  "next", "nuxt", "astro", "svelte-kit", "remix",

  // ── Python ─────────────────────────────────────────────────────────────
  "python", "python3", "python2",
  "pip", "pip3", "pipx",
  "poetry", "pipenv", "pdm", "uv", "hatch",
  "pytest", "mypy", "ruff", "black", "isort", "flake8",
  "jupyter", "ipython",
  "django-admin", "flask", "uvicorn", "gunicorn", "celery",

  // ── Ruby ───────────────────────────────────────────────────────────────
  "ruby", "gem", "bundle", "bundler",
  "rails", "rake", "rspec", "irb",

  // ── Go ─────────────────────────────────────────────────────────────────
  "go", "gofmt", "golint", "gopls",

  // ── Rust ───────────────────────────────────────────────────────────────
  "cargo", "rustc", "rustfmt", "clippy",

  // ── Java / JVM ─────────────────────────────────────────────────────────
  "java", "javac", "jar", "jshell",
  "gradle", "gradlew", "mvn", "ant", "sbt",
  "kotlin", "kotlinc", "scala", "scalac", "groovy", "clojure",

  // ── C / C++ ────────────────────────────────────────────────────────────
  "gcc", "g++", "cc", "c++", "clang", "clang++",
  "make", "cmake", "ninja", "meson", "autoconf", "automake",
  "gdb", "lldb", "valgrind",
  "ld", "ldd", "nm", "objdump", "strip",

  // ── Other languages ────────────────────────────────────────────────────
  "php", "composer", "artisan",
  "perl", "cpan",
  "lua", "luarocks",
  "r", "Rscript",
  "swift", "swiftc", "xcodebuild", "xcrun",
  "elixir", "mix", "iex",
  "erlang", "erl", "rebar3",
  "haskell", "ghc", "ghci", "cabal", "stack",
  "zig", "nim", "crystal", "v",
  "dart", "pub",
  "dotnet", "csc",
  "julia",
  "ocaml", "opam",

  // ── Package managers (system) ──────────────────────────────────────────
  "brew", "apt", "apt-get", "dpkg",
  "yum", "dnf", "rpm", "zypper",
  "pacman", "yay", "paru",
  "snap", "flatpak", "nix", "nix-env",
  "port",                                       // macOS MacPorts
  "choco", "scoop", "winget",                   // Windows
  "pkg",                                         // FreeBSD / Termux

  // ── Containers & Orchestration ─────────────────────────────────────────
  "docker", "docker-compose", "podman", "buildah", "skopeo",
  "kubectl", "k9s", "minikube", "kind", "microk8s",
  "helm", "kustomize", "istioctl", "argocd",
  "vagrant",

  // ── Cloud & IaC ────────────────────────────────────────────────────────
  "aws", "gcloud", "az", "doctl", "linode-cli",
  "terraform", "tofu", "pulumi", "cdktf",
  "ansible", "ansible-playbook",
  "packer", "vault", "consul", "nomad",
  "serverless", "sam", "cdk",
  "fly", "vercel", "netlify", "heroku", "railway", "render",
  "wrangler",                                    // Cloudflare

  // ── Databases ──────────────────────────────────────────────────────────
  "mysql", "psql", "sqlite3", "mongosh", "mongo", "redis-cli",
  "pgcli", "mycli", "litecli",
  "prisma", "drizzle-kit", "sequelize",

  // ── DevOps & CI tools ──────────────────────────────────────────────────
  "nginx", "caddy", "apache2", "httpd",
  "pm2", "forever", "supervisor",
  "tmux", "screen", "byobu",
  "jq", "yq", "xq", "fx",                      // JSON/YAML/XML
  "fzf", "rg", "fd", "bat", "eza", "exa", "zoxide",  // modern CLI
  "tree", "watch", "entr", "parallel",
  "age", "gpg", "ssh-keygen",
  "certbot", "mkcert",

  // ── AI / ML ────────────────────────────────────────────────────────────
  "ollama",
  "transformers-cli", "huggingface-cli",

  // ── Version / environment managers (often shell functions) ─────────────
  "nvm", "fnm", "n",
  "pyenv", "virtualenv", "venv",
  "rbenv", "rvm", "chruby",
  "sdkman", "jabba",
  "asdf", "mise", "rtx",
  "volta", "rustup",
  "conda", "mamba", "micromamba",
  "goenv", "nodenv",
  "direnv",

  // ── Mobile ─────────────────────────────────────────────────────────────
  "flutter", "dart",
  "react-native", "expo",
  "adb", "fastboot", "emulator",
  "pod", "xcodebuild", "xcrun",
  "gradle", "gradlew",

  // ── Misc tools ─────────────────────────────────────────────────────────
  "ffmpeg", "ffprobe", "imagemagick", "convert",
  "pandoc", "latex", "pdflatex",
  "graphviz", "dot",
  "gh", "hub", "gitlab",
  "stripe", "twilio",
  "ngrok", "localtunnel",
]);

// Dynamic command set populated by system scan
let scannedCommands: Set<string> | null = null;

/** Load scanned commands from a system scan result. */
export function loadScannedCommands(commands: string[]) {
  scannedCommands = new Set(commands.map((c) => c.toLowerCase()));
}

/** Clear the scanned commands cache so next scan starts fresh. */
export function invalidateScannedCommands() {
  scannedCommands = null;
}

/** Check if a word is in the scanned commands list. */
export function isScannedCommand(word: string): boolean {
  return scannedCommands?.has(word.toLowerCase()) ?? false;
}

export function isKnownExecutable(word: string): boolean {
  return UNAMBIGUOUS_COMMANDS.has(word);
}

/** Return commands matching a prefix from the static list + scanned cache. */
export function getCommandCompletions(prefix: string, limit = 10): string[] {
  if (!prefix) return [];
  const lower = prefix.toLowerCase();
  const matches: string[] = [];
  // Exact match first — so the user can just Tab/Enter to confirm
  if (UNAMBIGUOUS_COMMANDS.has(lower) || scannedCommands?.has(lower)) {
    matches.push(lower);
  }
  // Static list (instant, most common)
  for (const cmd of UNAMBIGUOUS_COMMANDS) {
    if (cmd.startsWith(lower) && cmd !== lower) matches.push(cmd);
    if (matches.length >= limit) return matches;
  }
  // Then scanned commands
  if (scannedCommands) {
    for (const cmd of scannedCommands) {
      if (cmd.startsWith(lower) && cmd !== lower && !UNAMBIGUOUS_COMMANDS.has(cmd)) {
        matches.push(cmd);
      }
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

export function isCommand(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;

  // If it looks like an error paste, it's definitely for the agent,
  // even if it starts with a command name (e.g. "docker: command not found")
  if (isLikelyErrorPaste(trimmed)) return false;

  const words = trimmed.split(/\s+/);
  const firstWord = words[0];

  // Path-based invocations are always commands
  if (firstWord.startsWith("./") || firstWord.startsWith("/")) return true;

  // Explicit command syntax overrides everything
  if (hasCommandSyntax(trimmed, words)) return true;

  // If natural language is detected anywhere, it's a prompt
  if (hasNaturalLanguagePattern(words)) return false;

  if (isKnownExecutable(firstWord)) {
    // Special handling for ambiguous words that are technically commands but often used as natural language
    // e.g. "find ollama", "check status", "search for file"
    const AMBIGUOUS_VERBS = new Set(["find", "check", "search"]);

    if (AMBIGUOUS_VERBS.has(firstWord)) {
      // If ambiguous verb, ONLY treat as command if it has clear shell syntax (flags or paths)
      // Otherwise assume it's a natural language query for the agent
      const hasFlags = words.some((w) => w.startsWith("-"));
      const hasPaths = words.some(
        (w) => w.includes("/") || w === "." || w === "~",
      );
      if (!hasFlags && !hasPaths) {
        return false; // Treat as agent prompt
      }
    }
    return true;
  }

  // Single unknown word — could be a command; let shell check decide
  if (words.length === 1) {
    // Heuristic: words with dashes (kebab-case) or underscores (snake_case)
    // or scoped packages (@scope/pkg) are likely commands/tools, not natural language.
    // e.g. "create-react-app", "docker-compose", "apt-get", "@antigravity/cli"
    if (/^@?[a-zA-Z0-9]+[-_][a-zA-Z0-9-_]+/.test(firstWord)) return true;

    return false;
  }

  // Multi-word with unknown first word — almost certainly a prompt
  return false;
}

/**
 * Exported for the auto-mode fallback: even if `which` finds the word
 * as an executable, this returns true if the input is clearly NL.
 */
export function isDefinitelyNaturalLanguage(input: string): boolean {
  const words = input.trim().split(/\s+/);
  return hasNaturalLanguagePattern(words);
}

// Commands that need a real terminal for interactive use (TUI, REPL, editor, etc.)
const INTERACTIVE_EXECUTABLES = new Set([
  // Editors
  "vi", "vim", "nvim", "nano", "emacs", "pico", "ed", "ex",
  // Pagers / TUI
  "less", "more", "man", "top", "htop", "btop", "atop", "k9s",
  // REPLs
  "python", "python3", "node", "irb", "ruby", "lua", "ghci", "iex",
  "ipython", "julia", "erl", "r",
  // DB shells
  "mysql", "psql", "sqlite3", "mongosh", "mongo", "redis-cli",
  "pgcli", "mycli", "litecli",
  // Remote / network
  "ssh", "telnet", "ftp", "sftp",
  // Debuggers
  "gdb", "lldb",
  // Multiplexers
  "tmux", "screen", "byobu",
]);

const INTERACTIVE_PREFIXES = [
  // Scaffolding tools (prompt for input)
  "npm create", "npx create", "npm init", "yarn create", "pnpm create", "bun create",
  // Dev servers (long-running)
  "npm run dev", "npm start", "npm run start", "yarn dev", "yarn start",
  "pnpm dev", "pnpm start", "bun dev", "bun run dev",
  "npx vite", "npx next", "npx serve",
  // Docker interactive
  "docker run -it", "docker exec -it",
  // Docker compose up (long-running)
  "docker compose up", "docker-compose up",
];

/**
 * Returns true if the command likely needs an interactive terminal
 * (TUI editors, REPLs, dev servers, scaffolding tools, etc.)
 */
export function isInteractiveCommand(cmd: string): boolean {
  const trimmed = cmd.trim();
  const firstWord = trimmed.split(/\s+/)[0];
  if (INTERACTIVE_EXECUTABLES.has(firstWord)) return true;
  const lower = trimmed.toLowerCase();
  for (const prefix of INTERACTIVE_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

/** Returns true if token looks like the start of a file path */
function isPathLike(token: string): boolean {
  return (
    token.startsWith("/") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("~/")
  );
}

/**
 * Auto-quote file paths that contain spaces.
 * e.g. `cd /Users/foo/Application Support` → `cd "/Users/foo/Application Support"`
 *
 * Skips commands that already contain quotes, escapes, pipes, or other
 * shell meta-characters to avoid breaking intentional syntax.
 */
export function smartQuotePaths(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  // Skip if the command already uses quotes, backslash escapes, or shell operators
  if (/['"`\\|&;$(){}]/.test(trimmed)) return trimmed;

  const parts = trimmed.split(/\s+/);
  // Nothing to fix if single token or no multi-word path possible
  if (parts.length < 2) return trimmed;

  const result: string[] = [parts[0]];
  const args = parts.slice(1);
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    // If this looks like a path start, try to absorb subsequent non-flag,
    // non-path-start tokens that are likely space-separated path components.
    if (isPathLike(arg) && i + 1 < args.length) {
      const pathParts = [arg];
      let j = i + 1;
      while (j < args.length && !args[j].startsWith("-") && !isPathLike(args[j])) {
        pathParts.push(args[j]);
        j++;
      }
      if (pathParts.length > 1) {
        // Multiple tokens → wrap the reconstructed path in double quotes
        result.push(`"${pathParts.join(" ")}"`);
        i = j;
        continue;
      }
    }

    result.push(arg);
    i++;
  }

  return result.join(" ");
}
