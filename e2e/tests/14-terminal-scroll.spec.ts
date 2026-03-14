import { test, expect } from "../fixtures/app";

/** Get the terminal session ID by walking the React fiber tree */
async function getSessionId(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector(".xterm")?.parentElement;
    if (!el) throw new Error("No xterm parent element");
    const fiberKey = Object.keys(el).find(k => k.startsWith("__reactFiber$"));
    if (!fiberKey) throw new Error("No React fiber");
    let fiber = (el as any)[fiberKey];
    for (let i = 0; i < 30 && fiber; i++) {
      const p = fiber.memoizedProps || fiber.pendingProps;
      if (p?.sessionId && typeof p.sessionId === "string" && p.sessionId.length > 10) return p.sessionId;
      fiber = fiber.return;
    }
    throw new Error("sessionId not found in fiber tree");
  });
}

/** Write a command to the PTY and press Enter */
async function ptyWrite(page: import("@playwright/test").Page, sid: string, cmd: string) {
  await page.evaluate(({ sid, cmd }) => {
    (window as any).electron.ipcRenderer.send("terminal.write", { id: sid, data: cmd + "\r" });
  }, { sid, cmd });
}

/** Wait for terminal to contain text */
async function waitForRows(page: import("@playwright/test").Page, text: string, timeout = 30_000) {
  await page.waitForFunction(
    (t) => (document.querySelector(".xterm-rows")?.textContent ?? "").includes(t),
    text,
    { timeout },
  );
}

test.describe("Terminal scroll stability", () => {
  test.beforeEach(async ({ page }) => {
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2000);
  });

  test("does not scroll to top during continuous output", async ({ page }) => {
    const sid = await getSessionId(page);

    // Fill scrollback
    await ptyWrite(page, sid, "for i in $(seq 1 200); do echo hist_$i; done");
    await waitForRows(page, "hist_200");
    await page.waitForTimeout(500);

    // Stream continuous output
    await ptyWrite(page, sid, "for i in $(seq 1 500); do echo stm_$i; sleep 0.02; done");
    await waitForRows(page, "stm_1", 15_000);

    // Monitor scrollTop for 5s
    const jumpCount = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        const vp = document.querySelector(".xterm-viewport") as HTMLElement;
        if (!vp) { resolve(0); return; }
        let jumps = 0, elapsed = 0;
        const timer = setInterval(() => {
          elapsed += 50;
          if (vp.scrollHeight > vp.clientHeight + 100 && vp.scrollTop === 0) jumps++;
          if (elapsed >= 5000) { clearInterval(timer); resolve(jumps); }
        }, 50);
      });
    });

    expect(jumpCount, `Jumped to top ${jumpCount} times`).toBeLessThan(3);
  });

  test("does not scroll to top in small container", async ({ page }) => {
    const sid = await getSessionId(page);

    await page.setViewportSize({ width: 400, height: 350 });
    await page.waitForTimeout(500);

    await ptyWrite(page, sid, "for i in $(seq 1 100); do echo smh_$i; done");
    await waitForRows(page, "smh_100");
    await page.waitForTimeout(500);

    await ptyWrite(page, sid, "for i in $(seq 1 300); do echo sms_$i; sleep 0.02; done");
    await waitForRows(page, "sms_1", 15_000);

    const jumpCount = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        const vp = document.querySelector(".xterm-viewport") as HTMLElement;
        if (!vp) { resolve(0); return; }
        let jumps = 0, elapsed = 0;
        const timer = setInterval(() => {
          elapsed += 50;
          if (vp.scrollHeight > vp.clientHeight + 50 && vp.scrollTop === 0) jumps++;
          if (elapsed >= 5000) { clearInterval(timer); resolve(jumps); }
        }, 50);
      });
    });

    expect(jumpCount, `Small: ${jumpCount} jumps`).toBeLessThan(3);
  });

  test("resize during output does not cause scroll jump", async ({ page }) => {
    const sid = await getSessionId(page);

    await ptyWrite(page, sid, "for i in $(seq 1 150); do echo rzh_$i; done");
    await waitForRows(page, "rzh_150");
    await page.waitForTimeout(500);

    await ptyWrite(page, sid, "for i in $(seq 1 400); do echo rzs_$i; sleep 0.03; done");
    await waitForRows(page, "rzs_5", 15_000);

    // Start monitoring
    await page.evaluate(() => {
      const vp = document.querySelector(".xterm-viewport") as HTMLElement;
      (window as any).__sj = 0;
      if (!vp) return;
      (window as any).__st = setInterval(() => {
        if (vp.scrollHeight > vp.clientHeight + 100 && vp.scrollTop === 0) (window as any).__sj++;
      }, 50);
    });

    for (let i = 0; i < 5; i++) {
      await page.setViewportSize({
        width: 600 + (i % 2 === 0 ? 200 : -100),
        height: 500 + (i % 2 === 0 ? 100 : -50),
      });
      await page.waitForTimeout(800);
    }

    const jumpCount = await page.evaluate(() => {
      clearInterval((window as any).__st);
      return (window as any).__sj || 0;
    });

    expect(jumpCount, `Resize: ${jumpCount} jumps`).toBeLessThan(3);
  });
});
