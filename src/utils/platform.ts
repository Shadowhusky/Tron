/**
 * Cross-platform path utilities.
 * Works in both Electron renderer (browser) and Node.js (main process) contexts.
 * Does NOT import Node.js modules — uses only universal APIs.
 */

/** Detect if running on Windows. */
export function isWindows(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  if (g.process?.platform) return g.process.platform === "win32";
  if (typeof navigator !== "undefined") {
    return navigator.platform?.startsWith("Win") ?? false;
  }
  return false;
}

/** Detect if running inside Electron (vs. plain browser / web mode). */
export function isElectronApp(): boolean {
  if (typeof navigator !== "undefined") {
    return navigator.userAgent.includes("Electron");
  }
  return false;
}

/** Extract filename from a path, handling both / and \ separators. */
export function extractFilename(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return lastSlash >= 0 ? filePath.substring(lastSlash + 1) : filePath;
}

/** Extract parent directory from a path, handling both / and \ separators. */
export function extractDirectory(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return lastSlash >= 0 ? filePath.substring(0, lastSlash) : "";
}

/** Returns true if the string looks like an absolute file path (Unix or Windows). */
export function isAbsolutePath(p: string): boolean {
  if (p.startsWith("/")) return true;
  // Windows drive letter: C:\ or C:/
  if (/^[a-zA-Z]:[/\\]/.test(p)) return true;
  return false;
}

/**
 * Abbreviate home directory in a path for display.
 * Handles macOS (/Users/foo), Linux (/home/foo), and Windows (C:\Users\foo).
 */
export function abbreviateHome(fullPath: string): string {
  // macOS: /Users/username
  const mac = fullPath.replace(/^\/Users\/[^/]+/, "~");
  if (mac !== fullPath) return mac;
  // Linux: /home/username
  const linux = fullPath.replace(/^\/home\/[^/]+/, "~");
  if (linux !== fullPath) return linux;
  // Windows: C:\Users\username (any drive letter)
  const win = fullPath.replace(/^[a-zA-Z]:\\Users\\[^\\]+/, "~");
  if (win !== fullPath) return win;
  return fullPath;
}

/** Returns true if the token looks like the start of a file path (Unix or Windows). */
export function isPathLikeToken(token: string): boolean {
  return (
    token.startsWith("/") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("~/") ||
    /^[a-zA-Z]:[/\\]/.test(token) || // C:\foo or C:/foo
    token.startsWith(".\\") ||        // .\foo
    token.startsWith("..\\") ||       // ..\foo
    token.startsWith("~\\")           // ~\foo
  );
}
