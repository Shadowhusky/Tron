/**
 * Pure link detection for terminal output: URLs and file paths over one
 * logical (soft-wrap-joined) line, plus the string-offset ↔ buffer-cell
 * mapping the xterm link provider needs. One detector for both kinds so link
 * ranges never overlap or disagree. No DOM / xterm imports — unit-tested.
 */

export type LinkKind = "url" | "path";

export interface LinkMatch {
  /** Inclusive start / exclusive end offsets into the scanned text. */
  start: number;
  end: number;
  kind: LinkKind;
  /** Exact text the link covers (location suffix included). */
  text: string;
  url?: string;
  /** Path as printed (shell escapes kept), without the location suffix. */
  path?: string;
  line?: number;
  col?: number;
}

export const EDITOR_EXTS = new Set([
  "js","mjs","cjs","jsx","ts","mts","cts","tsx","py","pyw","json","jsonc",
  "c","h","cpp","cc","cxx","hpp","hxx","html","htm","svg","xml",
  "css","scss","less","md","mdx","rs","java","yaml","yml","toml","ini",
  "cfg","conf","sh","bash","zsh","fish","txt","log","env","sql",
  "vue","svelte","rb","php","go","swift","kt","kts",
]);
export const EDITOR_FILES = new Set(["Makefile", "Dockerfile", ".gitignore", ".dockerignore"]);
const KNOWN_EXTS = new Set([
  ...EDITOR_EXTS,
  "app","dmg","exe","pkg","deb","rpm","zip","tar","gz","bz2","xz","7z","rar","iso","img",
  "bin","so","dylib","dll","o","a","wasm","map","lock","pid","png","jpg","jpeg","gif","webp","pdf","csv",
]);

// URL body: RFC 3986 unreserved + reserved + "%", minus the apostrophe. Being
// ASCII-only, it stops at box-drawing frames, braille spinners, CJK text and
// quotes without a separate exclusion list.
const URL_CHARS = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&()*+,;=%";
const URL_RE = new RegExp(`(?<![A-Za-z0-9+.\\-])(?:https?|ftp|file):\\/\\/[${URL_CHARS}]*`, "gi");
const LOCAL_ADDR_RE = new RegExp(
  `(?<![A-Za-z0-9.\\-_/:@\\[])(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]):(\\d{2,5})(?!\\d)((?:\\/[${URL_CHARS}]*)?)`,
  "gi",
);

