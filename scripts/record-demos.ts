/**
 * Record animated GIF demos of Tron features for README.
 * Takes rapid Playwright screenshots → combines with ffmpeg into GIF.
 *
 * Usage: npx tsx scripts/record-demos.ts
 * Requires: ffmpeg, built app (npm run build:react && npm run build:electron)
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

/**
 * All interactions with SmartInput go through page.evaluate() because:
 * - All tabs render simultaneously (visibility: hidden/visible pattern)
 * - Playwright's locator actionability checks reject "not visible" elements
 * - We need to find the VISIBLE textarea (computed visibility !== 'hidden')
 * - The native value setter + input event dispatch triggers React's onChange
 */

/** Find the visible SmartInput textarea (not in a hidden tab) */
const FIND_VISIBLE_TEXTAREA = `
  (() => {
    const all = document.querySelectorAll('[data-testid="smart-input-textarea"]');
    for (const el of all) {
      if (getComputedStyle(el).visibility !== 'hidden') return el;
    }
    return all[all.length - 1]; // fallback to last
  })()
`;

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

  /** Snap several frames with delay between each (for holding on a state) */
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
        // Use native setter to bypass React's controlled input tracking
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value",
        )?.set;
        setter?.call(el, val);
        // Fire input event so React's onChange fires
        el.dispatchEvent(new Event("input", { bubbles: true }));
        // Auto-resize textarea height
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";
      }, partial);
      await sleep(charDelay);
      if (i % 3 === 0 || i === text.length - 1) await this.snap();
    }
    // Wait for React startTransition to process state update
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

async function setup(app: ElectronApplication, page: Page, theme = "dark") {
  await page.evaluate(
    (t) => {
      localStorage.setItem("tron_configured", "true");
      localStorage.setItem("tron_tutorial_completed", "true");
      localStorage.setItem("tron_theme", t);
      localStorage.setItem("tron_view_mode", "terminal");
    },
    theme,
  );
  await page.reload();
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  // Resize the actual Electron window
  await app.evaluate(({ BrowserWindow }: any) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.setSize(1280, 800);
      win.center();
    }
  });
  await sleep(1500);
}

/** Focus the visible SmartInput textarea */
async function focusInput(page: Page) {
  await page.evaluate(() => {
    const all = document.querySelectorAll<HTMLTextAreaElement>(
      '[data-testid="smart-input-textarea"]',
    );
    for (const el of all) {
      if (getComputedStyle(el).visibility !== "hidden") {
        el.scrollIntoView();
        el.focus();
        return;
      }
    }
    // fallback
    if (all.length > 0) {
      all[all.length - 1].focus();
    }
  });
  await sleep(200);
}

/** Submit by dispatching Enter keydown on the visible textarea */
async function submitInput(page: Page) {
  await page.evaluate(() => {
    const all = document.querySelectorAll<HTMLTextAreaElement>(
      '[data-testid="smart-input-textarea"]',
    );
    let el: HTMLTextAreaElement | null = null;
    for (const t of all) {
      if (getComputedStyle(t).visibility !== "hidden") {
        el = t;
        break;
      }
    }
    if (!el && all.length > 0) el = all[all.length - 1] as HTMLTextAreaElement;
    if (!el) return;
    el.focus();
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
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
          window.HTMLTextAreaElement.prototype,
          "value",
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
  console.log("\n[1/4] Terminal + Tabs");
  const { app, page, profile } = await launchApp();
  await setup(app, page);
  const rec = new Recorder(page, "terminal");

  await rec.hold(800); // Show initial state

  // Type and run a command
  await rec.typeInInput("echo 'Hello from Tron!'", 45);
  await rec.hold(400);
  await submitInput(page);
  await sleep(1000);
  await rec.hold(1200); // Show output

  // Second command
  await rec.typeInInput("ls -la", 70);
  await rec.hold(300);
  await submitInput(page);
  await sleep(1000);
  await rec.hold(1200);

  // New tab via keyboard
  await page.keyboard.press("Meta+t");
  await sleep(1000);
  await rec.hold(1000);

  // Type in new tab
  await rec.typeInInput("pwd", 80);
  await submitInput(page);
  await sleep(1000);
  await rec.hold(800);

  // Split pane
  await page.keyboard.press("Meta+d");
  await sleep(1200);
  await rec.hold(1500);

  // Switch to first tab
  const tabs = page.locator('[data-testid^="tab-"]');
  const firstTab = tabs.first();
  await firstTab.click({ force: true });
  await sleep(800);
  await rec.hold(1200);

  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  rec.toGif("demo-terminal", 5);
}

// ─── Demo 2: Themes ───
async function demoThemes() {
  console.log("\n[2/4] Theme Switching");
  const { app, page, profile } = await launchApp();
  await setup(app, page, "dark");
  const rec = new Recorder(page, "themes");

  // Run a command so there's content visible
  await page.evaluate(() => {
    const all = document.querySelectorAll<HTMLTextAreaElement>(
      '[data-testid="smart-input-textarea"]',
    );
    for (const el of all) {
      if (getComputedStyle(el).visibility !== "hidden") {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value",
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

  // Dark
  await rec.hold(2000);

  // Light
  await page.evaluate(() => localStorage.setItem("tron_theme", "light"));
  await page.reload();
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await sleep(1500);
  await rec.hold(2000);

  // Modern
  await page.evaluate(() => localStorage.setItem("tron_theme", "modern"));
  await page.reload();
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await sleep(1500);
  await rec.hold(2000);

  // Back to dark
  await page.evaluate(() => localStorage.setItem("tron_theme", "dark"));
  await page.reload();
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await sleep(1500);
  await rec.hold(1200);

  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  rec.toGif("demo-themes", 3);
}

// ─── Demo 3: Input Modes ───
async function demoModes() {
  console.log("\n[3/4] Input Modes");
  const { app, page, profile } = await launchApp();
  await setup(app, page);
  const rec = new Recorder(page, "modes");

  await rec.hold(600);

  // Command mode — run a command
  await rec.typeInInput("date", 80);
  await rec.hold(300);
  await submitInput(page);
  await sleep(800);
  await rec.hold(800);

  // Open mode menu
  await page.locator('[data-testid="mode-button"]').first().click({ force: true });
  await sleep(700);
  await rec.hold(1500);

  // Close menu, switch to advice via keyboard
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

// ─── Demo 4: Settings ───
async function demoSettings() {
  console.log("\n[4/4] Settings");
  const { app, page, profile } = await launchApp();
  await setup(app, page);
  const rec = new Recorder(page, "settings");

  await rec.hold(500);

  // Open settings tab
  await page.locator('[data-testid="tab-settings"]').click({ force: true });
  await sleep(1200);
  await rec.hold(1800); // Show AI config section

  // Navigate sections
  for (const section of ["viewmode", "appearance", "shortcuts"]) {
    const nav = page.locator(`[data-testid="settings-nav-${section}"]`);
    if (await nav.count() > 0) {
      await nav.click({ force: true });
      await sleep(800);
      await rec.hold(1800);
    }
  }

  // Back to AI
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

  await demoTerminal();
  await demoThemes();
  await demoModes();
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
