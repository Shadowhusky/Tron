import { test, expect } from "../fixtures/app";
import { sel } from "../helpers/selectors";
import { waitForTerminalOutput } from "../helpers/wait";

test.describe("Terminal", () => {
  test.beforeEach(async ({ page }) => {
    // Wait for the terminal and SmartInput to be ready
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(sel.smartInputTextarea)).toBeVisible({ timeout: 10_000 });
  });

  test("can type a command and see output in terminal", async ({ page }) => {
    const textarea = page.locator(sel.smartInputTextarea);

    // Type an echo command
    await textarea.click();
    await textarea.fill("echo hello_tron_test");

    // Press Enter to execute
    await textarea.press("Enter");

    // Wait for the terminal output to contain the echoed string
    await waitForTerminalOutput(page, "hello_tron_test", 15_000);

    // Verify the output is present in the xterm screen
    const xtermContent = await page.locator(".xterm-screen").textContent();
    expect(xtermContent).toContain("hello_tron_test");
  });

  test("can run multiple commands sequentially", async ({ page }) => {
    const textarea = page.locator(sel.smartInputTextarea);

    // Run first command
    await textarea.click();
    await textarea.fill("echo first_cmd_output");
    await textarea.press("Enter");
    await waitForTerminalOutput(page, "first_cmd_output", 15_000);

    // Run second command
    await textarea.click();
    await textarea.fill("echo second_cmd_output");
    await textarea.press("Enter");
    await waitForTerminalOutput(page, "second_cmd_output", 15_000);

    // Both outputs should be in the terminal
    const xtermContent = await page.locator(".xterm-screen").textContent();
    expect(xtermContent).toContain("first_cmd_output");
    expect(xtermContent).toContain("second_cmd_output");
  });

  test("SmartInput clears after command submission", async ({ page }) => {
    const textarea = page.locator(sel.smartInputTextarea);

    await textarea.click();
    await textarea.fill("echo clear_test");
    await textarea.press("Enter");

    // After submitting, the textarea should be cleared
    await expect(textarea).toHaveValue("", { timeout: 5_000 });
  });

  test("terminal shows shell prompt on launch", async ({ page }) => {
    // The terminal should have rendered some content (shell prompt)
    // Wait a bit for the shell to initialize and print a prompt
    await page.waitForTimeout(3_000);

    const xtermContent = await page.locator(".xterm-screen").textContent();
    // The terminal should not be completely empty after shell init
    expect(xtermContent).toBeTruthy();
    expect(xtermContent!.trim().length).toBeGreaterThan(0);
  });

  test("clear terminal command works", async ({ page }) => {
    const textarea = page.locator(sel.smartInputTextarea);

    // First, put some content in the terminal
    await textarea.click();
    await textarea.fill("echo unique_marker_12345");
    await textarea.press("Enter");
    await waitForTerminalOutput(page, "unique_marker_12345", 15_000);

    // Now clear the terminal
    await textarea.click();
    await textarea.fill("clear");
    await textarea.press("Enter");

    // Wait a moment for the clear to take effect
    await page.waitForTimeout(2_000);

    // After clear, the unique marker should no longer be visible
    // (xterm-screen textContent is the accessible text view of current viewport)
    const xtermContent = await page.locator(".xterm-screen").textContent();
    expect(xtermContent).not.toContain("unique_marker_12345");
  });
});
