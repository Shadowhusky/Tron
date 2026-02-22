/**
 * Record animated GIF demos of Tron features for README.
 * Takes rapid Playwright screenshots → combines with ffmpeg into GIF.
 *
 * Usage: npx tsx scripts/record-demos.ts
 * Requires: ffmpeg, built app (npm run build:react && npm run build:electron)
 * Reads: e2e/.env.test for AI provider config (needed for advice + agent demos)
 */
import { _electron, ElectronApplication, Page } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.resolve(__dirname, "../screenshots");
const VIDEOS_DIR = path.resolve(__dirname, "../.demo-videos");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Load .env.test ───
function loadEnvTest(): Record<string, string> {
  const envPath = path.resolve(__dirname, "../e2e/.env.test");
  const env: Record<string, string> = {};
  if (!fs.existsSync(envPath)) {
    console.warn("  ⚠ e2e/.env.test not found — AI demos will be skipped");
    return env;
  }
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }
  return env;
}

const testEnv = loadEnvTest();

/** Shared evaluate snippet: find the visible SmartInput textarea */
function findVisibleTextarea(): string {
  return `
    (() => {
      const all = document.querySelectorAll('[data-testid="smart-input-textarea"]');
      for (const el of all) {
        if (getComputedStyle(el).visibility !== 'hidden') return el;
      }
      return all[all.length - 1];
    })()
  `;
}

// ─── Frame Recorder ───
class Recorder {
  private dir: string;
  private idx = 0;
  constructor(
    private page: Page,
    name: string,
  ) {
    this.dir = path.join(VIDEOS_DIR, `${name}-frames`);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  async snap() {
    const p = path.join(this.dir, `frame-${String(this.idx++).padStart(4, "0")}.png`);
    await this.page.screenshot({ path: p, animations: "disabled" });
  }

  async hold(ms: number, frameInterval = 300) {
    const n = Math.max(1, Math.ceil(ms / frameInterval));
    for (let i = 0; i < n; i++) {
      await this.snap();
      if (i < n - 1) await sleep(frameInterval);
    }
  }

  /**
   * Type text into the visible SmartInput textarea with frame captures.
   * Uses native value setter + input event to trigger React's onChange.
   */
  async typeInInput(text: string, charDelay = 50) {
    for (let i = 0; i < text.length; i++) {
      const partial = text.substring(0, i + 1);
      await this.page.evaluate((val) => {
        const el = (() => {
          const all = document.querySelectorAll<HTMLTextAreaElement>(
            '[data-testid="smart-input-textarea"]',
          );
          for (const t of all) {
            if (getComputedStyle(t).visibility !== "hidden") return t;
          }
          return all[all.length - 1];
        })();
        if (!el) return;
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        setter?.call(el, val);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";
      }, partial);
      await sleep(charDelay);
      if (i % 3 === 0 || i === text.length - 1) await this.snap();
    }
    await sleep(300);
  }

  toGif(outputName: string, fps = 5, scale = 960) {
    const gifPath = path.join(SCREENSHOTS_DIR, `${outputName}.gif`);
    const pattern = path.join(this.dir, "frame-%04d.png");
    console.log(`  Combining ${this.idx} frames → ${outputName}.gif ...`);
    try {
      execSync(
        `ffmpeg -y -framerate ${fps} -i "${pattern}" ` +
          `-vf "fps=${fps},scale=${scale}:-1:flags=lanczos,split[s0][s1];` +
          `[s0]palettegen=max_colors=128:stats_mode=diff[p];` +
          `[s1][p]paletteuse=dither=bayer:bayer_scale=5" -loop 0 "${gifPath}"`,
        { stdio: "pipe" },
      );
      const sizeMB = (fs.statSync(gifPath).size / 1024 / 1024).toFixed(1);
      console.log(`  ✓ ${outputName}.gif (${sizeMB} MB, ${this.idx} frames)`);
    } catch (e: any) {
      console.error(`  ✗ ffmpeg failed:`, e.stderr?.toString().slice(0, 200) || e.message);
    }
  }
}

// ─── App helpers ───

async function launchApp(): Promise<{ app: ElectronApplication; page: Page; profile: string }> {
  const profile = path.join(__dirname, `../.demo-profile-${Date.now()}`);
  const app = await _electron.launch({
    args: [path.resolve(__dirname, "../dist-electron/main.js")],
    env: { ...process.env, NODE_ENV: "test", TRON_TEST_PROFILE: profile },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, profile };
}

function buildAIConfig(): { aiConfig: any; providerConfigs: any } | null {
  const provider = testEnv.TEST_PROVIDER;
  const model = testEnv.TEST_MODEL;
  if (!provider || !model) return null;

  const aiConfig: any = { provider, model };
  if (testEnv.TEST_BASE_URL) aiConfig.baseUrl = testEnv.TEST_BASE_URL;
  if (testEnv.TEST_API_KEY) aiConfig.apiKey = testEnv.TEST_API_KEY;

  const providerConfigs: any = {};
  providerConfigs[provider] = {
    model,
    ...(testEnv.TEST_BASE_URL && { baseUrl: testEnv.TEST_BASE_URL }),
    ...(testEnv.TEST_API_KEY && { apiKey: testEnv.TEST_API_KEY }),
  };

  return { aiConfig, providerConfigs };
}

async function setup(app: ElectronApplication, page: Page, theme = "dark", withAI = false) {
  const aiCfg = withAI ? buildAIConfig() : null;

  await page.evaluate(
    ({ t, ai }) => {
      localStorage.setItem("tron_configured", "true");
      localStorage.setItem("tron_tutorial_completed", "true");
      localStorage.setItem("tron_theme", t);
      localStorage.setItem("tron_view_mode", "terminal");
      if (ai) {
        localStorage.setItem("tron_ai_config", JSON.stringify(ai.aiConfig));
        localStorage.setItem("tron_provider_configs", JSON.stringify(ai.providerConfigs));
      }
    },
    { t: theme, ai: aiCfg },
  );
  await page.reload();
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await app.evaluate(({ BrowserWindow }: any) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.setSize(1280, 800);
      win.center();
    }
  });
  await sleep(1500);
}

