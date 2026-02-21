import { test, expect } from "../fixtures/app";
import { sel } from "../helpers/selectors";

test.describe("App Launch", () => {
  // Onboarding is skipped by the fixture (app.ts sets localStorage + reloads)

  test("window opens and has a title", async ({ electronApp, page }) => {
    const title = await page.title();
    // The app should have some title (Tron or similar)
    expect(title).toBeTruthy();

    // Verify the window is visible
    const isVisible = await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win?.isVisible() ?? false;
    });
    expect(isVisible).toBe(true);
  });

  test("tab bar is visible with at least one tab", async ({ page }) => {
    const tabBar = page.locator(sel.tabBar);
    await expect(tabBar).toBeVisible({ timeout: 10_000 });

    // There should be at least one tab in the tab bar
    const tabs = tabBar.locator('[data-testid^="tab-"]').filter({
      hasNot: page.locator('[data-testid="tab-create"], [data-testid="tab-settings"]'),
    });
    const tabCount = await tabs.count();
    expect(tabCount).toBeGreaterThanOrEqual(1);
  });

  test("terminal renders with xterm-screen present", async ({ page }) => {
    // Wait for the xterm terminal to initialize
    const xtermScreen = page.locator(".xterm-screen");
    await expect(xtermScreen).toBeVisible({ timeout: 15_000 });
  });

  test("SmartInput is visible and contains a textarea", async ({ page }) => {
    const smartInput = page.locator(sel.smartInput);
    await expect(smartInput).toBeVisible({ timeout: 10_000 });

    const textarea = page.locator(sel.smartInputTextarea);
    await expect(textarea).toBeVisible();
    // Textarea should be editable
    await expect(textarea).toBeEnabled();
  });

  test("create tab button and settings button are visible", async ({ page }) => {
    const createBtn = page.locator(sel.tabCreate);
    await expect(createBtn).toBeVisible({ timeout: 10_000 });

    const settingsBtn = page.locator(sel.tabSettings);
    await expect(settingsBtn).toBeVisible();
  });

  test("no console errors on launch", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        errors.push(msg.text());
      }
    });

    // Reload to capture errors from a fresh load
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Wait a moment for any async errors to surface
    await page.waitForTimeout(3_000);

    // Filter out known benign errors (e.g., network requests that may fail in test)
    const criticalErrors = errors.filter(
      (e) =>
        !e.includes("net::ERR_") &&
        !e.includes("Failed to fetch") &&
        !e.includes("favicon"),
    );

    expect(criticalErrors).toEqual([]);
  });
});
