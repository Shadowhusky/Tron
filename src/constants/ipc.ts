// IPC Channel Constants — single source of truth for renderer code.
// Electron main process handlers use matching string literals.

export const IPC = {
  // Terminal — invoke (request/response)
  TERMINAL_CREATE: "terminal.create",
  TERMINAL_SESSION_EXISTS: "terminal.sessionExists",
  TERMINAL_CHECK_COMMAND: "terminal.checkCommand",
  TERMINAL_EXEC: "terminal.exec",
  TERMINAL_GET_CWD: "terminal.getCwd",
  TERMINAL_GET_COMPLETIONS: "terminal.getCompletions",
  TERMINAL_GET_HISTORY: "terminal.getHistory",

  // Terminal — send (fire-and-forget)
  TERMINAL_WRITE: "terminal.write",
  TERMINAL_RESIZE: "terminal.resize",
  TERMINAL_CLOSE: "terminal.close",

  // Terminal — main→renderer events
  TERMINAL_INCOMING_DATA: "terminal.incomingData",
  TERMINAL_EXIT: "terminal.exit",

  // System — invoke
  SYSTEM_FIX_PERMISSIONS: "system.fixPermissions",
  SYSTEM_CHECK_PERMISSIONS: "system.checkPermissions",
  SYSTEM_OPEN_PRIVACY_SETTINGS: "system.openPrivacySettings",

  // AI — invoke
  AI_TEST_CONNECTION: "ai.testConnection",

  // Menu — main→renderer events
  MENU_CREATE_TAB: "menu.createTab",
  MENU_CLOSE_TAB: "menu.closeTab",
} as const;

/** Dynamic channel: terminal echo for a specific session */
export const terminalEchoChannel = (sessionId: string) =>
  `terminal.echo:${sessionId}`;
