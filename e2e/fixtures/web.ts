import { test as base, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_PORT = Number(process.env.TRON_TEST_PORT) || 3889; // Use different port to avoid conflicts with running Electron app

type WebFixture = {
  page: Page;
};

let serverProcess: ChildProcess | null = null;
let serverReady = false;

/**
 * Start the web server (Express + WebSocket) for browser-based testing.
 * Reuses a single server across all tests in the suite.
 */
async function ensureServer(): Promise<void> {
  if (serverReady) return;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Web server failed to start within 10s"));
    }, 10_000);

    serverProcess = spawn("node", ["dist-server/index.js"], {
      cwd: path.resolve(__dirname, "../.."),
      env: { ...process.env, TRON_PORT: String(WEB_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    serverProcess.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      if (text.includes("Server running")) {
        clearTimeout(timeout);
        serverReady = true;
        resolve();
      }
    });

    serverProcess.stderr?.on("data", (data: Buffer) => {
      console.error(`[Web Server stderr]: ${data.toString()}`);
    });

    serverProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    serverProcess.on("exit", (code) => {
      if (!serverReady) {
        clearTimeout(timeout);
        reject(new Error(`Server exited with code ${code}`));
      }
    });
  });
}

export const test = base.extend<WebFixture>({
  page: async ({ browser }, use) => {
    await ensureServer();
    const context = await browser.newContext();
    const page = await context.newPage();

    // Debug logging
    page.on("console", (msg) => {
      const text = msg.text();
      // Filter out noise but keep errors/warnings
      if (msg.type() === "error" || msg.type() === "warning") {
        console.log(`[Web ${msg.type()}]: ${text}`);
      }
    });
    page.on("pageerror", (err) => console.log(`[Web Page Error]: ${err.message}`));

    // Use skip-setup URL param to bypass onboarding (localStorage won't work
    // in web mode because config is server-backed, not localStorage-backed)
    await page.goto(`http://localhost:${WEB_PORT}?skip-setup=true`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });

    await use(page);
    await context.close();
  },
});

export { expect } from "@playwright/test";

// Cleanup server when all tests finish
process.on("exit", () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});