/** Submit by dispatching Enter keydown on the visible textarea */
async function submitInput(page: Page) {
  await page.evaluate(() => {
    const all = document.querySelectorAll<HTMLTextAreaElement>(
      '[data-testid="smart-input-textarea"]',
    );
    let el: HTMLTextAreaElement | null = null;
    for (const t of all) {
      if (getComputedStyle(t).visibility !== "hidden") { el = t; break; }
    }
    if (!el && all.length > 0) el = all[all.length - 1] as HTMLTextAreaElement;
    if (!el) return;
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    }));
  });
}

/** Submit with Cmd+Enter (force agent mode) */
async function submitAgent(page: Page) {
  await page.evaluate(() => {
    const all = document.querySelectorAll<HTMLTextAreaElement>(
      '[data-testid="smart-input-textarea"]',
    );
    let el: HTMLTextAreaElement | null = null;
    for (const t of all) {
      if (getComputedStyle(t).visibility !== "hidden") { el = t; break; }
    }
    if (!el && all.length > 0) el = all[all.length - 1] as HTMLTextAreaElement;
    if (!el) return;
    el.focus();
    el.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Enter", code: "Enter", keyCode: 13, which: 13,
      metaKey: true, bubbles: true, cancelable: true,
    }));
  });
}

/** Clear the visible SmartInput textarea */
async function clearInput(page: Page) {
  await page.evaluate(() => {
    const all = document.querySelectorAll<HTMLTextAreaElement>(
      '[data-testid="smart-input-textarea"]',
    );
    for (const el of all) {
      if (getComputedStyle(el).visibility !== "hidden") {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value",
        )?.set;
        setter?.call(el, "");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.style.height = "auto";
        return;
      }
    }
  });
  await sleep(100);
}

// ─── Demo 1: Terminal + Tabs + Splits ───
async function demoTerminal() {
  console.log("\n[1/6] Terminal + Tabs");
  const { app, page, profile } = await launchApp();
  await setup(app, page);
  const rec = new Recorder(page, "terminal");

  await rec.hold(800);

  await rec.typeInInput("echo 'Hello from Tron!'", 45);
  await rec.hold(400);
  await submitInput(page);
  await sleep(1000);
  await rec.hold(1200);

  await rec.typeInInput("ls -la", 70);
  await rec.hold(300);
  await submitInput(page);
  await sleep(1000);
  await rec.hold(1200);

  // New tab
  await page.keyboard.press("Meta+t");
  await sleep(1000);
  await rec.hold(1000);

  await rec.typeInInput("pwd", 80);
  await submitInput(page);
  await sleep(1000);
  await rec.hold(800);

  // Split pane
  await page.keyboard.press("Meta+d");
  await sleep(1200);
  await rec.hold(1500);

  // Switch to first tab
  const firstTab = page.locator('[data-testid^="tab-"]').first();
  await firstTab.click({ force: true });
  await sleep(800);
  await rec.hold(1200);

  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  rec.toGif("demo-terminal", 5);
}

