import { test, expect } from "../fixtures/app";
import { sel } from "../helpers/selectors";

test.describe("Terminal scroll stability", () => {
  test.beforeEach(async ({ page }) => {
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(sel.smartInputTextarea)).toBeVisible({ timeout: 10_000 });
    // Wait for terminal to be ready (shell prompt)
    await page.waitForTimeout(2000);
  });

  /** Helper: write a command directly to the PTY and wait for output */
  async function execInTerminal(page: import("@playwright/test").Page, command: string) {
    await page.evaluate((cmd) => {
      // Get the first terminal session ID
      const sessions = document.querySelectorAll(".xterm-screen");
      if (sessions.length === 0) throw new Error("No terminal sessions found");
      // Write command + Enter to the terminal via IPC
      (window as any).electron?.ipcRenderer?.send("terminal.write", {
        id: (window as any).__tronTestSessionId,
        data: cmd + "\r",
      });
    }, command);
  }

  /**
   * Regression test for scroll-to-top during continuous output.
   * Fills terminal with scrollback history, then streams continuous output.
   * Monitors .xterm-viewport.scrollTop for jumps to 0.
   */
  test("does not scroll to top during continuous output", async ({ page }) => {
    // Get the session ID for direct PTY writes
    await page.evaluate(() => {
      // Find the active terminal session ID from React state
      const xtermEl = document.querySelector(".xterm") as HTMLElement;
      // Try getting sessionId from the layout context
      const sessionIds = Array.from(document.querySelectorAll("[data-session-id]"))
        .map(el => (el as HTMLElement).dataset.sessionId)
        .filter(Boolean);
      (window as any).__tronTestSessionId = sessionIds[0] || "default";
    });

    const textarea = page.locator(sel.smartInputTextarea);

    // 1. Fill terminal with scrollback history using SmartInput
    await textarea.click();
    await textarea.fill("for i in $(seq 1 200); do echo \"history_line_$i\"; done");
    await textarea.press("Enter");

    // Wait for history to finish
    await page.waitForFunction(() => {
      const screen = document.querySelector(".xterm-screen");
      return screen?.textContent?.includes("history_line_200") ?? false;
    }, null, { timeout: 30_000 });
    await page.waitForTimeout(500);

    // 2. Start continuous output
    await textarea.click();
    await textarea.fill("for i in $(seq 1 500); do echo \"stream_$i\"; sleep 0.02; done");
    await textarea.press("Enter");

    // Wait for streaming to start
    await page.waitForFunction(() => {
      const screen = document.querySelector(".xterm-screen");
      return screen?.textContent?.includes("stream_1") ?? false;
    }, null, { timeout: 15_000 });

    // 3. Monitor scrollTop for 5 seconds — detect scroll-to-top jumps
    const jumpCount = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        const vp = document.querySelector(".xterm-viewport") as HTMLElement;
        if (!vp) { resolve(0); return; }

        let jumps = 0;
        const interval = 50;
        const duration = 5000;
        let elapsed = 0;

        const timer = setInterval(() => {
          elapsed += interval;
          if (vp.scrollHeight > vp.clientHeight + 100 && vp.scrollTop === 0) {
            jumps++;
          }
          if (elapsed >= duration) {
            clearInterval(timer);
            resolve(jumps);
          }
        }, interval);
      });
    });

    // Allow up to 2 transient jumps (initial layout), but 3+ is a bug
    expect(jumpCount, `Terminal jumped to top ${jumpCount} times during continuous output`).toBeLessThan(3);
  });

  /**
   * Same test with small viewport (simulates mobile / small split pane).
   */
  test("does not scroll to top in small container during output", async ({ page }) => {
    // Resize to small viewport
    await page.setViewportSize({ width: 400, height: 350 });
    await page.waitForTimeout(500);

    const textarea = page.locator(sel.smartInputTextarea);

    // Fill history
    await textarea.click();
    await textarea.fill("for i in $(seq 1 100); do echo \"sm_hist_$i\"; done");
    await textarea.press("Enter");
    await page.waitForFunction(() => {
      const screen = document.querySelector(".xterm-screen");
      return screen?.textContent?.includes("sm_hist_100") ?? false;
    }, null, { timeout: 30_000 });
    await page.waitForTimeout(500);

    // Start streaming
    await textarea.click();
    await textarea.fill("for i in $(seq 1 300); do echo \"sm_stream_$i\"; sleep 0.02; done");
    await textarea.press("Enter");
    await page.waitForFunction(() => {
      const screen = document.querySelector(".xterm-screen");
      return screen?.textContent?.includes("sm_stream_1") ?? false;
    }, null, { timeout: 15_000 });

    // Monitor
    const jumpCount = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        const vp = document.querySelector(".xterm-viewport") as HTMLElement;
        if (!vp) { resolve(0); return; }
        let jumps = 0;
        let elapsed = 0;
        const timer = setInterval(() => {
          elapsed += 50;
          if (vp.scrollHeight > vp.clientHeight + 50 && vp.scrollTop === 0) {
            jumps++;
          }
          if (elapsed >= 5000) {
            clearInterval(timer);
            resolve(jumps);
          }
        }, 50);
      });
    });

    expect(jumpCount, `Small terminal jumped to top ${jumpCount} times`).toBeLessThan(3);
  });

  /**
   * Test: resize window during active output doesn't cause scroll jumps.
   */
  test("resize during output does not cause scroll jump", async ({ page }) => {
    const textarea = page.locator(sel.smartInputTextarea);

    // Fill history
    await textarea.click();
    await textarea.fill("for i in $(seq 1 150); do echo \"rz_hist_$i\"; done");
    await textarea.press("Enter");
    await page.waitForFunction(() => {
      const screen = document.querySelector(".xterm-screen");
      return screen?.textContent?.includes("rz_hist_150") ?? false;
    }, null, { timeout: 30_000 });
    await page.waitForTimeout(500);

    // Start streaming
    await textarea.click();
    await textarea.fill("for i in $(seq 1 400); do echo \"rz_stream_$i\"; sleep 0.03; done");
    await textarea.press("Enter");
    await page.waitForFunction(() => {
      const screen = document.querySelector(".xterm-screen");
      return screen?.textContent?.includes("rz_stream_5") ?? false;
    }, null, { timeout: 15_000 });

    // Start monitoring in the page
    const monitorHandle = await page.evaluateHandle(() => {
      const vp = document.querySelector(".xterm-viewport") as HTMLElement;
      const state = { jumps: 0, done: false };
      if (vp) {
        const timer = setInterval(() => {
          if (state.done) { clearInterval(timer); return; }
          if (vp.scrollHeight > vp.clientHeight + 100 && vp.scrollTop === 0) {
            state.jumps++;
          }
        }, 50);
      }
      return state;
    });

    // Do resizes while output streams
    for (let i = 0; i < 5; i++) {
      const w = 600 + (i % 2 === 0 ? 200 : -100);
      const h = 500 + (i % 2 === 0 ? 100 : -50);
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(800);
    }

    // Stop monitoring and get result
    const jumpCount = await page.evaluate((handle) => {
      (handle as any).done = true;
      return (handle as any).jumps;
    }, monitorHandle);

    expect(jumpCount, `Resize caused ${jumpCount} scroll-to-top jumps`).toBeLessThan(3);
  });
});
