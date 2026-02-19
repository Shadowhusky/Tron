import { describe, it, expect } from "vitest";
import {
  classifyTerminalOutput,
  describeKeys,
  autoCdCommand,
  isDuplicateScaffold,
  PROJECT_CMD_RE,
} from "../utils/terminalState";

// =============================================================================
// classifyTerminalOutput
// =============================================================================
describe("classifyTerminalOutput", () => {
  // ── Idle (shell prompt visible) ──────────────────────────────────────────

  it("detects bash prompt ending with $", () => {
    expect(classifyTerminalOutput("user@host:~/project$ ")).toBe("idle");
  });

  it("detects zsh prompt ending with %", () => {
    expect(classifyTerminalOutput("user@macbook ~/project % ")).toBe("idle");
  });

  it("detects root prompt ending with #", () => {
    expect(classifyTerminalOutput("root@server:/home# ")).toBe("idle");
  });

  it("detects plain $ prompt", () => {
    expect(classifyTerminalOutput("$ ")).toBe("idle");
  });

  it("detects prompt after command output", () => {
    const output = `total 48
drwxr-xr-x  12 user  staff  384 Feb 19 10:00 .
drwxr-xr-x   5 user  staff  160 Feb 19 09:50 ..
user@host:~/project$ `;
    expect(classifyTerminalOutput(output)).toBe("idle");
  });

  it("detects prompt after npm install completes", () => {
    const output = `added 156 packages, and audited 157 packages in 12s

23 packages are looking for funding
  run \`npm fund\` for details

found 0 vulnerabilities
user@macbook ~/dino-game % `;
    expect(classifyTerminalOutput(output)).toBe("idle");
  });

  it("detects > prompt (fish/custom shells)", () => {
    expect(classifyTerminalOutput("~/project> ")).toBe("idle");
  });

  // ── Server (dev server / listener) ───────────────────────────────────────

  it("detects Vite dev server", () => {
    const output = `  VITE v6.3.5  ready in 234 ms

  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
  ➜  press h + enter to show help`;
    expect(classifyTerminalOutput(output)).toBe("server");
  });

  it("detects generic localhost server", () => {
    const output = `Server started
Listening on http://localhost:3000`;
    expect(classifyTerminalOutput(output)).toBe("server");
  });

  it("detects 127.0.0.1 server", () => {
    const output = `Express server running
http://127.0.0.1:8080`;
    expect(classifyTerminalOutput(output)).toBe("server");
  });

  it('detects "listening on" pattern', () => {
    const output = `info: listening on port 4000
Ready to accept connections`;
    expect(classifyTerminalOutput(output)).toBe("server");
  });

  it('detects "ready in" pattern (Vite)', () => {
    const output = `  VITE v6.3.5  ready in 150 ms`;
    expect(classifyTerminalOutput(output)).toBe("server");
  });

  it('detects "press h + enter" helper text', () => {
    const output = `  ➜  press h + enter to show help`;
    expect(classifyTerminalOutput(output)).toBe("server");
  });

  it("detects Next.js dev server", () => {
    const output = `  ▲ Next.js 15.3.2
  - Local:        http://localhost:3000

 ✓ Starting...
 ✓ Ready in 2.1s`;
    expect(classifyTerminalOutput(output)).toBe("server");
  });

  // ── Busy (installing, building) ──────────────────────────────────────────

  it("detects npm install in progress", () => {
    const output = `npm warn deprecated inflight@1.0.6: This module is not supported...
npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported

added 87 packages in 3s`;
    // Note: no prompt at end — still installing
    // Actually this looks like it finished... but no prompt visible
    expect(classifyTerminalOutput(output)).toBe("busy");
  });

  it("detects npm install with spinner/progress", () => {
    const output = `npm warn deprecated inflight@1.0.6
⠙ idealTree:dino-game: sill idealTree buildDeps`;
    expect(classifyTerminalOutput(output)).toBe("busy");
  });

  it("detects yarn install progress", () => {
    const output = `[1/4] Resolving packages...
[2/4] Fetching packages...
[3/4] Linking dependencies...`;
    expect(classifyTerminalOutput(output)).toBe("busy");
  });

  it("detects build in progress", () => {
    const output = `Building for production...
transforming (143) src/components/App.tsx`;
    expect(classifyTerminalOutput(output)).toBe("busy");
  });

  it("detects cargo build", () => {
    const output = `   Compiling serde v1.0.210
   Compiling tokio v1.42.0`;
    expect(classifyTerminalOutput(output)).toBe("busy");
  });

  it("detects tsc compilation", () => {
    const output = `Starting compilation in watch mode...`;
    expect(classifyTerminalOutput(output)).toBe("busy");
  });

  it("empty output is busy (no prompt visible)", () => {
    expect(classifyTerminalOutput("")).toBe("busy");
  });

  it("random text with no prompt or server pattern is busy", () => {
    expect(classifyTerminalOutput("doing something...")).toBe("busy");
  });
});

