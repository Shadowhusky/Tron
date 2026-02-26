import { test, expect } from "../fixtures/web";
import { sel } from "../helpers/selectors";
import { waitForTerminalOutput } from "../helpers/wait";

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
    await page.goto(page.url());
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

  test("terminal displays shell prompt", async ({ page }) => {
    // Wait for xterm to render — the terminal should show a shell prompt
    // xterm renders to canvas, but .xterm-screen has accessible textContent
    await page.waitForSelector(".xterm-screen", { timeout: 10_000 });

    // Wait for shell prompt indicator ($ for bash/zsh, % for zsh, > for fish)
    await page.waitForFunction(
      () => {
        const screen = document.querySelector(".xterm-screen");
        const text = screen?.textContent || "";
        // Shell prompt characters
        return text.includes("$") || text.includes("%") || text.includes(">");
      },
      { timeout: 15_000 },
    );
  });

  test("terminal executes commands and shows output", async ({ page }) => {
    // Wait for terminal to be ready
    await page.waitForSelector(".xterm-screen", { timeout: 10_000 });
    await page.waitForTimeout(1_000); // Let shell initialize

    // Type a simple command via SmartInput (command mode)
    const textarea = page.locator(sel.smartInputTextarea).first();
    await expect(textarea).toBeVisible({ timeout: 5_000 });
    await textarea.fill("echo TRON_WEB_TEST_OK");
    await textarea.press("Enter");

    // Wait for the command output to appear in terminal
    await waitForTerminalOutput(page, "TRON_WEB_TEST_OK", 15_000);
  });

  test("loading time is acceptable", async ({ page }) => {
    // Measure time from navigation to tab-bar visible
    const startTime = Date.now();
    await page.goto(page.url());
    await page.waitForSelector(sel.tabBar, { timeout: 30_000 });
    const loadTime = Date.now() - startTime;

    console.log(`[Web Mode] App load time: ${loadTime}ms`);

    // Loading should complete within 10 seconds
    expect(loadTime).toBeLessThan(10_000);

    // Wait for terminal to be interactive
    const termStartTime = Date.now();
    await page.waitForSelector(".xterm-screen", { timeout: 15_000 });
    await page.waitForFunction(
      () => {
        const screen = document.querySelector(".xterm-screen");
        const text = screen?.textContent || "";
        return text.includes("$") || text.includes("%") || text.includes(">");
      },
      { timeout: 15_000 },
    );
    const termReadyTime = Date.now() - termStartTime;

    console.log(`[Web Mode] Terminal ready time (after tab-bar): ${termReadyTime}ms`);
    console.log(`[Web Mode] Total time to interactive: ${loadTime + termReadyTime}ms`);

    // Terminal should be ready within 10 seconds of tab-bar appearing
    expect(termReadyTime).toBeLessThan(10_000);
  });
});
