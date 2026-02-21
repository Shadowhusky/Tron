import { test, expect } from "../fixtures/app";
import { sel } from "../helpers/selectors";

test.describe("SmartInput", () => {
  test.beforeEach(async ({ page }) => {
    await expect(page.locator(sel.smartInput)).toBeVisible({ timeout: 10_000 });
  });

  test("textarea accepts text input", async ({ page }) => {
    const textarea = page.locator(sel.smartInputTextarea);
    await textarea.click();
    await textarea.fill("test input text");
    await expect(textarea).toHaveValue("test input text");
  });

  test("mode button is visible and clickable", async ({ page }) => {
    const modeButton = page.locator(sel.modeButton);
    await expect(modeButton).toBeVisible({ timeout: 5_000 });

    // Click should open the mode menu
    await modeButton.click();
    await page.waitForTimeout(500);

    const modeMenu = page.locator(sel.modeMenu);
    await expect(modeMenu).toBeVisible({ timeout: 3_000 });
  });

  test("mode menu shows all mode options", async ({ page }) => {
    // Open the mode menu
    await page.locator(sel.modeButton).click();
    await page.waitForTimeout(500);

    const modeMenu = page.locator(sel.modeMenu);
    await expect(modeMenu).toBeVisible({ timeout: 3_000 });

    // Verify all four mode options are present
    const modes = ["auto", "command", "advice", "agent"];
    for (const mode of modes) {
      const option = page.locator(sel.modeOption(mode));
      await expect(option).toBeVisible();
    }
  });

  test("can switch to command mode", async ({ page }) => {
    // Open mode menu and select command
    await page.locator(sel.modeButton).click();
    await page.waitForTimeout(500);

    await page.locator(sel.modeOption("command")).click();
    await page.waitForTimeout(500);

    // The mode menu should close after selection
    const modeMenu = page.locator(sel.modeMenu);
    await expect(modeMenu).not.toBeVisible({ timeout: 3_000 });
  });

  test("can switch to agent mode", async ({ page }) => {
    // Open mode menu and select agent
    await page.locator(sel.modeButton).click();
    await page.waitForTimeout(500);

    await page.locator(sel.modeOption("agent")).click();
    await page.waitForTimeout(500);

    // Menu should close
    await expect(page.locator(sel.modeMenu)).not.toBeVisible({ timeout: 3_000 });
  });

  test("can switch to advice mode", async ({ page }) => {
    // Open mode menu and select advice
    await page.locator(sel.modeButton).click();
    await page.waitForTimeout(500);

    await page.locator(sel.modeOption("advice")).click();
    await page.waitForTimeout(500);

    await expect(page.locator(sel.modeMenu)).not.toBeVisible({ timeout: 3_000 });
  });

  test("can switch back to auto mode", async ({ page }) => {
    // First switch to command mode
    await page.locator(sel.modeButton).click();
    await page.waitForTimeout(500);
    await page.locator(sel.modeOption("command")).click();
    await page.waitForTimeout(500);

    // Now switch back to auto
    await page.locator(sel.modeButton).click();
    await page.waitForTimeout(500);
    await page.locator(sel.modeOption("auto")).click();
    await page.waitForTimeout(500);

    await expect(page.locator(sel.modeMenu)).not.toBeVisible({ timeout: 3_000 });
  });

  test("Shift+Enter creates a new line in textarea", async ({ page }) => {
    const textarea = page.locator(sel.smartInputTextarea);
    await textarea.click();

    // Type first line
    await textarea.pressSequentially("line one");
    // Press Shift+Enter for a new line
    await textarea.press("Shift+Enter");
    // Type second line
    await textarea.pressSequentially("line two");

    // The value should contain both lines separated by a newline
    const value = await textarea.inputValue();
    expect(value).toContain("line one");
    expect(value).toContain("line two");
    expect(value.split("\n").length).toBeGreaterThanOrEqual(2);
  });

  test("clicking outside mode menu closes it", async ({ page }) => {
    // Open the mode menu
    await page.locator(sel.modeButton).click();
    await page.waitForTimeout(500);
    await expect(page.locator(sel.modeMenu)).toBeVisible({ timeout: 3_000 });

    // Click somewhere else (the textarea area)
    await page.locator(sel.smartInputTextarea).click();
    await page.waitForTimeout(500);

    // Menu should be closed
    await expect(page.locator(sel.modeMenu)).not.toBeVisible({ timeout: 3_000 });
  });
});
