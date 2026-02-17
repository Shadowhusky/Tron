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

/**
 * Returns true if the input contains natural language patterns anywhere.
 * Checks for English glue words in any position beyond the first word.
 */
function hasNaturalLanguagePattern(words: string[]): boolean {
  if (words.length < 2) return false;
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

// Unambiguous commands (never English verbs in common usage)
const UNAMBIGUOUS_COMMANDS = new Set([
  "cd",
  "ls",
  "pwd",
  "mkdir",
  "rm",
  "cp",
  "mv",
  "touch",
  "cat",
  "less",
  "head",
  "tail",
  "find",
  "grep",
  "git",
  "npm",
  "node",
  "yarn",
  "pnpm",
  "bun",
  "docker",
  "kubectl",
  "ssh",
  "scp",
  "curl",
  "wget",
  "echo",
  "printf",
  "history",
  "clear",
  "exit",
  "source",
  "export",
  "unset",
  "env",
  "vi",
  "vim",
  "nano",
  "code",
  "python",
  "python3",
  "pip",
  "pip3",
  "top",
  "htop",
  "ps",
  "kill",
  "sudo",
  "chmod",
  "chown",
  "tar",
  "zip",
  "unzip",
  "brew",
  "apt",
  "which",
  "man",
  // Expanded list
  "ollama",
  "go",
  "cargo",
  "rustc",
  "ruby",
  "gem",
  "rails",
  "php",
  "composer",
  "dotnet",
  "terraform",
  "ansible",
  "npx",
  "make",
  "cmake",
  "gradle",
  "mvn",
  "ant",
  "java",
  "javac",
  "perl",
  "lua",
  "r",
  "swift",
  "scala",
  "kotlin",
]);

export function isKnownExecutable(word: string): boolean {
  return UNAMBIGUOUS_COMMANDS.has(word);
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
