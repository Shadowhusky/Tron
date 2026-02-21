import { test, expect } from "../fixtures/app";
import { sel } from "../helpers/selectors";

// All hotkey actions defined in the SettingsPane (matches HOTKEY_LABELS keys)
const HOTKEY_ACTIONS = [
  "openSettings",
  "toggleOverlay",
  "stopAgent",
  "clearTerminal",
  "clearAgent",
  "modeCommand",
  "modeAdvice",
  "modeAgent",
  "modeAuto",
  "forceAgent",
  "forceCommand",
];

test.describe("Keyboard Shortcuts Settings", () => {
  test.beforeEach(async ({ page }) => {
    // Open settings
    const settingsTab = page.locator(sel.tabSettings);
    await expect(settingsTab).toBeVisible({ timeout: 15_000 });
    await settingsTab.click();

    // Navigate to shortcuts section
    const shortcutsNav = page.locator(sel.settingsNav("shortcuts"));
    await expect(shortcutsNav).toBeVisible({ timeout: 10_000 });
    await shortcutsNav.click();
  });

  test("all hotkey buttons are visible", async ({ page }) => {
    for (const action of HOTKEY_ACTIONS) {
      const hotkeyBtn = page.locator(sel.hotkeyButton(action));
      await expect(hotkeyBtn).toBeVisible({ timeout: 5_000 });
    }
  });

  test("clicking a hotkey button enters recording mode", async ({ page }) => {
    // Click the openSettings hotkey button to start recording
    const hotkeyBtn = page.locator(sel.hotkeyButton("openSettings"));
    await expect(hotkeyBtn).toBeVisible({ timeout: 5_000 });
    await hotkeyBtn.click();

    // Should now show "Press keys..." text indicating recording mode
    await expect(hotkeyBtn).toContainText("Press keys", { timeout: 3_000 });
  });

  test("pressing Escape cancels hotkey recording", async ({ page }) => {
    // Click a hotkey button to enter recording mode
    const hotkeyBtn = page.locator(sel.hotkeyButton("toggleOverlay"));
    await expect(hotkeyBtn).toBeVisible({ timeout: 5_000 });

    // Remember the original text before recording
    const originalText = await hotkeyBtn.textContent();
    expect(originalText).toBeTruthy();

    // Enter recording mode
    await hotkeyBtn.click();
    await expect(hotkeyBtn).toContainText("Press keys", { timeout: 3_000 });

    // Press Escape to cancel
    await page.keyboard.press("Escape");

    // Should revert to the original hotkey display (no longer recording)
    await expect(hotkeyBtn).not.toContainText("Press keys", { timeout: 3_000 });
  });

  test("recording a new hotkey updates the button display", async ({ page }) => {
    // Click the clearTerminal hotkey button
    const hotkeyBtn = page.locator(sel.hotkeyButton("clearTerminal"));
    await expect(hotkeyBtn).toBeVisible({ timeout: 5_000 });
    await hotkeyBtn.click();

    // Should be in recording mode
    await expect(hotkeyBtn).toContainText("Press keys", { timeout: 3_000 });

    // Press a key combo (Ctrl+Shift+L)
    await page.keyboard.press("Control+Shift+l");

    // Should exit recording mode — button text should update
    await expect(hotkeyBtn).not.toContainText("Press keys", { timeout: 3_000 });
  });

  test("only one hotkey can be recorded at a time", async ({ page }) => {
    // Click the first hotkey button to enter recording
    const firstBtn = page.locator(sel.hotkeyButton("openSettings"));
    await firstBtn.click();
    await expect(firstBtn).toContainText("Press keys", { timeout: 3_000 });

    // Press Escape to cancel
    await page.keyboard.press("Escape");
    await expect(firstBtn).not.toContainText("Press keys", { timeout: 3_000 });

    // Click a different hotkey button
    const secondBtn = page.locator(sel.hotkeyButton("stopAgent"));
    await secondBtn.click();
    await expect(secondBtn).toContainText("Press keys", { timeout: 3_000 });

    // First button should not be in recording mode
    await expect(firstBtn).not.toContainText("Press keys");

    // Cancel the second recording
    await page.keyboard.press("Escape");
    await expect(secondBtn).not.toContainText("Press keys", { timeout: 3_000 });
  });

  test("shortcuts section has a Reset button", async ({ page }) => {
    // The shortcuts section header has a Reset button
    // Look for a button containing "Reset" text near the shortcuts section
    const resetButton = page.locator('#shortcuts button:has-text("Reset")');
    await expect(resetButton).toBeVisible({ timeout: 5_000 });
  });
});