// =============================================================================
// describeKeys
// =============================================================================
describe("describeKeys", () => {
  // ── Single control characters ────────────────────────────────────────────

  it("describes Enter (\\r)", () => {
    expect(describeKeys("\r")).toBe("Pressed Enter");
  });

  it("describes Enter (\\n)", () => {
    expect(describeKeys("\n")).toBe("Pressed Enter");
  });

  it("describes Space", () => {
    expect(describeKeys(" ")).toBe("Pressed Space");
  });

  it("describes Ctrl+C", () => {
    expect(describeKeys("\x03")).toBe("Pressed Ctrl+C");
  });

  it("describes Ctrl+D", () => {
    expect(describeKeys("\x04")).toBe("Pressed Ctrl+D");
  });

  it("describes Ctrl+Z", () => {
    expect(describeKeys("\x1a")).toBe("Pressed Ctrl+Z");
  });

  it("describes Tab", () => {
    expect(describeKeys("\t")).toBe("Pressed Tab");
  });

  it("describes Ctrl+U", () => {
    expect(describeKeys("\x15")).toBe("Pressed Ctrl+U");
  });

  it("describes Ctrl+L", () => {
    expect(describeKeys("\x0c")).toBe("Pressed Ctrl+L");
  });

  // ── Arrow keys ───────────────────────────────────────────────────────────

  it("describes Up Arrow", () => {
    expect(describeKeys("\x1B[A")).toBe("Pressed Up Arrow");
  });

  it("describes Down Arrow", () => {
    expect(describeKeys("\x1B[B")).toBe("Pressed Down Arrow");
  });

  it("describes Right Arrow", () => {
    expect(describeKeys("\x1B[C")).toBe("Pressed Right Arrow");
  });

  it("describes Left Arrow", () => {
    expect(describeKeys("\x1B[D")).toBe("Pressed Left Arrow");
  });

  // ── Arrow key sequences ──────────────────────────────────────────────────

  it("describes multiple Down arrows", () => {
    expect(describeKeys("\x1B[B\x1B[B\x1B[B")).toBe("Down, Down, Down");
  });

  it("describes Down arrows + Enter", () => {
    expect(describeKeys("\x1B[B\x1B[B\r")).toBe("Down, Down + Enter");
  });

  it("describes mixed arrows", () => {
    expect(describeKeys("\x1B[A\x1B[B\x1B[C\x1B[D")).toBe("Up, Down, Right, Left");
  });

  // ── Text + Enter ─────────────────────────────────────────────────────────

  it('describes text + Enter ("y\\r")', () => {
    expect(describeKeys("y\r")).toBe('Typed "y" + Enter');
  });

  it('describes command + Enter', () => {
    expect(describeKeys("npm install\r")).toBe('Typed "npm install" + Enter');
  });

  it("describes just Enter when text is empty before \\r", () => {
    expect(describeKeys("\r")).toBe("Pressed Enter");
  });

  // ── Plain text ───────────────────────────────────────────────────────────

  it("describes short printable text", () => {
    expect(describeKeys("hello")).toBe('Typed "hello"');
  });

  it("describes long text (>30 chars) as character count", () => {
    const longText = "a".repeat(31);
    expect(describeKeys(longText)).toBe("Typed 31 characters");
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it("describes pure control characters as keystroke count", () => {
    // Multiple control chars that aren't in the map individually
    expect(describeKeys("\x01\x02")).toBe("Sent 2 keystrokes");
  });
});

// =============================================================================
// autoCdCommand
// =============================================================================
describe("autoCdCommand", () => {
  it("prepends cd for npm install", () => {
    expect(autoCdCommand("npm install", "/home/user/project")).toBe(
      "cd /home/user/project && npm install"
    );
  });

  it("prepends cd for yarn add", () => {
    expect(autoCdCommand("yarn add react", "/home/user/project")).toBe(
      "cd /home/user/project && yarn add react"
    );
  });

  it("prepends cd for npx command", () => {
    expect(autoCdCommand("npx vite", "/home/user/app")).toBe(
      "cd /home/user/app && npx vite"
    );
  });

  it("prepends cd for cargo build", () => {
    expect(autoCdCommand("cargo build", "/home/user/rust-project")).toBe(
      "cd /home/user/rust-project && cargo build"
    );
  });

  it("does NOT prepend cd if command already has cd", () => {
    expect(autoCdCommand("cd /tmp && npm install", "/home/user/project")).toBe(
      "cd /tmp && npm install"
    );
  });

  it("does NOT prepend cd if lastWriteDir is empty", () => {
    expect(autoCdCommand("npm install", "")).toBe("npm install");
  });

  it("does NOT prepend cd for non-project commands", () => {
    expect(autoCdCommand("ls -la", "/home/user/project")).toBe("ls -la");
    expect(autoCdCommand("git status", "/home/user/project")).toBe("git status");
    expect(autoCdCommand("cat foo.txt", "/home/user/project")).toBe("cat foo.txt");
  });

  it("handles pnpm, bun, pip, make, gradle, mvn, dotnet", () => {
    const dir = "/home/user/proj";
    expect(autoCdCommand("pnpm install", dir)).toBe(`cd ${dir} && pnpm install`);
    expect(autoCdCommand("bun install", dir)).toBe(`cd ${dir} && bun install`);
    expect(autoCdCommand("pip install flask", dir)).toBe(`cd ${dir} && pip install flask`);
    expect(autoCdCommand("pip3 install flask", dir)).toBe(`cd ${dir} && pip3 install flask`);
    expect(autoCdCommand("make build", dir)).toBe(`cd ${dir} && make build`);
    expect(autoCdCommand("gradle build", dir)).toBe(`cd ${dir} && gradle build`);
    expect(autoCdCommand("mvn package", dir)).toBe(`cd ${dir} && mvn package`);
    expect(autoCdCommand("dotnet build", dir)).toBe(`cd ${dir} && dotnet build`);
  });

  it("handles go build/run/test", () => {
    const dir = "/home/user/proj";
    expect(autoCdCommand("go build ./...", dir)).toBe(`cd ${dir} && go build ./...`);
    expect(autoCdCommand("go run main.go", dir)).toBe(`cd ${dir} && go run main.go`);
    expect(autoCdCommand("go test ./...", dir)).toBe(`cd ${dir} && go test ./...`);
  });
});

// =============================================================================
// PROJECT_CMD_RE
// =============================================================================
describe("PROJECT_CMD_RE", () => {
  const matches = (cmd: string) => PROJECT_CMD_RE.test(cmd);

  it("matches npm commands", () => {
    expect(matches("npm install")).toBe(true);
    expect(matches("npm run dev")).toBe(true);
    expect(matches("npm start")).toBe(true);
  });

  it("matches npx commands", () => {
    expect(matches("npx vite")).toBe(true);
    expect(matches("npx create-react-app myapp")).toBe(true);
  });

  it("matches yarn commands", () => {
    expect(matches("yarn add react")).toBe(true);
    expect(matches("yarn build")).toBe(true);
  });

  it("matches pnpm commands", () => {
    expect(matches("pnpm install")).toBe(true);
  });

  it("matches bun commands", () => {
    expect(matches("bun install")).toBe(true);
    expect(matches("bun run dev")).toBe(true);
  });

  it("matches pip/pip3 commands", () => {
    expect(matches("pip install flask")).toBe(true);
    expect(matches("pip3 install django")).toBe(true);
  });

  it("matches cargo commands", () => {
    expect(matches("cargo build")).toBe(true);
    expect(matches("cargo run")).toBe(true);
  });

  it("matches make commands", () => {
    expect(matches("make")).toBe(true);
    expect(matches("make install")).toBe(true);
  });

  it("matches gradle/gradlew", () => {
    expect(matches("gradle build")).toBe(true);
    expect(matches("gradlew assemble")).toBe(true);
  });

  it("matches mvn commands", () => {
    expect(matches("mvn package")).toBe(true);
  });

  it("matches dotnet commands", () => {
    expect(matches("dotnet build")).toBe(true);
  });

  it("matches go build/run/test", () => {
    expect(matches("go build ./...")).toBe(true);
    expect(matches("go run main.go")).toBe(true);
    expect(matches("go test ./...")).toBe(true);
  });

  it("does NOT match non-project commands", () => {
    expect(matches("ls -la")).toBe(false);
    expect(matches("git status")).toBe(false);
    expect(matches("echo hello")).toBe(false);
    expect(matches("cd /tmp")).toBe(false);
    expect(matches("cat file.txt")).toBe(false);
  });
});

// =============================================================================
// isDuplicateScaffold
// =============================================================================
describe("isDuplicateScaffold", () => {
  it("catches npm create re-run with different args", () => {
    const executed = new Set(["npm create vite@latest"]);
    expect(isDuplicateScaffold("npm create vite@latest /path -- --template vanilla", executed)).toBe(true);
  });

  it("catches npx create re-run with different project name", () => {
    const executed = new Set(["npx create-react-app my-app"]);
    expect(isDuplicateScaffold("npx create-react-app my-app-2", executed)).toBe(true);
  });

  it("catches yarn create re-run", () => {
    const executed = new Set(["yarn create vite my-app"]);
    expect(isDuplicateScaffold("yarn create vite my-app --template react", executed)).toBe(true);
  });

  it("catches pnpm create re-run", () => {
    const executed = new Set(["pnpm create vite"]);
    expect(isDuplicateScaffold("pnpm create vite my-app", executed)).toBe(true);
  });

  it("catches bun create re-run", () => {
    const executed = new Set(["bun create vite my-app"]);
    expect(isDuplicateScaffold("bun create vite another-app", executed)).toBe(true);
  });

  it("catches cargo new re-run", () => {
    const executed = new Set(["cargo new my-project"]);
    expect(isDuplicateScaffold("cargo new my-project --lib", executed)).toBe(true);
  });

  it("catches dotnet new re-run", () => {
    const executed = new Set(["dotnet new console"]);
    expect(isDuplicateScaffold("dotnet new console -o MyApp", executed)).toBe(true);
  });

  it("catches rails new re-run", () => {
    const executed = new Set(["rails new myapp"]);
    expect(isDuplicateScaffold("rails new myapp --api", executed)).toBe(true);
  });

  it("is case insensitive", () => {
    const executed = new Set(["NPM CREATE vite"]);
    expect(isDuplicateScaffold("npm create vite@latest", executed)).toBe(true);
  });

  it("does NOT flag npm install as duplicate of npm create", () => {
    const executed = new Set(["npm create vite@latest"]);
    expect(isDuplicateScaffold("npm install", executed)).toBe(false);
  });

  it("does NOT flag non-scaffold commands", () => {
    const executed = new Set(["npm create vite@latest"]);
    expect(isDuplicateScaffold("npm run dev", executed)).toBe(false);
    expect(isDuplicateScaffold("ls -la", executed)).toBe(false);
    expect(isDuplicateScaffold("git status", executed)).toBe(false);
  });

  it("does NOT flag when executedCommands is empty", () => {
    const executed = new Set<string>();
    expect(isDuplicateScaffold("npm create vite@latest", executed)).toBe(false);
  });

  it("does NOT flag first occurrence of a scaffold command", () => {
    const executed = new Set(["npm install", "ls -la"]);
    expect(isDuplicateScaffold("npm create vite@latest", executed)).toBe(false);
  });
});
