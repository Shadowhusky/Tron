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
async function waitForRows(page: import("@playwright/test").Page, text: string, timeout = 60_000) {
  await page.waitForFunction(
    (t) => (document.querySelector(".xterm-rows")?.textContent ?? "").includes(t),
    text,
    { timeout },
  );
}

/** Monitor scrollTop for N ms, return number of times it jumped to 0 */
async function monitorScrollJumps(page: import("@playwright/test").Page, durationMs: number, minScrollHeight = 100): Promise<number> {
  return page.evaluate(({ dur, minH }) => {
    return new Promise<number>((resolve) => {
      const vp = document.querySelector(".xterm-viewport") as HTMLElement;
      if (!vp) { resolve(0); return; }
      let jumps = 0, elapsed = 0;
      const timer = setInterval(() => {
        elapsed += 50;
        if (vp.scrollHeight > vp.clientHeight + minH && vp.scrollTop === 0) jumps++;
        if (elapsed >= dur) { clearInterval(timer); resolve(jumps); }
      }, 50);
    });
  }, { dur: durationMs, minH: minScrollHeight });
}

test.describe("Terminal scroll stability", () => {
  test.beforeEach(async ({ page }) => {
    page.on("dialog", (d) => d.dismiss().catch(() => {}));
    await expect(page.locator(".xterm-screen")).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2000);
  });

  test("no scroll-to-top with 10k lines of history + streaming", async ({ page }) => {
    const sid = await getSessionId(page);

    // Fill terminal with 10,000 lines of scrollback
    await ptyWrite(page, sid, "seq 10000");
    await waitForRows(page, "10000");
    await page.waitForTimeout(500);

    // Stream 2000 lines at high speed (no sleep — as fast as possible)
    await ptyWrite(page, sid, "for i in $(seq 1 2000); do echo stream_$i; done");
    await waitForRows(page, "stream_1", 15_000);

    const jumpCount = await monitorScrollJumps(page, 5000);
    expect(jumpCount, `Jumped to top ${jumpCount} times with 10k history`).toBeLessThan(3);
  });

  test("no scroll-to-top with 10k lines + slow streaming in small viewport", async ({ page }) => {
    const sid = await getSessionId(page);

    await page.setViewportSize({ width: 400, height: 350 });
    await page.waitForTimeout(500);

    // Fill 10k lines
    await ptyWrite(page, sid, "seq 10000");
    await waitForRows(page, "10000");
    await page.waitForTimeout(500);

    // Slow stream — triggers more ResizeObserver cycles per line
    await ptyWrite(page, sid, "for i in $(seq 1 1000); do echo sm_$i; sleep 0.01; done");
    await waitForRows(page, "sm_1", 15_000);

    const jumpCount = await monitorScrollJumps(page, 8000, 50);
    expect(jumpCount, `Small viewport: ${jumpCount} jumps with 10k history`).toBeLessThan(3);
  });

  test("no scroll-to-top with 10k lines + resize during fast output", async ({ page }) => {
    const sid = await getSessionId(page);

    // Fill 10k lines
    await ptyWrite(page, sid, "seq 10000");
    await waitForRows(page, "10000");
    await page.waitForTimeout(500);

    // Stream with small delay so output overlaps with resize events
    await ptyWrite(page, sid, "for i in $(seq 1 2000); do echo rz_$i; sleep 0.005; done");
    await waitForRows(page, "rz_1", 15_000);

    // Start monitoring
    await page.evaluate(() => {
      const vp = document.querySelector(".xterm-viewport") as HTMLElement;
      (window as any).__sj = 0;
      if (!vp) return;
      (window as any).__st = setInterval(() => {
        if (vp.scrollHeight > vp.clientHeight + 100 && vp.scrollTop === 0) (window as any).__sj++;
      }, 50);
    });

    // Aggressive resizing while output streams
    for (let i = 0; i < 8; i++) {
      await page.setViewportSize({
        width: 500 + (i % 3 === 0 ? 300 : i % 3 === 1 ? -150 : 100),
        height: 400 + (i % 2 === 0 ? 200 : -100),
      });
      await page.waitForTimeout(500);
    }

    const jumpCount = await page.evaluate(() => {
      clearInterval((window as any).__st);
      return (window as any).__sj || 0;
    });

    expect(jumpCount, `Resize + 10k history: ${jumpCount} jumps`).toBeLessThan(3);
  });

  test("no scroll-to-top with 50k lines of history + burst output", async ({ page }) => {
    const sid = await getSessionId(page);

    // Fill 50,000 lines — really stress the scrollback
    await ptyWrite(page, sid, "seq 50000");
    await waitForRows(page, "50000");
    await page.waitForTimeout(1000);

    // Burst output — 5000 lines as fast as possible
    await ptyWrite(page, sid, "seq 50001 55000");
    await waitForRows(page, "55000", 30_000);

    // Then slow stream to keep output going while we monitor
    await ptyWrite(page, sid, "for i in $(seq 1 500); do echo burst_$i; sleep 0.02; done");
    await waitForRows(page, "burst_1", 15_000);

    const jumpCount = await monitorScrollJumps(page, 6000);
    expect(jumpCount, `50k history burst: ${jumpCount} jumps`).toBeLessThan(3);
  });

  test("no scroll-to-top when user scrolled up during streaming", async ({ page }) => {
    const sid = await getSessionId(page);

    // Fill 10k lines
    await ptyWrite(page, sid, "seq 10000");
    await waitForRows(page, "10000");
    await page.waitForTimeout(500);

    // Start slow stream so output is ongoing
    await ptyWrite(page, sid, "for i in $(seq 1 2000); do echo up_$i; sleep 0.01; done");
    await waitForRows(page, "up_1", 15_000);

    // Scroll the viewport UP (simulates user reading history while output streams)
    await page.evaluate(() => {
      const vp = document.querySelector(".xterm-viewport") as HTMLElement;
      if (vp) {
        // Scroll up by a large amount — halfway through scrollback
        vp.scrollTop = Math.max(0, vp.scrollHeight / 2 - vp.clientHeight);
      }
    });
    await page.waitForTimeout(200);

    // Monitor: scrollTop should stay near where the user scrolled, NOT jump to 0
    const jumpCount = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        const vp = document.querySelector(".xterm-viewport") as HTMLElement;
        if (!vp) { resolve(0); return; }
        let jumps = 0, elapsed = 0;
        const timer = setInterval(() => {
          elapsed += 50;
          // User is scrolled up, so scrollTop should be > 0
          if (vp.scrollHeight > vp.clientHeight + 100 && vp.scrollTop === 0) jumps++;
          if (elapsed >= 6000) { clearInterval(timer); resolve(jumps); }
        }, 50);
      });
    });

    expect(jumpCount, `Scrolled-up: ${jumpCount} jumps to top`).toBeLessThan(3);
  });

  test("no scroll-to-top in tiny container simulating mobile keyboard", async ({ page }) => {
    const sid = await getSessionId(page);

    // Fill 10k lines at normal size
    await ptyWrite(page, sid, "seq 10000");
    await waitForRows(page, "10000");
    await page.waitForTimeout(500);

    // Shrink viewport to simulate mobile keyboard open (very small terminal)
    await page.setViewportSize({ width: 375, height: 200 });
    await page.waitForTimeout(500);

    // Stream output while container is tiny
    await ptyWrite(page, sid, "for i in $(seq 1 1000); do echo tiny_$i; sleep 0.01; done");
    await waitForRows(page, "tiny_1", 15_000);

    const jumpCount = await monitorScrollJumps(page, 6000, 30);
    expect(jumpCount, `Tiny viewport (keyboard): ${jumpCount} jumps`).toBeLessThan(3);
  });
});