// Path segment chars: letters (incl. CJK), digits and the punctuation real
// project paths use — Remix ($id), Next ([id], (group)), SvelteKit (+page),
// scoped pkgs (@x), iCloud (com~apple~CloudDocs), possessives (Husky's SSD).
const SEG = "[\\p{L}\\p{N}_.$@+~\\-\\[\\]()']";
const UNIX_RUN = `(?:${SEG}|\\\\.)+`; // `\ ` / `\'` shell escapes stay inside a segment
const UNIX_INTERIOR = `${UNIX_RUN}(?: ${UNIX_RUN})*\\/`; // spaces only between two slashes
const ABS_RE = new RegExp(`(?<![A-Za-z0-9_.$@+~\\-/\\\\])~?\\/(?:${UNIX_INTERIOR})*${UNIX_RUN}`, "gu");
// Relative paths: no spaces (prose like "src/x and y/z.ts" must not fuse).
const REL_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_.$@+~\\-\\[\\]()'/\\\\])(?:\\.{1,2}\\/)?(?:${UNIX_RUN}\\/)+${UNIX_RUN}`,
  "gu",
);
const WIN_RUN = `${SEG}+`;
const WIN_RE = new RegExp(
  `(?<![A-Za-z0-9])[A-Za-z]:[\\\\/](?:${WIN_RUN}(?: ${WIN_RUN})*[\\\\/])*${WIN_RUN}`,
  "gu",
);
// Bare filename — only linked with a location suffix (`test_x.py:12`), so
// prose like "Node.js" or "package.json" stays plain text.
const BARE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_.$@+~\\-/\\\\])[\\p{L}\\p{N}_$@+~\\-][\\p{L}\\p{N}_.$@+~\\-]*\\.[A-Za-z0-9]{1,10}(?=:\\d|\\(\\d)`,
  "gu",
);
const PY_FRAME_RE = /File "([^"\n]+)", line (\d+)/g;
const LOCATION_RE = /^(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\))/;

const count = (s: string, ch: string) => s.split(ch).length - 1;

/** Trailing `)` / `]` only belong to the link when balanced inside it. */
function isUnbalancedCloser(s: string, last: string): boolean {
  if (last === ")") return count(s, "(") < count(s, ")");
  if (last === "]") return count(s, "[") < count(s, "]");
  return false;
}

function trimUrlEnd(s: string): string {
  let out = s;
  for (;;) {
    const last = out[out.length - 1];
    if (last && (/[.,;:!?*]/.test(last) || isUnbalancedCloser(out, last))) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

/** Strip sentence punctuation, unbalanced closers and a wrapping quote. */
export function trimPathEnd(p: string, quotedBy: string | null = null): string {
  let out = p;
  for (;;) {
    const last = out[out.length - 1];
    if (!last) return out;
    if (last === "." || isUnbalancedCloser(out, last)) {
      out = out.slice(0, -1);
      continue;
    }
    if (last === "'" && (quotedBy === "'" || count(out, "'") % 2 === 1)) {
      out = out.slice(0, -1);
      continue;
    }
    return out;
  }
}

/**
 * Strip non-path wrapper text from the front of a relative match:
 * "Update(src/a.ts" → "src/a.ts", "[x](src/a.ts" → "src/a.ts". Balanced route
 * groups like "(auth)/page.tsx" are kept.
 */
function cleanLeading(p: string): string {
  const out = p.replace(/^'+/, "");
  const firstSlash = out.indexOf("/");
  if (firstSlash <= 0) return out;
  const prefix = out.slice(0, firstSlash);
  let paren = 0;
  let bracket = 0;
  for (let i = prefix.length - 1; i >= 0; i--) {
    const ch = prefix[i];
    if (ch === ")") paren++;
    else if (ch === "]") bracket++;
    else if (ch === "(") {
      if (paren > 0) paren--;
      else return out.slice(i + 1);
    } else if (ch === "[") {
      if (bracket > 0) bracket--;
      else return out.slice(i + 1);
    }
  }
  return out;
}

const hasExt = (segment: string) => /\.[A-Za-z0-9]{1,10}$/.test(segment);
const extOf = (segment: string) => segment.split(".").pop()?.toLowerCase() ?? "";
const lastSegment = (p: string) => p.split(/[/\\]/).filter(Boolean).pop() ?? "";

function isLinkablePath(p: string, hasLocation: boolean): boolean {
  if (p.length < 2) return false;
  const last = lastSegment(p);
  if (/^[A-Za-z]:[\\/]/.test(p) || /^(?:~|\.{1,2})\//.test(p)) return last.length > 0;
  if (p.startsWith("/")) {
    const segments = p.split("/").filter(Boolean);
    return segments.length >= 2 || hasExt(last);
  }
  if (KNOWN_EXTS.has(extOf(last)) && hasExt(last)) return true;
  if (EDITOR_FILES.has(last)) return true;
  return hasLocation && hasExt(last);
}

/** Map a `file://` URL to a local path (host dropped, percent-decoded). */
export function fileUrlToPath(url: string): string | null {
  const m = /^file:\/\/([^/]*)(\/.*)?$/i.exec(url.trim());
  if (!m) return null;
  let p = m[2] ?? "";
  try { p = decodeURIComponent(p); } catch { /* keep raw */ }
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
  return p || null;
}

