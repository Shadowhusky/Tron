import { test as base, _electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type AppFixture = {
  electronApp: ElectronApplication;
  page: Page;
};

/**
 * Bypass the onboarding wizard by injecting localStorage state and reloading.
 * This is 100% reliable compared to UI click-throughs which fail due to Framer Motion transitions.
 */
async function dismissOnboarding(page: Page): Promise<void> {
  // Inject required localStorage keys
  await page.evaluate(() => {
    localStorage.setItem("tron_configured", "true");
    localStorage.setItem("tron_tutorial_completed", "true");
    localStorage.setItem("tron_theme", "dark");
    localStorage.setItem("tron_view_mode", "terminal");
  });

  // Reload the Electron BrowserWindow to apply the injected state cleanly
  await page.reload();
}

export const test = base.extend<AppFixture>({
  electronApp: async ({ }, use) => {
    // Isolate test data from the user's real application data
    const profilePath = path.join(__dirname, `../.test-profile-${Date.now()}`);

    const app = await _electron.launch({
      args: [path.resolve(__dirname, "../../dist-electron/main.js")],
      env: {
        ...process.env,
        NODE_ENV: "test",
        TRON_TEST_PROFILE: profilePath,
      },
    });
    await use(app);
    await app.close();
  },

  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();

    // Debug logging to catch hidden React crashes
    page.on("console", (msg) => console.log(`[Browser Console]: ${msg.text()}`));
    page.on("pageerror", (err) => console.log(`[Browser Error]: ${err.message}`));

    await page.waitForLoadState("domcontentloaded");

    // Dismiss onboarding wizard if it appears on first launch
    await dismissOnboarding(page);

    // Wait for the main UI to be ready
    await page.waitForSelector('[data-testid="tab-bar"]', { timeout: 15_000 });

    await use(page);
  },
});

export { expect } from "@playwright/test";
