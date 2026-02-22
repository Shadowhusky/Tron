import { useEffect } from "react";
import { useConfig } from "../contexts/ConfigContext";

/**
 * Parse a hotkey combo string like "meta+k" or "ctrl+shift+c" into
 * modifier flags + the base key.
 */
function parseCombo(combo: string): {
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
} {
  const parts = combo.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  return {
    meta: parts.includes("meta") || parts.includes("cmd"),
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt") || parts.includes("opt"),
    key,
  };
}

/**
 * Returns true if the keyboard event matches the parsed combo.
 */
function matchesCombo(
  e: KeyboardEvent,
  combo: ReturnType<typeof parseCombo>,
): boolean {
  if (combo.meta !== e.metaKey) return false;
  if (combo.ctrl !== e.ctrlKey) return false;
  if (combo.shift !== e.shiftKey) return false;
  if (combo.alt !== e.altKey) return false;

  // For key matching: handle special names
  const eventKey = e.key.toLowerCase();
  if (combo.key === "enter" && eventKey === "enter") return true;
  if (combo.key === "escape" && eventKey === "escape") return true;
  if (combo.key === "tab" && eventKey === "tab") return true;

  return eventKey === combo.key;
}

/**
 * Register a global keydown listener for a named hotkey action.
 * The hotkey binding is read from ConfigContext.
 */
export function useHotkey(
  action: string,
  callback: () => void,
  deps: unknown[] = [],
) {
  const { hotkeys } = useConfig();
  const comboStr = hotkeys[action];

  useEffect(() => {
    if (!comboStr) return;
    const combo = parseCombo(comboStr);

    const handler = (e: KeyboardEvent) => {
      if (matchesCombo(e, combo)) {
        e.preventDefault();
        callback();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [comboStr, ...deps]);
}

/**
 * Returns the parsed hotkey binding for a given action (for use in
 * component-level key handlers like SmartInput).
 */
export function useHotkeyBinding(action: string) {
  const { hotkeys } = useConfig();
  const comboStr = hotkeys[action];
  if (!comboStr) return null;
  return parseCombo(comboStr);
}

/**
 * Check if a React keyboard event matches a hotkey action binding.
 */
export function matchesHotkey(
  e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; key: string },
  comboStr: string,
): boolean {
  return matchesCombo(e as KeyboardEvent, parseCombo(comboStr));
}

/**
 * Format a hotkey combo string for display.
 * e.g. "meta+k" → "⌘K", "ctrl+shift+c" → "⌃⇧C"
 */
export function formatHotkey(combo: string): string {
  const isMac = navigator.platform.toUpperCase().includes("MAC");
  return combo
    .split("+")
    .map((part) => {
      const p = part.toLowerCase();
      if (p === "meta" || p === "cmd") return isMac ? "⌘" : "Win";
      if (p === "ctrl") return isMac ? "⌃" : "Ctrl";
      if (p === "shift") return "⇧";
      if (p === "alt" || p === "opt") return isMac ? "⌥" : "Alt";
      if (p === "enter") return "↵";
      if (p === "escape") return "Esc";
      if (p === "tab") return "Tab";
      if (p === ",") return ",";
      if (p === ".") return ".";
      return p.toUpperCase();
    })
    .join("");
}

/**
 * Convert a raw KeyboardEvent into a combo string for recording.
 * Returns null if only modifier keys are pressed.
 */
export function eventToCombo(e: KeyboardEvent): string | null {
  const modOnly = ["Meta", "Control", "Shift", "Alt"].includes(e.key);
  if (modOnly) return null;

  const parts: string[] = [];
  if (e.metaKey) parts.push("meta");
  if (e.ctrlKey) parts.push("ctrl");
  if (e.shiftKey) parts.push("shift");
  if (e.altKey) parts.push("alt");

  // Normalize the key
  let key = e.key.toLowerCase();
  if (key === " ") key = "space";
  parts.push(key);

  return parts.join("+");
}
