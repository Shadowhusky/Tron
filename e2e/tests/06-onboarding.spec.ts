import { test, expect } from "../fixtures/app";
import { sel } from "../helpers/selectors";

test.describe("Onboarding Wizard", () => {
  // NOTE: We do NOT skip onboarding in this suite — we want the wizard to appear.

  test("shows wizard when tron_configured is not set", async ({ page }) => {
    // Ensure configured flag is absent
    await page.evaluate(() => {
      localStorage.removeItem("tron_configured");
      localStorage.removeItem("tron_tutorial_completed");
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Wizard should be visible
    const wizard = page.locator(sel.onboardingWizard);
    await expect(wizard).toBeVisible({ timeout: 15_000 });
  });

  test("step navigation with next and prev buttons", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.removeItem("tron_configured");
      localStorage.removeItem("tron_tutorial_completed");
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const wizard = page.locator(sel.onboardingWizard);
    await expect(wizard).toBeVisible({ timeout: 15_000 });

    // Step 1: Appearance — prev button should be disabled
    const prevBtn = page.locator(sel.onboardingPrev);
    const nextBtn = page.locator(sel.onboardingNext);

    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).toBeVisible();
    await expect(wizard).toContainText("Appearance");

    // Navigate to step 2: View Mode
    await nextBtn.click();
    await expect(wizard).toContainText("View Mode", { timeout: 5_000 });
    await expect(prevBtn).toBeEnabled();

    // Navigate to step 3: Intelligence (AI)
    await nextBtn.click();
    await expect(wizard).toContainText("Intelligence", { timeout: 5_000 });

    // The next button should now say "Get Started"
    await expect(nextBtn).toContainText("Get Started");

    // Go back to step 2
    await prevBtn.click();
    await expect(wizard).toContainText("View Mode", { timeout: 5_000 });

    // Go back to step 1
    await prevBtn.click();
    await expect(wizard).toContainText("Appearance", { timeout: 5_000 });
    await expect(prevBtn).toBeDisabled();
  });

  test("theme selection buttons work", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.removeItem("tron_configured");
      localStorage.removeItem("tron_tutorial_completed");
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const wizard = page.locator(sel.onboardingWizard);
    await expect(wizard).toBeVisible({ timeout: 15_000 });

    // We are on the theme step — verify all theme buttons exist
    const lightBtn = page.locator(sel.onboardingTheme("light"));
    const darkBtn = page.locator(sel.onboardingTheme("dark"));
    const systemBtn = page.locator(sel.onboardingTheme("system"));
    const modernBtn = page.locator(sel.onboardingTheme("modern"));

    await expect(lightBtn).toBeVisible();
    await expect(darkBtn).toBeVisible();
    await expect(systemBtn).toBeVisible();
    await expect(modernBtn).toBeVisible();

    // Click light theme
    await lightBtn.click();
    const themeAfterLight = await page.evaluate(() =>
      localStorage.getItem("tron_theme"),
    );
    expect(themeAfterLight).toBe("light");

    // Click dark theme
    await darkBtn.click();
    const themeAfterDark = await page.evaluate(() =>
      localStorage.getItem("tron_theme"),
    );
    expect(themeAfterDark).toBe("dark");

    // Click modern theme
    await modernBtn.click();
    const themeAfterModern = await page.evaluate(() =>
      localStorage.getItem("tron_theme"),
    );
    expect(themeAfterModern).toBe("modern");
  });

  test("view mode buttons work on step 2", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.removeItem("tron_configured");
      localStorage.removeItem("tron_tutorial_completed");
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const wizard = page.locator(sel.onboardingWizard);
    await expect(wizard).toBeVisible({ timeout: 15_000 });

    // Navigate to view mode step
    await page.locator(sel.onboardingNext).click();
    await expect(wizard).toContainText("View Mode", { timeout: 5_000 });

    const terminalBtn = page.locator(sel.onboardingView("terminal"));
    const agentBtn = page.locator(sel.onboardingView("agent"));

    await expect(terminalBtn).toBeVisible();
    await expect(agentBtn).toBeVisible();

    // Click agent view mode
    await agentBtn.click();
    const viewMode = await page.evaluate(() =>
      localStorage.getItem("tron_view_mode"),
    );
    expect(viewMode).toBe("agent");

    // Click terminal view mode
    await terminalBtn.click();
    const viewMode2 = await page.evaluate(() =>
      localStorage.getItem("tron_view_mode"),
    );
    expect(viewMode2).toBe("terminal");
  });

  test("provider select exists on AI step", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.removeItem("tron_configured");
      localStorage.removeItem("tron_tutorial_completed");
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const wizard = page.locator(sel.onboardingWizard);
    await expect(wizard).toBeVisible({ timeout: 15_000 });

    // Navigate to AI step (step 3)
    await page.locator(sel.onboardingNext).click();
    await page.locator(sel.onboardingNext).click();
    await expect(wizard).toContainText("Intelligence", { timeout: 5_000 });

    // Provider select should be visible
    const providerSelect = page.locator(sel.onboardingProviderSelect);
    await expect(providerSelect).toBeVisible();

    // Verify it has options (at least ollama should be available)
    const options = await providerSelect.locator("option").allTextContents();
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.includes("Ollama"))).toBe(true);
  });

  test("skip to completion via double-click Get Started", async ({ page }) => {
    await page.evaluate(() => {
      localStorage.removeItem("tron_configured");
      localStorage.removeItem("tron_tutorial_completed");
    });
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const wizard = page.locator(sel.onboardingWizard);
    await expect(wizard).toBeVisible({ timeout: 15_000 });

    const nextBtn = page.locator(sel.onboardingNext);

    // Step 1 -> Step 2 -> Step 3
    await nextBtn.click();
    await nextBtn.click();
    await expect(wizard).toContainText("Intelligence", { timeout: 5_000 });

    // Click "Get Started" once — shows validation warning (no model configured)
    await nextBtn.click();
    await expect(wizard).toContainText("No model validated yet", {
      timeout: 5_000,
    });

    // Click "Get Started" again — skips validation and completes
    await nextBtn.click();

    // Wizard should disappear
    await expect(wizard).not.toBeVisible({ timeout: 10_000 });

    // tron_configured should now be set
    const configured = await page.evaluate(() =>
      localStorage.getItem("tron_configured"),
    );
    expect(configured).toBe("true");
  });
});
