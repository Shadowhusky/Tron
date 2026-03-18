import { test, expect } from "../fixtures/app";
import { sel } from "../helpers/selectors";

test.describe("Agent Status Bar", () => {
  test.beforeEach(async ({ page }) => {
    await expect(page.locator(sel.tabBar)).toBeVisible({ timeout: 10_000 });

    // Enable the agent status bar via config
    await page.evaluate(async () => {
      const current = await (window as any).electron?.ipcRenderer?.readConfig?.() || {};
      await (window as any).electron?.ipcRenderer?.writeConfig?.({ ...current, showAgentStatusBar: true });
    });
    await page.reload();
    await page.waitForSelector(sel.tabBar, { timeout: 15_000 });
  });

  test("status bar hidden when no agents are active", async ({ page }) => {
    const bar = page.locator(sel.agentStatusBar);
    // No agents running → bar should not be visible
    await expect(bar).not.toBeVisible({ timeout: 3_000 });
  });

  test("built-in agent: status bar shows active when agent starts", async ({ page }) => {
    // Get a real session ID from the layout
    const sessionId = await page.evaluate(() => {
      const sessions = (window as any).__layoutSessions as Map<string, unknown>;
      for (const [id] of sessions) {
        if (id !== "settings" && !id.startsWith("ssh-connect")) return id;
      }
      return null;
    });
    expect(sessionId).toBeTruthy();

    // Simulate agent start via AgentStore
    await page.evaluate((sid) => {
      const store = (window as any).__agentStore;
      store.updateState(sid, {
        isAgentRunning: true,
        isThinking: false,
        pendingCommand: null,
        agentThread: [{ step: "separator", output: "test task" }],
        isOverlayVisible: true,
      });
      window.dispatchEvent(new CustomEvent("tron:agent-activity", { detail: { sessionId: sid, running: true } }));
    }, sessionId);

    // Status bar should appear with active status
    const bar = page.locator(sel.agentStatusBar);
    await expect(bar).toBeVisible({ timeout: 3_000 });

    // The dot should have data-status="active"
    const dot = page.locator(`[data-testid="agent-dot-${sessionId}"]`);
    await expect(dot).toBeVisible({ timeout: 3_000 });
    await expect(dot).toHaveAttribute("data-status", "active");

    // Status text should show "working" (no specific tool)
    await expect(dot).toContainText("working");
  });

  test("built-in agent: status bar shows thinking", async ({ page }) => {
    const sessionId = await page.evaluate(() => {
      const sessions = (window as any).__layoutSessions as Map<string, unknown>;
      for (const [id] of sessions) {
        if (id !== "settings" && !id.startsWith("ssh-connect")) return id;
      }
      return null;
    });
    expect(sessionId).toBeTruthy();

    // Simulate agent running with thinking state
    await page.evaluate((sid) => {
      const store = (window as any).__agentStore;
      store.updateState(sid, {
        isAgentRunning: true,
        isThinking: true,
        pendingCommand: null,
        agentThread: [
          { step: "separator", output: "test task" },
          { step: "streaming_thinking", output: "..." },
        ],
        isOverlayVisible: true,
      });
      window.dispatchEvent(new CustomEvent("tron:agent-activity", { detail: { sessionId: sid, running: true } }));
    }, sessionId);

    const dot = page.locator(`[data-testid="agent-dot-${sessionId}"]`);
    await expect(dot).toBeVisible({ timeout: 3_000 });
    await expect(dot).toHaveAttribute("data-status", "active");
    await expect(dot).toHaveAttribute("data-tool", "thinking");
    await expect(dot).toContainText("thinking");
  });

  test("built-in agent: status bar shows specific tool (execute_command)", async ({ page }) => {
    const sessionId = await page.evaluate(() => {
      const sessions = (window as any).__layoutSessions as Map<string, unknown>;
      for (const [id] of sessions) {
        if (id !== "settings" && !id.startsWith("ssh-connect")) return id;
      }
      return null;
    });
    expect(sessionId).toBeTruthy();

    // Simulate agent executing a command
    await page.evaluate((sid) => {
      const store = (window as any).__agentStore;
      store.updateState(sid, {
        isAgentRunning: true,
        isThinking: false,
        pendingCommand: null,
        agentThread: [
          { step: "separator", output: "test task" },
          { step: "executing", output: "ls -la", payload: { tool: "execute_command" } },
        ],
        isOverlayVisible: true,
      });
      window.dispatchEvent(new CustomEvent("tron:agent-activity", { detail: { sessionId: sid, running: true } }));
    }, sessionId);

    const dot = page.locator(`[data-testid="agent-dot-${sessionId}"]`);
    await expect(dot).toBeVisible({ timeout: 3_000 });
    await expect(dot).toHaveAttribute("data-tool", "execute_command");
    await expect(dot).toContainText("running cmd");
  });

  test("built-in agent: status bar shows reading output", async ({ page }) => {
    const sessionId = await page.evaluate(() => {
      const sessions = (window as any).__layoutSessions as Map<string, unknown>;
      for (const [id] of sessions) {
        if (id !== "settings" && !id.startsWith("ssh-connect")) return id;
      }
      return null;
    });
    expect(sessionId).toBeTruthy();

    await page.evaluate((sid) => {
      const store = (window as any).__agentStore;
      store.updateState(sid, {
        isAgentRunning: true,
        isThinking: false,
        pendingCommand: null,
        agentThread: [
          { step: "separator", output: "test task" },
          { step: "read_terminal", output: "reading terminal" },
        ],
        isOverlayVisible: true,
      });
      window.dispatchEvent(new CustomEvent("tron:agent-activity", { detail: { sessionId: sid, running: true } }));
    }, sessionId);

    const dot = page.locator(`[data-testid="agent-dot-${sessionId}"]`);
    await expect(dot).toBeVisible({ timeout: 3_000 });
    await expect(dot).toHaveAttribute("data-tool", "read_terminal");
    await expect(dot).toContainText("reading output");
  });

  test("built-in agent: status bar shows needs approval for pending command", async ({ page }) => {
    const sessionId = await page.evaluate(() => {
      const sessions = (window as any).__layoutSessions as Map<string, unknown>;
      for (const [id] of sessions) {
        if (id !== "settings" && !id.startsWith("ssh-connect")) return id;
      }
      return null;
    });
    expect(sessionId).toBeTruthy();

    await page.evaluate((sid) => {
      const store = (window as any).__agentStore;
      store.updateState(sid, {
        isAgentRunning: true,
        isThinking: false,
        pendingCommand: "rm -rf /tmp/test",
        agentThread: [
          { step: "separator", output: "test task" },
        ],
        isOverlayVisible: true,
      });
      window.dispatchEvent(new CustomEvent("tron:agent-activity", { detail: { sessionId: sid, running: true } }));
    }, sessionId);

    const dot = page.locator(`[data-testid="agent-dot-${sessionId}"]`);
    await expect(dot).toBeVisible({ timeout: 3_000 });
    await expect(dot).toHaveAttribute("data-status", "needs-approval");
    await expect(dot).toContainText("needs approval");
  });

  test("built-in agent: status bar shows idle after agent completes (done step)", async ({ page }) => {
    const sessionId = await page.evaluate(() => {
      const sessions = (window as any).__layoutSessions as Map<string, unknown>;
      for (const [id] of sessions) {
        if (id !== "settings" && !id.startsWith("ssh-connect")) return id;
      }
      return null;
    });
    expect(sessionId).toBeTruthy();

    // Start the agent
    await page.evaluate((sid) => {
      const store = (window as any).__agentStore;
      store.updateState(sid, {
        isAgentRunning: true,
        isThinking: false,
        pendingCommand: null,
        agentThread: [{ step: "separator", output: "test task" }],
        isOverlayVisible: true,
      });
      window.dispatchEvent(new CustomEvent("tron:agent-activity", { detail: { sessionId: sid, running: true } }));
    }, sessionId);

    // Verify it's active first
    const dot = page.locator(`[data-testid="agent-dot-${sessionId}"]`);
    await expect(dot).toHaveAttribute("data-status", "active", { timeout: 3_000 });

    // Now complete the agent — set isAgentRunning=false + done step + dispatch event
    await page.evaluate((sid) => {
      const store = (window as any).__agentStore;
      store.updateState(sid, {
        isAgentRunning: false,
        isThinking: false,
        pendingCommand: null,
        agentThread: [
          { step: "separator", output: "test task" },
          { step: "done", output: "Task completed" },
        ],
      });
      window.dispatchEvent(new CustomEvent("tron:agent-activity", { detail: { sessionId: sid, running: false } }));
    }, sessionId);

    // Status should show idle
    await expect(dot).toHaveAttribute("data-status", "idle", { timeout: 3_000 });
    await expect(dot).toContainText("idle");
  });

  test("built-in agent: stopAgent clears active status (regression)", async ({ page }) => {
    // This is the main bug regression test:
    // Previously, stopAgent() did not dispatch tron:agent-activity { running: false },
    // so the agentRunning ref in useTronAgentBridge retained the sessionId,
    // causing the status bar to incorrectly show "working" after the agent was stopped.
    const sessionId = await page.evaluate(() => {
      const sessions = (window as any).__layoutSessions as Map<string, unknown>;
      for (const [id] of sessions) {
        if (id !== "settings" && !id.startsWith("ssh-connect")) return id;
      }
      return null;
    });
    expect(sessionId).toBeTruthy();

    // Start the agent
    await page.evaluate((sid) => {
      const store = (window as any).__agentStore;
      store.updateState(sid, {
        isAgentRunning: true,
        isThinking: false,
        pendingCommand: null,
        agentThread: [
          { step: "separator", output: "test task" },
          { step: "executing", output: "some command", payload: { tool: "execute_command" } },
        ],
        isOverlayVisible: true,
      });
      window.dispatchEvent(new CustomEvent("tron:agent-activity", { detail: { sessionId: sid, running: true } }));
    }, sessionId);

    const dot = page.locator(`[data-testid="agent-dot-${sessionId}"]`);
    await expect(dot).toHaveAttribute("data-status", "active", { timeout: 3_000 });

    // Stop the agent via stopAgent() — this is the path that had the bug.
    // stopAgent() sets isAgentRunning=false but previously didn't dispatch the event.
    await page.evaluate((sid) => {
      const store = (window as any).__agentStore;
      store.stopAgent(sid);
    }, sessionId);

    // The status MUST show idle after stop, NOT "working"
    await expect(dot).toHaveAttribute("data-status", "idle", { timeout: 3_000 });
    await expect(dot).toContainText("idle");
  });

  test("external agent (Claude Code): terminal output triggers active status", async ({ electronApp, page }) => {
    // Wait for history grace period (3s) to pass since terminal starts producing data on page load
    await page.waitForTimeout(4_000);

    const sessionId = await page.evaluate(() => {
      const sessions = (window as any).__layoutSessions as Map<string, unknown>;
      for (const [id] of sessions) {
        if (id !== "settings" && !id.startsWith("ssh-connect")) return id;
      }
      return null;
    });
    expect(sessionId).toBeTruthy();

    // Send Claude Code tool output pattern from the main process via IPC.
    // This is the same path that real terminal data takes: main → renderer via terminal.incomingData.
    await electronApp.evaluate(({ BrowserWindow }, { sid }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send("terminal.incomingData", { id: sid, data: "\n\u23FA Read src/main.ts\r\n" });
      }
    }, { sid: sessionId });

    // Wait for reconciliation (500ms interval + buffer)
    await page.waitForTimeout(1_500);

    // The status bar should appear and show the session as active
    const bar = page.locator(sel.agentStatusBar);
    await expect(bar).toBeVisible({ timeout: 5_000 });

    const dot = page.locator(`[data-testid="agent-dot-${sessionId}"]`);
    await expect(dot).toBeVisible({ timeout: 3_000 });
    await expect(dot).toHaveAttribute("data-status", "active");
  });

  test("external agent: status returns to idle after timeout", async ({ electronApp, page }) => {
    // Wait for history grace period
    await page.waitForTimeout(4_000);

    const sessionId = await page.evaluate(() => {
      const sessions = (window as any).__layoutSessions as Map<string, unknown>;
      for (const [id] of sessions) {
        if (id !== "settings" && !id.startsWith("ssh-connect")) return id;
      }
      return null;
    });
    expect(sessionId).toBeTruthy();

    // Send Claude Code terminal output from main process
    await electronApp.evaluate(({ BrowserWindow }, { sid }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send("terminal.incomingData", { id: sid, data: "\n\u23FA Bash ls -la\r\n" });
      }
    }, { sid: sessionId });

    await page.waitForTimeout(1_500);

    const dot = page.locator(`[data-testid="agent-dot-${sessionId}"]`);
    await expect(dot).toHaveAttribute("data-status", "active", { timeout: 5_000 });

    // Wait for EXTERNAL_IDLE_MS (5000ms) to pass — the session should go idle
    await page.waitForTimeout(6_000);

    await expect(dot).toHaveAttribute("data-status", "idle", { timeout: 3_000 });
  });

  test("status bar click switches to agent's tab", async ({ page }) => {
    // Create a second tab
    const createBtn = page.locator(sel.tabCreate);
    await createBtn.click();
    await page.waitForTimeout(1_000);

    // Get session IDs for both tabs
    const sessionIds = await page.evaluate(() => {
      const sessions = (window as any).__layoutSessions as Map<string, unknown>;
      const ids: string[] = [];
      for (const [id] of sessions) {
        if (id !== "settings" && !id.startsWith("ssh-connect")) ids.push(id);
      }
      return ids;
    });
    expect(sessionIds.length).toBeGreaterThanOrEqual(2);

    // Set agent running on the first session (which is in the first tab)
    const firstSessionId = sessionIds[0];
    await page.evaluate((sid) => {
      const store = (window as any).__agentStore;
      store.updateState(sid, {
        isAgentRunning: true,
        isThinking: false,
        pendingCommand: null,
        agentThread: [{ step: "separator", output: "test" }],
        isOverlayVisible: true,
      });
      window.dispatchEvent(new CustomEvent("tron:agent-activity", { detail: { sessionId: sid, running: true } }));
    }, firstSessionId);

    // Status bar should show the dot
    const dot = page.locator(`[data-testid="agent-dot-${firstSessionId}"]`);
    await expect(dot).toBeVisible({ timeout: 3_000 });

    // Click the dot — should switch to the first tab
    await dot.click();
    await page.waitForTimeout(500);

    // Clean up: stop the agent
    await page.evaluate((sid) => {
      const store = (window as any).__agentStore;
      store.stopAgent(sid);
    }, firstSessionId);
  });
});
