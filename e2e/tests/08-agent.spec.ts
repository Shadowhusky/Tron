import { test, expect } from "../fixtures/app";
import { sel } from "../helpers/selectors";

// Skip entire suite if no TEST_PROVIDER env var is set — agent tests require
// a live AI provider to produce meaningful results.
const hasProvider = !!process.env.TEST_PROVIDER;

test.describe("Agent Overlay", () => {
  test.skip(!hasProvider, "Skipped: TEST_PROVIDER env var is not set");

  test.beforeEach(async ({ page }) => {
    // Wait for the smart input to be available
    await page.locator(sel.smartInput).waitFor({ state: "visible", timeout: 15_000 });
  });

  test("agent overlay appears after submitting an agent prompt", async ({ page }) => {
    // Type an agent prompt into the smart input
    const textarea = page.locator(sel.smartInputTextarea);
    await textarea.fill("What is 2 + 2?");

    // Switch to agent mode if a mode button exists
    const modeButton = page.locator(sel.modeButton);
    if (await modeButton.isVisible()) {
      await modeButton.click();
      const modeMenu = page.locator(sel.modeMenu);
      if (await modeMenu.isVisible({ timeout: 3_000 }).catch(() => false)) {
        const agentOption = page.locator(sel.modeOption("agent"));
        if (await agentOption.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await agentOption.click();
        }
      }
    }

    // Submit the prompt
    const sendButton = page.locator(sel.sendButton);
    if (await sendButton.isVisible()) {
      await sendButton.click();
    } else {
      // Fallback: press Enter
      await textarea.press("Enter");
    }

    // Agent overlay should appear
    const agentOverlay = page.locator(sel.agentOverlay);
    await expect(agentOverlay).toBeVisible({ timeout: 30_000 });

    // Agent status should be visible
    const agentStatus = page.locator(sel.agentStatus);
    await expect(agentStatus).toBeVisible({ timeout: 15_000 });
  });

  test("agent overlay has minimize and clear buttons", async ({ page }) => {
    // Type and submit an agent prompt
    const textarea = page.locator(sel.smartInputTextarea);
    await textarea.fill("List files in current directory");

    // Submit
    const sendButton = page.locator(sel.sendButton);
    if (await sendButton.isVisible()) {
      await sendButton.click();
    } else {
      await textarea.press("Enter");
    }

    // Wait for overlay to appear
    const agentOverlay = page.locator(sel.agentOverlay);
    await expect(agentOverlay).toBeVisible({ timeout: 30_000 });

    // Check that minimize button exists
    const minimizeBtn = page.locator(sel.agentMinimize);
    await expect(minimizeBtn).toBeVisible({ timeout: 10_000 });

    // Check that clear button exists
    const clearBtn = page.locator(sel.agentClear);
    await expect(clearBtn).toBeVisible({ timeout: 10_000 });
  });

  test("permission modal buttons exist when shown", async ({ page }) => {
    // Type a command that would trigger permission (e.g., deleting files)
    const textarea = page.locator(sel.smartInputTextarea);
    await textarea.fill("Delete all files in /tmp/tron-test-nonexistent");

    const sendButton = page.locator(sel.sendButton);
    if (await sendButton.isVisible()) {
      await sendButton.click();
    } else {
      await textarea.press("Enter");
    }

    // Permission modal may or may not appear depending on the agent's behavior.
    // We check if it appears, and if so, verify the buttons exist.
    const permissionModal = page.locator(sel.permissionModal);
    const appeared = await permissionModal
      .waitFor({ state: "visible", timeout: 20_000 })
      .then(() => true)
      .catch(() => false);

    if (appeared) {
      const allowBtn = page.locator(sel.permissionAllow);
      const denyBtn = page.locator(sel.permissionDeny);
      await expect(allowBtn).toBeVisible();
      await expect(denyBtn).toBeVisible();

      // Deny the action to clean up
      await denyBtn.click();
    }
    // If the modal didn't appear, the test still passes — agent may have
    // decided not to execute a destructive command.
  });

  test("stop button appears during agent execution", async ({ page }) => {
    const textarea = page.locator(sel.smartInputTextarea);
    await textarea.fill("Explain the theory of relativity in detail");

    const sendButton = page.locator(sel.sendButton);
    if (await sendButton.isVisible()) {
      await sendButton.click();
    } else {
      await textarea.press("Enter");
    }

    // The stop button should appear while the agent is running
    const stopButton = page.locator(sel.stopButton);
    await expect(stopButton).toBeVisible({ timeout: 15_000 });
  });
});
