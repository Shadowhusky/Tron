import { describe, it, expect } from "vitest";
import { isInteractiveCommand, isCommand } from "../utils/commandClassifier";

// =============================================================================
// isInteractiveCommand
// =============================================================================
describe("isInteractiveCommand", () => {
  // ── Editors (interactive) ────────────────────────────────────────────────

  it("detects vi as interactive", () => {
    expect(isInteractiveCommand("vi file.txt")).toBe(true);
  });

  it("detects vim as interactive", () => {
    expect(isInteractiveCommand("vim src/main.ts")).toBe(true);
  });

  it("detects nvim as interactive", () => {
    expect(isInteractiveCommand("nvim")).toBe(true);
  });

  it("detects nano as interactive", () => {
    expect(isInteractiveCommand("nano ~/.bashrc")).toBe(true);
  });

  it("detects emacs as interactive", () => {
    expect(isInteractiveCommand("emacs")).toBe(true);
  });

  // ── TUI tools (interactive) ──────────────────────────────────────────────

  it("detects top as interactive", () => {
    expect(isInteractiveCommand("top")).toBe(true);
  });

  it("detects htop as interactive", () => {
    expect(isInteractiveCommand("htop")).toBe(true);
  });

  it("detects less as interactive", () => {
    expect(isInteractiveCommand("less /var/log/syslog")).toBe(true);
  });

  it("detects man as interactive", () => {
    expect(isInteractiveCommand("man git")).toBe(true);
  });

  // ── REPLs (interactive) ──────────────────────────────────────────────────

  it("detects python as interactive", () => {
    expect(isInteractiveCommand("python")).toBe(true);
  });

  it("detects python3 as interactive", () => {
    expect(isInteractiveCommand("python3")).toBe(true);
  });

  it("detects node as interactive", () => {
    expect(isInteractiveCommand("node")).toBe(true);
  });

  it("detects irb as interactive", () => {
    expect(isInteractiveCommand("irb")).toBe(true);
  });

  it("detects ipython as interactive", () => {
    expect(isInteractiveCommand("ipython")).toBe(true);
  });

  // ── DB shells (interactive) ──────────────────────────────────────────────

  it("detects mysql as interactive", () => {
    expect(isInteractiveCommand("mysql -u root")).toBe(true);
  });

  it("detects psql as interactive", () => {
    expect(isInteractiveCommand("psql mydb")).toBe(true);
  });

  it("detects sqlite3 as interactive", () => {
    expect(isInteractiveCommand("sqlite3 data.db")).toBe(true);
  });

  it("detects redis-cli as interactive", () => {
    expect(isInteractiveCommand("redis-cli")).toBe(true);
  });

  // ── Remote (interactive) ─────────────────────────────────────────────────

  it("detects ssh as interactive", () => {
    expect(isInteractiveCommand("ssh user@host")).toBe(true);
  });

  // ── Debuggers (interactive) ──────────────────────────────────────────────

  it("detects gdb as interactive", () => {
    expect(isInteractiveCommand("gdb ./a.out")).toBe(true);
  });

  it("detects lldb as interactive", () => {
    expect(isInteractiveCommand("lldb -- ./binary")).toBe(true);
  });

  // ── Multiplexers (interactive) ───────────────────────────────────────────

  it("detects tmux as interactive", () => {
    expect(isInteractiveCommand("tmux")).toBe(true);
  });

  it("detects screen as interactive", () => {
    expect(isInteractiveCommand("screen")).toBe(true);
  });

  // ── Prefix-based interactive commands ────────────────────────────────────

  it("detects npm create as interactive", () => {
    expect(isInteractiveCommand("npm create vite@latest my-app")).toBe(true);
  });

  it("detects npx create as interactive", () => {
    expect(isInteractiveCommand("npx create-react-app my-app")).toBe(true);
  });

  it("detects npm init as interactive", () => {
    expect(isInteractiveCommand("npm init")).toBe(true);
  });

  it("detects npm run dev as interactive", () => {
    expect(isInteractiveCommand("npm run dev")).toBe(true);
  });

  it("detects npm start as interactive", () => {
    expect(isInteractiveCommand("npm start")).toBe(true);
  });

  it("detects yarn dev as interactive", () => {
    expect(isInteractiveCommand("yarn dev")).toBe(true);
  });

  it("detects pnpm dev as interactive", () => {
    expect(isInteractiveCommand("pnpm dev")).toBe(true);
  });

  it("detects bun dev as interactive", () => {
    expect(isInteractiveCommand("bun dev")).toBe(true);
  });

  it("detects bun run dev as interactive", () => {
    expect(isInteractiveCommand("bun run dev")).toBe(true);
  });

  it("detects npx vite as interactive", () => {
    expect(isInteractiveCommand("npx vite")).toBe(true);
  });

  it("detects npx serve as interactive", () => {
    expect(isInteractiveCommand("npx serve")).toBe(true);
  });

  it("detects docker run -it as interactive", () => {
    expect(isInteractiveCommand("docker run -it ubuntu bash")).toBe(true);
  });

  it("detects docker exec -it as interactive", () => {
    expect(isInteractiveCommand("docker exec -it mycontainer bash")).toBe(true);
  });

  it("detects docker compose up as interactive", () => {
    expect(isInteractiveCommand("docker compose up")).toBe(true);
  });

  // ── Non-interactive commands ─────────────────────────────────────────────

  it("ls is NOT interactive", () => {
    expect(isInteractiveCommand("ls -la")).toBe(false);
  });

  it("pwd is NOT interactive", () => {
    expect(isInteractiveCommand("pwd")).toBe(false);
  });

  it("cat is NOT interactive", () => {
    expect(isInteractiveCommand("cat file.txt")).toBe(false);
  });

  it("mkdir is NOT interactive", () => {
    expect(isInteractiveCommand("mkdir -p my-project")).toBe(false);
  });

  it("git status is NOT interactive", () => {
    expect(isInteractiveCommand("git status")).toBe(false);
  });

  it("npm install is NOT interactive", () => {
    expect(isInteractiveCommand("npm install")).toBe(false);
  });

  it("npm run build is NOT interactive", () => {
    expect(isInteractiveCommand("npm run build")).toBe(false);
  });

  it("echo is NOT interactive", () => {
    expect(isInteractiveCommand("echo hello world")).toBe(false);
  });

  it("grep is NOT interactive", () => {
    expect(isInteractiveCommand("grep -r pattern src/")).toBe(false);
  });

  it("curl is NOT interactive", () => {
    expect(isInteractiveCommand("curl https://example.com")).toBe(false);
  });

  it("docker run without -it is NOT interactive", () => {
    expect(isInteractiveCommand("docker run ubuntu echo hello")).toBe(false);
  });

  it("docker build is NOT interactive", () => {
    expect(isInteractiveCommand("docker build -t myapp .")).toBe(false);
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it("handles whitespace-padded commands", () => {
    expect(isInteractiveCommand("  vim file.txt  ")).toBe(true);
  });

  it("handles case sensitivity correctly (npm is lowercase)", () => {
    expect(isInteractiveCommand("NPM RUN DEV")).toBe(true); // lowered for prefix match
  });
});

// =============================================================================
// isCommand (regression: commands used in agent context)
// =============================================================================
describe("isCommand — agent-relevant commands", () => {
  it("pwd is a command", () => {
    expect(isCommand("pwd")).toBe(true);
  });

  it("ls is a command", () => {
    expect(isCommand("ls")).toBe(true);
  });

  it("ls -la is a command", () => {
    expect(isCommand("ls -la")).toBe(true);
  });

  it("npm install is a command", () => {
    expect(isCommand("npm install")).toBe(true);
  });

  it("git status is a command", () => {
    expect(isCommand("git status")).toBe(true);
  });

  it('"create a react app" is natural language', () => {
    expect(isCommand("create a react app")).toBe(false);
  });

  it('"install nvm" is natural language (imperative verb)', () => {
    expect(isCommand("install nvm")).toBe(false);
  });

  it('"help me debug this" is natural language', () => {
    expect(isCommand("help me debug this")).toBe(false);
  });
});