const normalizeLocalHost = (url: string) =>
  url.replace(/^(https?:\/\/)0\.0\.0\.0(?=[:/?#]|$)/i, "$1localhost");

interface Candidate {
  match: LinkMatch;
  priority: number;
}

function urlCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = trimUrlEnd(m[0]);
    const start = m.index!;
    const end = start + raw.length;
    if (/^file:/i.test(raw)) {
      const path = fileUrlToPath(raw);
      if (path) out.push({ match: { start, end, kind: "path", text: raw, path }, priority: 1 });
      continue;
    }
    if (!/^[a-z]+:\/\/[^/?#]+/i.test(raw)) continue; // needs a host
    out.push({ match: { start, end, kind: "url", text: raw, url: normalizeLocalHost(raw) }, priority: 1 });
  }
  for (const m of text.matchAll(LOCAL_ADDR_RE)) {
    const raw = trimUrlEnd(m[0]);
    const start = m.index!;
    const host = m[1].toLowerCase() === "0.0.0.0" ? "localhost" : m[1];
    const url = `http://${host}${raw.slice(m[1].length)}`;
    out.push({ match: { start, end: start + raw.length, kind: "url", text: raw, url }, priority: 2 });
  }
  return out;
}

/** Finish a raw path match: wrappers, location suffix, trailing junk. */
function pathCandidate(text: string, rawStart: number, raw: string, relative: boolean): Candidate | null {
  let start = rawStart;
  let p = raw;
  if (relative) {
    const cleaned = cleanLeading(p);
    start += p.length - cleaned.length;
    p = cleaned;
  }
  const quotedBy = /["'`]/.test(text[start - 1] ?? "") ? text[start - 1] : null;

  // A trailing "(12" / "(12)" belongs to a TypeScript-style location suffix.
  const swallowed = /\(\d+\)?$/.exec(p);
  if (swallowed && hasExt(p.slice(0, swallowed.index))) p = p.slice(0, swallowed.index);
  p = trimPathEnd(p, quotedBy);

  // CJK prose glued after a filename: "a.md已保存" → "a.md".
  const tail = /\.[A-Za-z0-9]{1,10}(?=\P{ASCII}+$)/u.exec(lastSegment(p));
  if (tail) p = p.slice(0, p.length - lastSegment(p).length + tail.index + tail[0].length);

  let end = start + p.length;
  const loc = LOCATION_RE.exec(text.slice(end));
  let line: number | undefined;
  let col: number | undefined;
  if (loc) {
    line = Number(loc[1] ?? loc[3]);
    const c = loc[2] ?? loc[4];
    if (c) col = Number(c);
  }
  if (!isLinkablePath(p, !!loc)) return null;
  if (loc) end += loc[0].length;
  return { match: { start, end, kind: "path", text: text.slice(start, end), path: p, line, col }, priority: 3 };
}

function pathCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const m of text.matchAll(PY_FRAME_RE)) {
    const start = m.index! + m[0].indexOf('"') + 1;
    out.push({
      match: { start, end: start + m[1].length, kind: "path", text: m[1], path: m[1], line: Number(m[2]) },
      priority: 0,
    });
  }
  const push = (c: Candidate | null) => { if (c) out.push(c); };
  for (const m of text.matchAll(ABS_RE)) push(pathCandidate(text, m.index!, m[0], false));
  for (const m of text.matchAll(WIN_RE)) push(pathCandidate(text, m.index!, m[0], false));
  for (const m of text.matchAll(REL_RE)) push(pathCandidate(text, m.index!, m[0], true));
  for (const m of text.matchAll(BARE_RE)) push(pathCandidate(text, m.index!, m[0], false));
  return out;
}

/**
 * Find every URL and file path in one logical terminal line. Results are
 * non-overlapping and in text order; on conflict, python frames beat URLs,
 * URLs beat paths, and the longer path wins.
 */
export function findLinks(text: string): LinkMatch[] {
  if (!text) return [];
  const length = (c: Candidate) => c.match.end - c.match.start;
  const candidates = [...urlCandidates(text), ...pathCandidates(text)].filter((c) => length(c) > 0);
  candidates.sort((a, b) => a.priority - b.priority || length(b) - length(a));
  const accepted: LinkMatch[] = [];
  for (const { match } of candidates) {
    if (accepted.some((a) => match.start < a.end && match.end > a.start)) continue;
    accepted.push(match);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

// ── String offset ↔ buffer cell mapping ─────────────────────────────────────

export interface BufferCellLike {
  chars: string;
  /** 1 normal, 2 wide (CJK/emoji), 0 the continuation cell after a wide char. */
  width: number;
}

/** 1-based cell column, row relative to the first row passed in. */
export interface CellPos {
  row: number;
  x: number;
}

export interface LogicalLine {
  text: string;
  /** Inclusive cell range covering text[start, end). */
  rangeFor(start: number, end: number): { start: CellPos; end: CellPos };
}

/**
 * Join buffer rows into one string while remembering which cell each UTF-16
 * unit came from. A wide char is one string char but two cells, so plain
 * `offset % cols` math drifts right after any CJK/emoji on the line.
 */
export function buildLogicalLine(rows: BufferCellLike[][]): LogicalLine {
  let text = "";
  const pos: Array<{ row: number; col: number; width: number }> = [];
  rows.forEach((cells, row) => {
    cells.forEach((cell, col) => {
      if (cell.width === 0) return;
      const chars = cell.chars || " ";
      for (let i = 0; i < chars.length; i++) pos.push({ row, col, width: cell.width || 1 });
      text += chars;
    });
  });
  return {
    text,
    rangeFor(start, end) {
      const last = pos.length - 1;
      const a = pos[Math.min(Math.max(start, 0), last)];
      const b = pos[Math.min(Math.max(end - 1, start), last)];
      return { start: { row: a.row, x: a.col + 1 }, end: { row: b.row, x: b.col + b.width } };
    },
  };
}
