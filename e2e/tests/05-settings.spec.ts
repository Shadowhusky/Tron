import { test, expect } from "../fixtures/app";
import { sel } from "../helpers/selectors";

test.describe("Settings", () => {
  test.beforeEach(async ({ page }) => {
    // Open the settings tab
    await expect(page.locator(sel.tabSettings)).toBeVisible({ timeout: 10_000 });
    await page.locator(sel.tabSettings).click();
    await page.waitForTimeout(1_000);
    // Wait for the provider select to confirm settings pane rendered
    await expect(page.locator(sel.providerSelect)).toBeVisible({ timeout: 10_000 });
  });

  test("all navigation sections are visible", async ({ page }) => {
    const sections = ["ai", "view", "appearance", "shortcuts"];
    for (const section of sections) {
      const nav = page.locator(sel.settingsNav(section));
      await expect(nav).toBeVisible();
    }
  });

  test("can click each navigation section", async ({ page }) => {
    const sections = ["ai", "view", "appearance", "shortcuts"];
    for (const section of sections) {
      const nav = page.locator(sel.settingsNav(section));
      await nav.click();
      await page.waitForTimeout(500);
      // The nav button should still be visible after clicking
      await expect(nav).toBeVisible();
    }
  });

  test("provider select is visible and has options", async ({ page }) => {
    const providerSelect = page.locator(sel.providerSelect);
    await expect(providerSelect).toBeVisible();

    // Verify it has optgroups (Local / Cloud / Custom)
    const optgroups = providerSelect.locator("optgroup");
    const count = await optgroups.count();
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("can change provider selection", async ({ page }) => {
    const providerSelect = page.locator(sel.providerSelect);

    // Get the initial value
    const initialValue = await providerSelect.inputValue();

    // Change to anthropic provider
    await providerSelect.selectOption("anthropic");
    await page.waitForTimeout(500);

    const newValue = await providerSelect.inputValue();
    expect(newValue).toBe("anthropic");

    // If initial was already anthropic, switch to openai instead
    if (initialValue === "anthropic") {
      await providerSelect.selectOption("openai");
      await page.waitForTimeout(500);
      const switchedValue = await providerSelect.inputValue();
      expect(switchedValue).toBe("openai");
    }
  });

  test("save button exists and reflects dirty state", async ({ page }) => {
    const saveButton = page.locator(sel.saveButton);
    await expect(saveButton).toBeVisible();

    // Initially no changes so save button should be disabled
    await expect(saveButton).toBeDisabled();

    // Change the provider to trigger dirty state
    const providerSelect = page.locator(sel.providerSelect);
    const currentProvider = await providerSelect.inputValue();
    const newProvider = currentProvider === "anthropic" ? "openai" : "anthropic";
    await providerSelect.selectOption(newProvider);
    await page.waitForTimeout(500);

    // Now the save button should be enabled (has changes)
    await expect(saveButton).toBeEnabled({ timeout: 3_000 });
  });

  test("theme buttons are visible in appearance section", async ({ page }) => {
    // Navigate to appearance section
    await page.locator(sel.settingsNav("appearance")).click();
    await page.waitForTimeout(500);

    // Verify all theme buttons exist
    const themes = ["light", "dark", "system", "modern"];
    for (const themeId of themes) {
      const themeBtn = page.locator(sel.themeButton(themeId));
      await expect(themeBtn).toBeVisible({ timeout: 5_000 });
    }
  });

  test("can click theme buttons to change theme", async ({ page }) => {
    // Navigate to appearance section
    await page.locator(sel.settingsNav("appearance")).click();
    await page.waitForTimeout(500);

    // Click the light theme button
    await page.locator(sel.themeButton("light")).click();
    await page.waitForTimeout(500);

    // Click the dark theme button
    await page.locator(sel.themeButton("dark")).click();
    await page.waitForTimeout(500);

    // Click the modern theme button
    await page.locator(sel.themeButton("modern")).click();
    await page.waitForTimeout(500);

    // Verify the buttons remain interactive (no crash)
    await expect(page.locator(sel.themeButton("modern"))).toBeVisible();
  });

  test("changing provider shows relevant fields", async ({ page }) => {
    const providerSelect = page.locator(sel.providerSelect);

    // Switch to a cloud provider that requires an API key
    await providerSelect.selectOption("anthropic");
    await page.waitForTimeout(1_000);

    // API key input should appear for cloud providers
    const apiKeyInput = page.locator(sel.apiKeyInput);
    await expect(apiKeyInput).toBeVisible({ timeout: 5_000 });
  });

  test("local provider shows base URL field", async ({ page }) => {
    const providerSelect = page.locator(sel.providerSelect);

    // Switch to Ollama (local provider with base URL)
    await providerSelect.selectOption("ollama");
    await page.waitForTimeout(1_000);

    // Base URL input should be visible for local providers
    const baseUrlInput = page.locator(sel.baseUrlInput);
    await expect(baseUrlInput).toBeVisible({ timeout: 5_000 });
  });

  test("save button shows saved state after saving", async ({ page }) => {
    // Make a change to enable save
    const providerSelect = page.locator(sel.providerSelect);
    const currentProvider = await providerSelect.inputValue();
    const newProvider = currentProvider === "anthropic" ? "openai" : "anthropic";
    await providerSelect.selectOption(newProvider);
    await page.waitForTimeout(500);

    // Click save
    const saveButton = page.locator(sel.saveButton);
    await expect(saveButton).toBeEnabled({ timeout: 3_000 });
    await saveButton.click();
    await page.waitForTimeout(1_000);

    // After saving, the button should become disabled again (no more changes)
    // or show a "saved" state briefly
    // Give it time to transition back to disabled
    await expect(saveButton).toBeDisabled({ timeout: 5_000 });
  });
});
