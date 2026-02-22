import { test as base, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_PORT = 3888; // Server listens on hardcoded port 3888

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
      env: { ...process.env },
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

/**
 * Bypass onboarding by injecting localStorage keys.
 */
async function dismissOnboarding(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem("tron_configured", "true");
    localStorage.setItem("tron_tutorial_completed", "true");
    localStorage.setItem("tron_theme", "dark");
    localStorage.setItem("tron_view_mode", "terminal");
  });
  await page.reload();
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

    await page.goto(`http://localhost:${WEB_PORT}`);
    await page.waitForLoadState("domcontentloaded");
    await dismissOnboarding(page);
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
