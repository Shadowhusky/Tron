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

export function isCommand(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  const words = trimmed.split(/\s+/);
  const firstWord = words[0];

  // Path-based invocations are always commands
  if (firstWord.startsWith("./") || firstWord.startsWith("/")) return true;

  // Explicit command syntax overrides everything
  if (hasCommandSyntax(trimmed, words)) return true;

  // If natural language is detected anywhere, it's a prompt
  if (hasNaturalLanguagePattern(words)) return false;

  // Unambiguous commands (never English verbs in common usage)
  const unambiguousCommands = new Set([
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
  ]);
  if (unambiguousCommands.has(firstWord)) return true;

  // Single unknown word — could be a command; let shell check decide
  if (words.length === 1) return false;

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
