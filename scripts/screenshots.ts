/**
 * Capture screenshots of Tron for README documentation.
 * Uses Playwright to launch the Electron app and take screenshots of key screens.
 *
 * Usage: npx playwright test scripts/screenshots.ts --config e2e/playwright.config.ts --headed
 *   or:  SHOW_UI=true npx playwright test scripts/screenshots.ts --config e2e/playwright.config.ts
 */
import { _electron, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = path.resolve(__dirname, "../screenshots");

async function main() {
  console.log("Launching Tron...");

  const app = await _electron.launch({
    args: [path.resolve(__dirname, "../dist-electron/main.js")],
    env: {
      ...process.env,
      NODE_ENV: "test",
      TRON_TEST_PROFILE: path.join(__dirname, `../.screenshots-profile-${Date.now()}`),
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  // Set window size for consistent screenshots
  await page.setViewportSize({ width: 1280, height: 800 });

  // --- Screenshot 1: Onboarding / Welcome ---
  console.log("Capturing onboarding...");
  await page.waitForTimeout(2000);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "onboarding.png"),
    animations: "disabled",
  });

  // Dismiss onboarding by injecting config
  await page.evaluate(() => {
    localStorage.setItem("tron_configured", "true");
    localStorage.setItem("tron_tutorial_completed", "true");
    localStorage.setItem("tron_theme", "dark");
    localStorage.setItem("tron_view_mode", "terminal");
  });
  await page.reload();
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.waitForTimeout(1500);

  // --- Screenshot 2: Main terminal (dark theme) ---
  console.log("Capturing main terminal (dark)...");
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "terminal-dark.png"),
    animations: "disabled",
  });

  // --- Screenshot 3: Light theme ---
  console.log("Capturing light theme...");
  await page.evaluate(() => {
    localStorage.setItem("tron_theme", "light");
  });
  await page.reload();
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "terminal-light.png"),
    animations: "disabled",
  });

  // --- Screenshot 4: Modern theme ---
  console.log("Capturing modern theme...");
  await page.evaluate(() => {
    localStorage.setItem("tron_theme", "modern");
  });
  await page.reload();
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, "terminal-modern.png"),
    animations: "disabled",
  });

  // Switch back to dark for remaining screenshots
  await page.evaluate(() => {
    localStorage.setItem("tron_theme", "dark");
  });
  await page.reload();
  await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });
  await page.waitForTimeout(1500);

  // --- Screenshot 5: Settings pane ---
  console.log("Capturing settings...");
  const settingsTab = page.locator('[data-testid="tab-settings"]');
  if (await settingsTab.isVisible()) {
    await settingsTab.click();
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "settings.png"),
      animations: "disabled",
    });

    // Click back to first tab
    const firstTab = page.locator('[data-testid^="tab-"]').first();
    await firstTab.click();
    await page.waitForTimeout(500);
  }

  // --- Screenshot 6: Mode switcher (show mode menu) ---
  console.log("Capturing mode switcher...");
  const modeBtn = page.locator('[data-testid="mode-button"]').first();
  if (await modeBtn.isVisible()) {
    await modeBtn.click();
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "mode-switcher.png"),
      animations: "disabled",
    });
    // Close menu
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }

  // --- Screenshot 7: Context bar with model selector ---
  console.log("Capturing model selector...");
  const modelSelector = page.locator('[data-testid="model-selector"]').first();
  if (await modelSelector.isVisible()) {
    await modelSelector.click();
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, "model-selector.png"),
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }

  console.log(`Screenshots saved to ${SCREENSHOTS_DIR}`);
  await app.close();
}

main().catch((e) => {
  console.error("Screenshot capture failed:", e);
  process.exit(1);
});
