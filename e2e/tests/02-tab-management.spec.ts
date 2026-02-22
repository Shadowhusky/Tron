import { test, expect } from "../fixtures/app";
import { sel } from "../helpers/selectors";

test.describe("Tab Management", () => {
  test.beforeEach(async ({ page }) => {
    // Wait for the tab bar to be fully rendered
    await expect(page.locator(sel.tabBar)).toBeVisible({ timeout: 10_000 });
  });

  test("can create a new tab", async ({ page }) => {
    // Count initial tabs
    const tabBar = page.locator(sel.tabBar);
    const tabFilter = '[data-testid="tab-create"], [data-testid="tab-settings"], [data-testid^="tab-close-"], [data-testid="tab-create-terminal"], [data-testid="tab-create-ssh"], [data-testid="tab-create-dropdown"]';
    const initialTabs = await tabBar.locator('[data-testid^="tab-"]').filter({
      hasNot: page.locator(tabFilter),
    }).count();

    // Click the + button (directly creates a new terminal tab)
    await page.locator(sel.tabCreate).click();
    await page.waitForTimeout(1_000);

    // Verify a new tab was added
    const newTabs = await tabBar.locator('[data-testid^="tab-"]').filter({
      hasNot: page.locator(tabFilter),
    }).count();
    expect(newTabs).toBe(initialTabs + 1);
  });

  test("can switch between tabs", async ({ page }) => {
    // Create a second tab so we have two
    await page.locator(sel.tabCreate).click();
    await page.waitForTimeout(1_000);

    // Get all tab elements (excluding create/settings/close/dropdown buttons)
    const tabBar = page.locator(sel.tabBar);
    const tabFilter = '[data-testid="tab-create"], [data-testid="tab-settings"], [data-testid^="tab-close-"], [data-testid="tab-create-terminal"], [data-testid="tab-create-ssh"], [data-testid="tab-create-dropdown"]';
    const tabs = tabBar.locator('[data-testid^="tab-"]').filter({
      hasNot: page.locator(tabFilter),
    });

    const tabCount = await tabs.count();
    expect(tabCount).toBeGreaterThanOrEqual(2);

    // Click the first tab
    await tabs.first().click();
    await page.waitForTimeout(500);

    // Click the second tab
    await tabs.nth(1).click();
    await page.waitForTimeout(500);

    // The terminal and smart input should still be visible after switching
    // Because tabs stay mounted, there are multiple smart inputs, we just check the first visible one.
    await expect(page.locator(sel.smartInput).locator('visible=true').first()).toBeVisible();
  });

  test("can close a tab", async ({ page }) => {
    // Create a second tab
    await page.locator(sel.tabCreate).click();
    await page.waitForTimeout(1_000);

    const tabBar = page.locator(sel.tabBar);
    const tabFilter = '[data-testid="tab-create"], [data-testid="tab-settings"], [data-testid^="tab-close-"], [data-testid="tab-create-terminal"], [data-testid="tab-create-ssh"], [data-testid="tab-create-dropdown"]';
    const getTabCount = async () =>
      tabBar
        .locator('[data-testid^="tab-"]')
        .filter({
          hasNot: page.locator(tabFilter),
        })
        .count();

    const countBefore = await getTabCount();
    expect(countBefore).toBeGreaterThanOrEqual(2);

    // Find a close button on any tab and click it
    const closeButtons = tabBar.locator('[data-testid^="tab-close-"]');
    const closeCount = await closeButtons.count();
    expect(closeCount).toBeGreaterThan(0);

    // Hover over a tab to reveal the close button, then click it
    // Close buttons may only appear on hover, so hover first
    const tabs = tabBar.locator('[data-testid^="tab-"]').filter({
      hasNot: page.locator(tabFilter),
    });
    await tabs.last().hover();
    await page.waitForTimeout(300);

    // Now click the close button
    const visibleCloseBtn = tabBar.locator('[data-testid^="tab-close-"]').last();
    await visibleCloseBtn.click();
    await page.waitForTimeout(1_000);

    const countAfter = await getTabCount();
    expect(countAfter).toBe(countBefore - 1);
  });

  test("can open settings tab", async ({ page }) => {
    // Click settings button
    await page.locator(sel.tabSettings).click();
    await page.waitForTimeout(1_000);

    // Verify the settings pane is now visible
    const providerSelect = page.locator(sel.providerSelect);
    await expect(providerSelect).toBeVisible({ timeout: 5_000 });

    // Verify settings sidebar navigation is visible
    const aiNav = page.locator(sel.settingsNav("ai"));
    await expect(aiNav).toBeVisible();
  });

  test("settings pane renders all navigation sections", async ({ page }) => {
    await page.locator(sel.tabSettings).click();
    await page.waitForTimeout(1_000);

    // All six navigation sections should be visible
    const sections = ["ai", "ai-features", "view", "appearance", "ssh", "shortcuts"];
    for (const section of sections) {
      const nav = page.locator(sel.settingsNav(section));
      await expect(nav).toBeVisible({ timeout: 5_000 });
    }
  });
});