// ─── Demo 2: Themes ───
async function demoThemes() {
  console.log("\n[2/6] Theme Switching");
  const { app, page, profile } = await launchApp();
  await setup(app, page, "dark");
  const rec = new Recorder(page, "themes");

  // Run a command so there's visible content
  await page.evaluate(() => {
    const all = document.querySelectorAll<HTMLTextAreaElement>(
      '[data-testid="smart-input-textarea"]',
    );
    for (const el of all) {
      if (getComputedStyle(el).visibility !== "hidden") {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, "value",
        )?.set;
        setter?.call(el, "echo 'Theme showcase' && ls");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
    }
  });
  await sleep(300);
  await submitInput(page);
  await sleep(1200);

  await rec.hold(2000); // Dark
  for (const theme of ["light", "modern", "dark"]) {
    await page.evaluate((t) => localStorage.setItem("tron_theme", t), theme);
    await page.reload();
    await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
    await sleep(1500);
    await rec.hold(theme === "dark" ? 1200 : 2000);
  }

  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  rec.toGif("demo-themes", 3);
}

// ─── Demo 3: Input Modes ───
async function demoModes() {
  console.log("\n[3/6] Input Modes");
  const { app, page, profile } = await launchApp();
  await setup(app, page);
  const rec = new Recorder(page, "modes");

  await rec.hold(600);

  // Command mode — type and run a command
  await rec.typeInInput("date", 80);
  await rec.hold(300);
  await submitInput(page);
  await sleep(800);
  await rec.hold(800);

  // Open mode menu
  await page.locator('[data-testid="mode-button"]').first().click({ force: true });
  await sleep(700);
  await rec.hold(1500);

  // Switch to advice via keyboard
  await page.keyboard.press("Escape");
  await sleep(300);
  await page.keyboard.press("Meta+2");
  await sleep(500);
  await rec.hold(800);

  // Type an advice prompt
  await rec.typeInInput("find large files over 100MB", 35);
  await rec.hold(1500);

  // Switch to agent mode
  await clearInput(page);
  await sleep(200);
  await page.keyboard.press("Meta+3");
  await sleep(500);
  await rec.hold(600);

  await rec.typeInInput("Create a hello world React app", 35);
  await rec.hold(1500);

  // Back to auto mode
  await page.keyboard.press("Meta+0");
  await sleep(500);
  await rec.hold(1000);

  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  rec.toGif("demo-modes", 5);
}

// ─── Demo 4: Advice Mode (with AI) ───
async function demoAdvice() {
  if (!buildAIConfig()) {
    console.log("\n[4/6] Advice Mode — SKIPPED (no AI config)");
    return;
  }
  console.log("\n[4/6] Advice Mode");
  const { app, page, profile } = await launchApp();
  await setup(app, page, "dark", true);
  const rec = new Recorder(page, "advice");

  await rec.hold(600);

  // Switch to advice mode
  await page.keyboard.press("Meta+2");
  await sleep(500);
  await rec.hold(600);

  // Type advice prompt and submit
  await rec.typeInInput("compress a folder into a tar.gz archive", 35);
  await rec.hold(500);
  await submitInput(page);

  // Wait for AI suggestion to appear (poll for the suggestion card)
  const maxWait = 30_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await sleep(400);
    await rec.snap();
    // Check if suggestion card has appeared and is no longer loading
    const state = await page.evaluate(() => {
      const suggestionEl = document.querySelector('[data-testid="smart-input-textarea"]');
      // Look for the suggestion card container
      const cards = document.querySelectorAll(".absolute.bottom-full");
      for (const card of cards) {
        if (getComputedStyle(card).visibility === "hidden") continue;
        // Check if it has "AI Suggestion" text and action buttons (Tab/Run)
        if (card.textContent?.includes("AI Suggestion")) {
          const hasButtons = card.textContent?.includes("Run");
          return { found: true, hasButtons };
        }
      }
      return { found: false, hasButtons: false };
    });
    if (state.found && state.hasButtons) break;
  }

  // Hold on the suggestion card with command + explanation + Run/Edit buttons
  await rec.hold(3000);

  // Dismiss the suggestion
  await page.keyboard.press("Escape");
  await sleep(500);
  await rec.hold(600);

  // Second advice: simpler question
  await clearInput(page);
  await rec.typeInInput("list all listening ports on this machine", 30);
  await rec.hold(400);
  await submitInput(page);

  // Wait for second suggestion
  const start2 = Date.now();
  while (Date.now() - start2 < maxWait) {
    await sleep(400);
    await rec.snap();
    const state = await page.evaluate(() => {
      const cards = document.querySelectorAll(".absolute.bottom-full");
      for (const card of cards) {
        if (getComputedStyle(card).visibility === "hidden") continue;
        if (card.textContent?.includes("AI Suggestion") && card.textContent?.includes("Run"))
          return true;
      }
      return false;
    });
    if (state) break;
  }

  await rec.hold(3000);

  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  rec.toGif("demo-advice", 4);
}

