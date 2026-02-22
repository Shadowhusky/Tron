import { test, expect } from "../fixtures/web";
import { sel } from "../helpers/selectors";

test.describe("Web Mode", () => {
  test("app loads without errors", async ({ page }) => {
    // Tab bar should be visible
    await expect(page.locator(sel.tabBar)).toBeVisible({ timeout: 10_000 });

    // At least one tab should exist
    const tabs = page.locator('[data-testid^="tab-"]').filter({
      hasNot: page.locator('[data-testid="tab-create"], [data-testid="tab-settings"], [data-testid^="tab-close-"], [data-testid="tab-create-dropdown"]'),
    });
    const tabCount = await tabs.count();
    expect(tabCount).toBeGreaterThanOrEqual(1);
  });

  test("no console errors about readSessions or writeSessions", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));

    // Navigate fresh to catch startup errors
    await page.reload();
    await page.waitForSelector(sel.tabBar, { timeout: 15_000 });

    // Wait for any async errors to surface
    await page.waitForTimeout(2_000);

    const sessionErrors = errors.filter(
      (e) => e.includes("readSessions") || e.includes("writeSessions")
    );
    expect(sessionErrors).toHaveLength(0);
  });

  test("smart input is functional", async ({ page }) => {
    // SmartInput should be visible and interactable
    const smartInput = page.locator(sel.smartInput);
    await expect(smartInput.locator("visible=true").first()).toBeVisible({ timeout: 10_000 });
  });

  test("can create a new tab", async ({ page }) => {
    const tabBar = page.locator(sel.tabBar);
    const tabFilter = '[data-testid="tab-create"], [data-testid="tab-settings"], [data-testid^="tab-close-"], [data-testid="tab-create-terminal"], [data-testid="tab-create-ssh"], [data-testid="tab-create-dropdown"]';
    const initialTabs = await tabBar.locator('[data-testid^="tab-"]').filter({
      hasNot: page.locator(tabFilter),
    }).count();

    // Click + to create a new tab
    await page.locator(sel.tabCreate).click();
    await page.waitForTimeout(1_000);

    const newTabs = await tabBar.locator('[data-testid^="tab-"]').filter({
      hasNot: page.locator(tabFilter),
    }).count();
    expect(newTabs).toBe(initialTabs + 1);
  });

  test("settings tab opens", async ({ page }) => {
    await page.locator(sel.tabSettings).click();
    await page.waitForTimeout(1_000);

    const providerSelect = page.locator(sel.providerSelect);
    await expect(providerSelect).toBeVisible({ timeout: 5_000 });
  });
});
