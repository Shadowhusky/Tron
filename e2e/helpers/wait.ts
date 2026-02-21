import type { Page } from "@playwright/test";

/**
 * Wait for terminal output containing the given text.
 * Since xterm.js renders to canvas, we read via .xterm-screen textContent.
 */
export async function waitForTerminalOutput(
  page: Page,
  text: string,
  timeout = 15_000,
): Promise<void> {
  await page.waitForFunction(
    (t) => {
      const screen = document.querySelector(".xterm-screen");
      return screen?.textContent?.includes(t) ?? false;
    },
    text,
    { timeout },
  );
}

/**
 * Wait for the agent overlay status to contain the given text.
 */
export async function waitForAgentStatus(
  page: Page,
  status: string,
  timeout = 30_000,
): Promise<void> {
  await page.waitForFunction(
    (s) => {
      const el = document.querySelector('[data-testid="agent-status"]');
      return el?.textContent?.toLowerCase().includes(s.toLowerCase()) ?? false;
    },
    status,
    { timeout },
  );
}

/**
 * Set localStorage value before page load or in a running page.
 */
export async function setLocalStorage(
  page: Page,
  key: string,
  value: string,
): Promise<void> {
  await page.evaluate(
    ([k, v]) => localStorage.setItem(k, v),
    [key, value] as const,
  );
}

/**
 * Get localStorage value.
 */
export async function getLocalStorage(
  page: Page,
  key: string,
): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), key);
}

/**
 * Skip onboarding by setting the configured flag.
 */
export async function skipOnboarding(page: Page): Promise<void> {
  await setLocalStorage(page, "tron_configured", "true");
  await setLocalStorage(page, "tron_tutorial_completed", "true");
}
