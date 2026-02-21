import { test, expect } from "../fixtures/app";
import { sel } from "../helpers/selectors";

test.describe("Context Bar", () => {
  // Onboarding is skipped by the fixture (app.ts sets localStorage + reloads)

  test("renders context bar with CWD display", async ({ page }) => {
    const contextBar = page.locator(sel.contextBar);
    await expect(contextBar).toBeVisible({ timeout: 15_000 });

    // CWD display should be present and contain some path text
    const cwdDisplay = page.locator(sel.cwdDisplay);
    await expect(cwdDisplay).toBeVisible();
    // CWD should have some text (abbreviated home path like ~ or a real path)
    await expect(cwdDisplay).not.toBeEmpty();
  });

  test("renders model selector", async ({ page }) => {
    const contextBar = page.locator(sel.contextBar);
    await expect(contextBar).toBeVisible({ timeout: 15_000 });

    const modelSelector = page.locator(sel.modelSelector);
    await expect(modelSelector).toBeVisible();
  });

  test("renders context ring with percentage", async ({ page }) => {
    const contextBar = page.locator(sel.contextBar);
    await expect(contextBar).toBeVisible({ timeout: 15_000 });

    const contextRing = page.locator(sel.contextRing);
    await expect(contextRing).toBeVisible();

    // Context ring should contain a percentage value (e.g. "0%")
    await expect(contextRing).toContainText("%");
  });

  test("context ring click opens context modal", async ({ page }) => {
    const contextBar = page.locator(sel.contextBar);
    await expect(contextBar).toBeVisible({ timeout: 15_000 });

    const contextRing = page.locator(sel.contextRing);
    await contextRing.click();

    // The context modal should appear
    const contextModal = page.locator(sel.contextModal);
    await expect(contextModal).toBeVisible({ timeout: 10_000 });

    // Modal should contain "Session Context" header
    await expect(contextModal).toContainText("Session Context");

    // Modal should contain the "chars" count label
    await expect(contextModal).toContainText("chars");
  });

  test("model selector click opens model menu", async ({ page }) => {
    const contextBar = page.locator(sel.contextBar);
    await expect(contextBar).toBeVisible({ timeout: 15_000 });

    const modelSelector = page.locator(sel.modelSelector);
    await modelSelector.click();

    // The model menu should appear (rendered as a portal)
    const modelMenu = page.locator(sel.modelMenu);
    await expect(modelMenu).toBeVisible({ timeout: 10_000 });

    // Model menu should contain "Select Model" header
    await expect(modelMenu).toContainText("Select Model");
  });

  test("context modal can be closed", async ({ page }) => {
    const contextBar = page.locator(sel.contextBar);
    await expect(contextBar).toBeVisible({ timeout: 15_000 });

    // Open the context modal
    const contextRing = page.locator(sel.contextRing);
    await contextRing.click();

    const contextModal = page.locator(sel.contextModal);
    await expect(contextModal).toBeVisible({ timeout: 10_000 });

    // Click the backdrop to close (the backdrop is the fixed overlay before the modal)
    // The X button is inside the modal header
    const closeButton = contextModal.locator("button").first();
    await closeButton.click();

    await expect(contextModal).not.toBeVisible({ timeout: 5_000 });
  });
});