// ─── Demo 5: Agent Mode (with permission confirmations) ───
async function demoAgent() {
  if (!buildAIConfig()) {
    console.log("\n[5/6] Agent Mode — SKIPPED (no AI config)");
    return;
  }
  console.log(`\n[5/6] Agent (${testEnv.TEST_PROVIDER}/${testEnv.TEST_MODEL})`);
  const { app, page, profile } = await launchApp();
  await setup(app, page, "dark", true);
  const rec = new Recorder(page, "agent");

  await rec.hold(600);

  // Type agent prompt and submit with Cmd+Enter
  await rec.typeInInput(
    "Write a bash script that shows system info (hostname, uptime, disk usage) and run it",
    25,
  );
  await rec.hold(600);
  await submitAgent(page);
  await sleep(1500);

  // Do NOT enable auto-execute — let permission prompts appear naturally.
  // Poll: capture frames, click Allow when permission prompts appear.
  const maxWait = 90_000;
  const frameInterval = 500;
  const startTime = Date.now();
  let agentFinished = false;

  while (Date.now() - startTime < maxWait) {
    await rec.snap();
    await sleep(frameInterval);

    // Check for permission prompt and click Allow
    const allowBtn = page.locator('[data-testid="permission-allow"]').first();
    if (await allowBtn.isVisible({ timeout: 100 }).catch(() => false)) {
      // Hold on the permission prompt for a few frames so it's visible in the GIF
      await rec.hold(1800);
      await allowBtn.click({ force: true });
      await sleep(800);
      await rec.snap();
    }

    // Check if agent finished
    const status = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="agent-status"]');
      return el?.textContent || "";
    });
    if (status.toLowerCase().includes("complete") || status.toLowerCase().includes("done")) {
      agentFinished = true;
      break;
    }
  }

  // Hold on final state
  await rec.hold(3000);

  // If agent didn't finish, stop it
  if (!agentFinished) {
    const stopBtn = page.locator('[data-testid="stop-button"]').first();
    if (await stopBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await stopBtn.click({ force: true });
      await sleep(500);
    }
    await rec.hold(1200);
  }

  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  rec.toGif("demo-agent", 4);
}

// ─── Demo 6: Settings ───
async function demoSettings() {
  console.log("\n[6/6] Settings");
  const { app, page, profile } = await launchApp();
  await setup(app, page);
  const rec = new Recorder(page, "settings");

  await rec.hold(500);

  await page.locator('[data-testid="tab-settings"]').click({ force: true });
  await sleep(1200);
  await rec.hold(1800);

  for (const section of ["viewmode", "appearance", "shortcuts"]) {
    const nav = page.locator(`[data-testid="settings-nav-${section}"]`);
    if (await nav.count() > 0) {
      await nav.click({ force: true });
      await sleep(800);
      await rec.hold(1800);
    }
  }

  const aiNav = page.locator('[data-testid="settings-nav-ai"]');
  if (await aiNav.count() > 0) {
    await aiNav.click({ force: true });
    await sleep(800);
    await rec.hold(1200);
  }

  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  rec.toGif("demo-settings", 3);
}

// ─── Main ───
async function main() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  fs.mkdirSync(VIDEOS_DIR, { recursive: true });

  console.log(
    "AI config:",
    testEnv.TEST_PROVIDER
      ? `${testEnv.TEST_PROVIDER}/${testEnv.TEST_MODEL} @ ${testEnv.TEST_BASE_URL || "default"}`
      : "none (AI demos will be skipped)",
  );

  await demoTerminal();
  await demoThemes();
  await demoModes();
  await demoAdvice();
  await demoAgent();
  await demoSettings();

  // Cleanup temp frames
  fs.rmSync(VIDEOS_DIR, { recursive: true, force: true });

  console.log("\n✓ All demos complete! GIFs saved to screenshots/");
  for (const f of fs.readdirSync(SCREENSHOTS_DIR).filter((f: string) => f.endsWith(".gif"))) {
    const mb = (fs.statSync(path.join(SCREENSHOTS_DIR, f)).size / 1024 / 1024).toFixed(1);
    console.log(`  ${f} (${mb} MB)`);
  }
}

main().catch((e) => {
  console.error("Failed:", e);
  process.exit(1);
});
