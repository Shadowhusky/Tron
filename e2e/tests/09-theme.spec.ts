import { test, expect } from "../fixtures/app";
import { sel } from "../helpers/selectors";

test.describe("Theme Settings", () => {
  // Onboarding is skipped by the fixture (app.ts sets localStorage + reloads)

  test("open settings and switch to light theme", async ({ page }) => {
    // Open settings via the tab bar settings button
    const settingsTab = page.locator(sel.tabSettings);
    await expect(settingsTab).toBeVisible({ timeout: 15_000 });
    await settingsTab.click();

    // Navigate to appearance section in settings
    const appearanceNav = page.locator(sel.settingsNav("appearance"));
    await expect(appearanceNav).toBeVisible({ timeout: 10_000 });
    await appearanceNav.click();

    // Click the light theme button
    const lightBtn = page.locator(sel.themeButton("light"));
    await expect(lightBtn).toBeVisible({ timeout: 5_000 });
    await lightBtn.click();

    // Verify localStorage updated
    const themeValue = await page.evaluate(() =>
      localStorage.getItem("tron_theme"),
    );
    expect(themeValue).toBe("light");
  });

  test("switch to dark theme", async ({ page }) => {
    const settingsTab = page.locator(sel.tabSettings);
    await expect(settingsTab).toBeVisible({ timeout: 15_000 });
    await settingsTab.click();

    const appearanceNav = page.locator(sel.settingsNav("appearance"));
    await expect(appearanceNav).toBeVisible({ timeout: 10_000 });
    await appearanceNav.click();

    const darkBtn = page.locator(sel.themeButton("dark"));
    await expect(darkBtn).toBeVisible({ timeout: 5_000 });
    await darkBtn.click();

    const themeValue = await page.evaluate(() =>
      localStorage.getItem("tron_theme"),
    );
    expect(themeValue).toBe("dark");
  });

  test("switch to system theme", async ({ page }) => {
    const settingsTab = page.locator(sel.tabSettings);
    await expect(settingsTab).toBeVisible({ timeout: 15_000 });
    await settingsTab.click();

    const appearanceNav = page.locator(sel.settingsNav("appearance"));
    await expect(appearanceNav).toBeVisible({ timeout: 10_000 });
    await appearanceNav.click();

    const systemBtn = page.locator(sel.themeButton("system"));
    await expect(systemBtn).toBeVisible({ timeout: 5_000 });
    await systemBtn.click();

    const themeValue = await page.evaluate(() =>
      localStorage.getItem("tron_theme"),
    );
    expect(themeValue).toBe("system");
  });

  test("switch to modern theme", async ({ page }) => {
    const settingsTab = page.locator(sel.tabSettings);
    await expect(settingsTab).toBeVisible({ timeout: 15_000 });
    await settingsTab.click();

    const appearanceNav = page.locator(sel.settingsNav("appearance"));
    await expect(appearanceNav).toBeVisible({ timeout: 10_000 });
    await appearanceNav.click();

    const modernBtn = page.locator(sel.themeButton("modern"));
    await expect(modernBtn).toBeVisible({ timeout: 5_000 });
    await modernBtn.click();

    const themeValue = await page.evaluate(() =>
      localStorage.getItem("tron_theme"),
    );
    expect(themeValue).toBe("modern");
  });

  test("cycle through all themes and verify each update", async ({ page }) => {
    const settingsTab = page.locator(sel.tabSettings);
    await expect(settingsTab).toBeVisible({ timeout: 15_000 });
    await settingsTab.click();

    const appearanceNav = page.locator(sel.settingsNav("appearance"));
    await expect(appearanceNav).toBeVisible({ timeout: 10_000 });
    await appearanceNav.click();

    const themes = ["light", "dark", "system", "modern"] as const;

    for (const themeId of themes) {
      const btn = page.locator(sel.themeButton(themeId));
      await expect(btn).toBeVisible({ timeout: 5_000 });
      await btn.click();

      const stored = await page.evaluate(() =>
        localStorage.getItem("tron_theme"),
      );
      expect(stored).toBe(themeId);
    }
  });

  test("theme persists after page reload", async ({ page }) => {
    // Open settings and set theme to modern
    const settingsTab = page.locator(sel.tabSettings);
    await expect(settingsTab).toBeVisible({ timeout: 15_000 });
    await settingsTab.click();

    const appearanceNav = page.locator(sel.settingsNav("appearance"));
    await expect(appearanceNav).toBeVisible({ timeout: 10_000 });
    await appearanceNav.click();

    const modernBtn = page.locator(sel.themeButton("modern"));
    await expect(modernBtn).toBeVisible({ timeout: 5_000 });
    await modernBtn.click();

    // Verify it was set
    let themeValue = await page.evaluate(() =>
      localStorage.getItem("tron_theme"),
    );
    expect(themeValue).toBe("modern");

    // Reload the page (keep localStorage)
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Verify theme is still modern after reload
    themeValue = await page.evaluate(() =>
      localStorage.getItem("tron_theme"),
    );
    expect(themeValue).toBe("modern");

    // Re-open settings and verify the modern button still appears selected
    // (we check by navigating back to settings)
    const settingsTabAfterReload = page.locator(sel.tabSettings);
    await expect(settingsTabAfterReload).toBeVisible({ timeout: 15_000 });
    await settingsTabAfterReload.click();

    const appearanceNavAfterReload = page.locator(sel.settingsNav("appearance"));
    await expect(appearanceNavAfterReload).toBeVisible({ timeout: 10_000 });
    await appearanceNavAfterReload.click();

    // The modern theme button should still be visible and accessible
    const modernBtnAfterReload = page.locator(sel.themeButton("modern"));
    await expect(modernBtnAfterReload).toBeVisible({ timeout: 5_000 });
  });
});
