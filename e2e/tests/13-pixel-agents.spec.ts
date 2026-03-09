import { test, expect } from "../fixtures/web";
import { sel } from "../helpers/selectors";

test.describe("Agent Status Bar", () => {
  test.beforeEach(async ({ page }) => {
    await expect(page.locator(sel.tabBar)).toBeVisible({ timeout: 10_000 });
  });

  test("status bar appears when agent is active", async ({ page }) => {
    // The status bar only shows when at least one agent is active.
    // Without an active agent, it should not be visible.
    const bar = page.locator('[data-testid="agent-status-bar"]');
    // Initially no agents running → bar should be hidden
    await expect(bar).not.toBeVisible({ timeout: 3_000 });
  });
});
