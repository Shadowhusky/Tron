import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useVirtualizer } from "@tanstack/react-virtual";
import { extractDirectory } from "../../../utils/platform";
import {
  Bot,
  Command,
  Check,
  X,
  AlertTriangle,
  ShieldAlert,
  Terminal as TerminalIcon,
  Brain,
  HelpCircle,
  Minimize2,
  Square,
  Trash2,
  Info,
} from "lucide-react";
import { marked } from "marked";
import { useTheme } from "../../../contexts/ThemeContext";
import type { AgentStep } from "../../../types";
import { slideUp } from "../../../utils/motion";
import { isDangerousCommand } from "../../../utils/dangerousCommand";
import TokenHeatBar from "./TokenHeatBar";

// Configure marked for minimal, safe output
marked.setOptions({ breaks: true, gfm: true });

/** Extract human-readable progress from partial/complete streaming JSON */
function describeStreamingContent(raw: string): {
  label: string;
  detail?: string;
} {
  // Try full JSON parse first
  try {
    const obj = JSON.parse(raw);
    if (obj.tool === "execute_command" && obj.command)
      return { label: "Running command", detail: obj.command };
    if (obj.tool === "run_in_terminal" && obj.command)
      return { label: "Sending to terminal", detail: obj.command };
    if (obj.tool === "write_file" && obj.path)
      return { label: "Writing file", detail: obj.path.split(/[\\/]/).pop() };
    if (obj.tool === "read_file" && obj.path)
      return { label: "Reading file", detail: obj.path.split(/[\\/]/).pop() };
    if (obj.tool === "edit_file" && obj.path)
      return { label: "Editing file", detail: obj.path.split(/[\\/]/).pop() };
    if (obj.tool === "final_answer") return { label: "Composing answer" };
    if (obj.tool) return { label: `Tool: ${obj.tool}` };
  } catch {
    /* partial JSON — use regex fallback */
  }

  // Regex extraction from partial JSON — no detail (it's incomplete and flickers)
  const toolMatch = raw.match(/"tool"\s*:\s*"([^"]+)"/);

  if (toolMatch) {
    const tool = toolMatch[1];
    if (tool === "execute_command") return { label: "Planning command" };
    if (tool === "run_in_terminal")
      return { label: "Planning terminal action" };
    if (tool === "write_file") return { label: "Preparing file write" };
    if (tool === "read_file") return { label: "Preparing file read" };
    if (tool === "edit_file") return { label: "Preparing file edit" };
    if (tool === "final_answer") return { label: "Composing answer" };
    return { label: `Planning: ${tool}` };
  }

  return { label: "Responding" };
}

/** Generate a short human-readable summary from a shell command */
function summarizeCommand(cmd: string): string {
  const trimmed = cmd.trim();
  // Strip leading cd && ... to get the actual command
  const withoutCd = trimmed.replace(/^cd\s+[^&;]+(?:&&|;)\s*/i, "");
  const base = withoutCd || trimmed;

  // File operations (from write_file, read_file, edit_file tools)
  if (/^Wrote file:\s/.test(base)) {
    const filePath = base.replace(/^Wrote file:\s*/, "").trim();
    return `Wrote ${filePath.split(/[\\/]/).pop() || "file"}`;
  }
  if (/^Read file:\s/.test(base)) {
    const filePath = base
      .replace(/^Read file:\s*/, "")
      .replace(/\s*\(\d+ chars?\)$/, "")
      .trim();
    return `Read ${filePath.split(/[\\/]/).pop() || "file"}`;
  }
  if (/^Edited file:\s/.test(base)) {
    const filePath = base
      .replace(/^Edited file:\s*/, "")
      .replace(/\s*\(\d+ replacements?\)$/, "")
      .trim();
    return `Edited ${filePath.split(/[\\/]/).pop() || "file"}`;
  }

  // Common patterns
  if (/^mkdir\s/.test(base)) {
    const dir = base.replace(/^mkdir\s+(-p\s+)?/, "").split(/\s/)[0];
    return `Created directory ${dir.split(/[\\/]/).pop()}`;
  }
  if (
    /^cat\s.*<</.test(base) ||
    /^printf\s/.test(base) ||
    /^cat\s*>/.test(base)
  ) {
    const fileMatch = base.match(/(?:>\s*|<<\s*\S+\s+)(\S+)/);
    if (fileMatch) return `Wrote file ${fileMatch[1].split(/[\\/]/).pop()}`;
    return "Wrote file";
  }
  if (/^(npm|npx|yarn|pnpm)\s+(create|init)/.test(base)) {
    return "Scaffolded new project";
  }
  if (
    /^npm\s+install/.test(base) ||
    /^npm\s+i\b/.test(base) ||
    /^yarn\s+add/.test(base)
  ) {
    return "Installed dependencies";
  }
  if (/^npm\s+run\s+(\S+)/.test(base)) {
    const script = base.match(/^npm\s+run\s+(\S+)/)?.[1];
    return `Ran npm script: ${script}`;
  }
  if (/^(npm\s+start|npm\s+run\s+dev|npx\s+vite|yarn\s+dev)/.test(base)) {
    return "Started dev server";
  }
  if (/^git\s+clone/.test(base)) return "Cloned repository";
  if (/^git\s+init/.test(base)) return "Initialized git repo";
  if (/^git\s+commit/.test(base)) return "Committed changes";
  if (/^git\s+push/.test(base)) return "Pushed to remote";
  if (/^ls\b/.test(base)) return "Listed directory contents";
  if (/^cat\s/.test(base)) {
    const file = base.replace(/^cat\s+/, "").split(/\s/)[0];
    return `Read file ${file.split(/[\\/]/).pop()}`;
  }
  if (/^rm\s/.test(base)) return "Removed files";
  if (/^cp\s/.test(base)) return "Copied files";
  if (/^mv\s/.test(base)) return "Moved/renamed files";
  if (/^cd\s/.test(base)) {
    const dir = base.replace(/^cd\s+/, "").split(/\s/)[0];
    return `Changed directory to ${dir.split(/[\\/]/).pop()}`;
  }
  if (/^chmod\s/.test(base)) return "Changed file permissions";
  if (/^curl\s|^wget\s/.test(base)) return "Downloaded resource";
  if (/^python|^python3|^node\s/.test(base)) return "Ran script";
  if (/^echo\s/.test(base)) return "Printed output";
  if (/^touch\s/.test(base)) {
    const file = base.replace(/^touch\s+/, "").split(/\s/)[0];
    return `Created file ${file.split(/[\\/]/).pop()}`;
  }
  if (/^open\s/.test(base)) return "Opened file/URL";

  // Read terminal / Checked terminal / Checking terminal — show the summary directly
  if (/^(Read|Check(ed|ing)) terminal/.test(base)) {
    return base.slice(0, 80);
  }

  // Fallback: use the first word as the verb, truncate
  const firstWord = base.split(/\s/)[0];
  if (firstWord.length > 20) return base.slice(0, 60) + "...";
  return `Ran ${firstWord}`;
}

/** Handle link clicks — open in Electron shell or new browser tab */
const handleLinkClick = (e: React.MouseEvent) => {
  const target = e.target as HTMLElement;
  const anchor = target.closest("a");
  if (!anchor) return;
  const href = anchor.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  e.stopPropagation();
  if (href.startsWith("file://")) {
    window.electron?.ipcRenderer?.invoke("shell.openPath", decodeURI(href.slice(7)));
  } else if (href.startsWith("http://") || href.startsWith("https://")) {
    if (window.electron?.ipcRenderer) {
      window.electron.ipcRenderer.invoke("shell.openExternal", href);
    } else {
      window.open(href, "_blank", "noopener,noreferrer");
    }
  }
};

/** Renders markdown string as HTML. Memoized to avoid re-parsing identical content. */
const MarkdownContent: React.FC<{ content: string; className?: string }> = ({
  content,
  className,
}) => {
  const html = useMemo(() => {
    try {
      return marked.parse(content, { async: false }) as string;
    } catch {
      return content;
    }
  }, [content]);

  return (
    <div
      className={`markdown-content ${className || ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleLinkClick}
    />
  );
};

/** Map file extension to markdown language hint */
function extToLang(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    html: "html",
    css: "css",
    json: "json",
    xml: "xml",
    svg: "xml",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    fish: "bash",
    yml: "yaml",
    yaml: "yaml",
    toml: "toml",
    md: "markdown",
    sql: "sql",
    graphql: "graphql",
    dockerfile: "dockerfile",
    swift: "swift",
    kt: "kotlin",
    scala: "scala",
    lua: "lua",
    r: "r",
    php: "php",
    vue: "html",
    svelte: "html",
  };
  return map[ext] || "";
}

/** Pre-process text to linkify absolute file paths for markdown rendering */
function linkifyPaths(text: string): string {
  // Unix paths: /foo/bar/file.ext (not preceded by another / to avoid matching URLs)
  let result = text.replace(
    /(?<!\[)(?<!\()(?<!\/)(\/([\w][\w./ _-]*)?[\w]+\.\w+)/g,
    (match) => `[${match}](file://${encodeURI(match)})`,
  );
  // Windows paths: C:\foo\bar\file.ext (drive letter + backslash path)
  result = result.replace(
    /(?<!\[)(?<!\()([A-Z]:\\(?:[\w ._-]+\\)*[\w ._-]+\.\w+)/gi,
    (match) => `[${match}](file:///${encodeURI(match.replace(/\\/g, "/"))})`,
  );
  return result;
}

/** Renders "done" step content with clickable URLs and file paths */
const LinkifiedDoneContent: React.FC<{
  content: string;
  className?: string;
}> = ({ content, className }) => {
  const html = useMemo(() => {
    try {
      const processed = linkifyPaths(content);
      return marked.parse(processed, { async: false }) as string;
    } catch {
      return content;
    }
  }, [content]);

  return (
    <div
      className={`markdown-content linkified-content ${className || ""}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleLinkClick}
    />
  );
};

interface AgentOverlayProps {
  isThinking: boolean;
  isAgentRunning: boolean;
  agentThread: AgentStep[];
  pendingCommand: string | null;
  autoExecuteEnabled: boolean;
  onToggleAutoExecute: () => void;
  thinkingEnabled: boolean;
  onToggleThinking: () => void;
  onClose: () => void;
  onClear: () => void;
  onPermission: (choice: "allow" | "always" | "deny") => void;
  isExpanded: boolean;
  onExpand: () => void;
  onRunAgent: (
    prompt: string,
    images?: import("../../../types").AttachedImage[],
  ) => Promise<void>;
  modelCapabilities?: string[] | null;
  fullHeight?: boolean;
  /** Custom height in px (undefined = default 50vh). Only used in terminal mode. */
  overlayHeight?: number;
  /** Callback when user drags to resize. */
  onResizeHeight?: (height: number) => void;
  /** Persisted scroll position (scrollTop px). */
  scrollPosition?: number;
  /** Callback to save scroll position for persistence. */
  onScrollPositionChange?: (pos: number) => void;
}

/* Toast for transient execution-state notifications only */
const AgentToast: React.FC<{
  message: string;
  type: "info" | "error" | "success";
  onDismiss: () => void;
  isLight: boolean;
}> = ({ message, type, onDismiss, isLight }) => {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    const timer = setTimeout(() => dismissRef.current(), 6000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg text-xs font-mono max-w-sm animate-in fade-in slide-in-from-right-3 border ${
        type === "error"
          ? isLight
            ? "bg-red-50 border-red-200 text-red-700"
            : "bg-red-950/80 border-red-500/20 text-red-300"
          : type === "success"
            ? isLight
              ? "bg-green-50 border-green-200 text-green-700"
              : "bg-green-950/80 border-green-500/20 text-green-300"
            : isLight
              ? "bg-white border-gray-200 text-gray-700"
              : "bg-[#1a1a2e]/90 border-white/10 text-gray-300"
      }`}
    >
      {type === "error" ? (
        <AlertTriangle className="w-3 h-3 shrink-0 text-red-400" />
      ) : type === "success" ? (
        <Check className="w-3 h-3 shrink-0 text-green-400" />
      ) : (
        <TerminalIcon className="w-3 h-3 shrink-0 text-blue-400" />
      )}
      <span className="truncate">{message}</span>
    </div>
  );
};

/** Thinking display — shows latest 2 lines by default with scroll, expandable */
const ThinkingBlock: React.FC<{
  content: string;
  isLight: boolean;
  isStreaming: boolean;
}> = ({ content, isLight, isStreaming }) => {
  const [expanded, setExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lines = content.split("\n");
  const isTruncated = lines.length > 2;
  const tokenCount = Math.round(content.length / 4);

  const [userScrolledUp, setUserScrolledUp] = useState(false);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    // If user pulls up more than 20px from bottom, consider it "scrolled up"
    if (dist > 20) {
      setUserScrolledUp(true);
    } else {
      setUserScrolledUp(false);
    }
  };

  useEffect(() => {
    if (!expanded) {
      // enhanced behavior when collapsed: stick to bottom so we see latest line
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
      return;
    }

    // When expanded, only auto-scroll if user hasn't scrolled up
    if (!userScrolledUp && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, expanded, userScrolledUp]);

  return (
    <div
      className={`mt-1 rounded border p-2 transition-all ${
        isLight
          ? "bg-purple-50/50 border-purple-200/50"
          : "bg-purple-950/20 border-purple-500/10"
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span
          className={`text-[9px] uppercase tracking-wider font-semibold ${isLight ? "text-purple-400" : "text-purple-500/80"}`}
        >
          {isStreaming ? "Thinking Process" : "Reasoning"}
        </span>
        <div className="flex items-center gap-2">
          <span
            className={`text-[9px] font-mono ${isLight ? "text-purple-400" : "text-purple-500/60"}`}
          >
            {tokenCount} tokens
          </span>
          {isTruncated && (
            <button
              onClick={() => setExpanded(!expanded)}
              className={`text-[9px] uppercase tracking-wider opacity-60 hover:opacity-100 transition-opacity ${
                isLight ? "text-purple-600" : "text-purple-400"
              }`}
            >
              {expanded ? "Collapse" : "Expand"}
            </button>
          )}
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={`transition-all ${expanded ? "max-h-60 overflow-y-auto" : "max-h-[2.75rem] overflow-hidden"}`}
        style={
          !expanded && isTruncated
            ? {
                WebkitMaskImage:
                  "linear-gradient(to bottom, transparent 0%, black 60%)",
                maskImage:
                  "linear-gradient(to bottom, transparent 0%, black 60%)",
              }
            : undefined
        }
      >
        <MarkdownContent
          content={content}
          className={`text-[11px] leading-relaxed ${isLight ? "text-gray-700" : "text-gray-300"}`}
        />
      </div>
    </div>
  );
};

/** Permission request with dangerous command detection + double-confirm */
const PermissionRequest: React.FC<{
  command: string;
  isLight: boolean;
  onPermission: (choice: "allow" | "always" | "deny") => void;
}> = ({ command, isLight, onPermission }) => {
  const dangerous = isDangerousCommand(command);
  const [confirmStep, setConfirmStep] = useState<0 | 1>(0);
  const [cmdExpanded, setCmdExpanded] = useState(false);
  const isLongCommand = command.length > 300 || command.split("\n").length > 8;
  const allowBtnRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  // Reset confirm step and collapse when command changes
  useEffect(() => {
    setConfirmStep(0);
    setCmdExpanded(false);
  }, [command]);

  // Auto-focus the "Allow Once" button when permission modal appears
  useEffect(() => {
    // Small delay to ensure DOM is ready after animation
    const t = setTimeout(() => allowBtnRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [command]);

  // Arrow key navigation between action buttons
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const container = actionsRef.current;
    if (!container) return;
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button"),
    );
    const idx = buttons.indexOf(e.target as HTMLButtonElement);
    if (idx < 0) return;
    e.preventDefault();
    const next =
      e.key === "ArrowRight"
        ? buttons[(idx + 1) % buttons.length]
        : buttons[(idx - 1 + buttons.length) % buttons.length];
    next?.focus();
  }, []);

  const handleAllow = () => {
    if (dangerous && confirmStep === 0) {
      setConfirmStep(1);
      return;
    }
    onPermission("allow");
  };

  return (
    <div
      data-testid="permission-modal"
      className={`flex flex-col border-t animate-in fade-in slide-in-from-bottom-2 ${
        dangerous
          ? isLight
            ? "bg-red-50/90 border-red-300"
            : "bg-red-950/40 border-red-500/30"
          : isLight
            ? "bg-blue-50/80 border-blue-200"
            : "bg-blue-900/20 border-blue-500/20"
      }`}
    >
      {/* Scrollable content: header + command + warnings */}
      <div className="overflow-y-auto min-h-0 p-4 pb-2" style={{ maxHeight: "calc(100% - 3rem)" }}>
        {/* Header */}
        <div
          className={`text-sm mb-2 font-medium flex items-center gap-2 shrink-0 ${
            dangerous
              ? isLight
                ? "text-red-700"
                : "text-red-300"
              : isLight
                ? "text-blue-700"
                : "text-blue-200"
          }`}
        >
          {dangerous ? (
            <ShieldAlert className="w-4 h-4" />
          ) : (
            <Command className="w-4 h-4" />
          )}
          {dangerous
            ? "Dangerous command — review carefully!"
            : "Allow command execution?"}
        </div>

        {/* Command display — collapsed by default for long commands */}
        <div className="shrink-0 mb-3">
          <div className="rounded border overflow-hidden">
            <code
              className={`block p-3 text-xs font-mono break-all whitespace-pre-wrap transition-all ${
                isLongCommand && !cmdExpanded
                  ? "max-h-[6rem] overflow-hidden"
                  : "max-h-[25vh] overflow-y-auto"
              } ${
                dangerous
                  ? isLight
                    ? "bg-red-100 border-red-300 text-red-900"
                    : "bg-red-950/50 border-red-500/20 text-red-200"
                  : isLight
                    ? "bg-white border-blue-200 text-blue-800"
                    : "bg-black/50 border-blue-500/10 text-blue-100"
              }`}
              style={
                isLongCommand && !cmdExpanded
                  ? {
                      WebkitMaskImage:
                        "linear-gradient(to bottom, black 50%, transparent 100%)",
                      maskImage:
                        "linear-gradient(to bottom, black 50%, transparent 100%)",
                    }
                  : undefined
              }
            >
              {command}
            </code>
            {isLongCommand && (
              <button
                onClick={() => setCmdExpanded(!cmdExpanded)}
                className={`w-full text-[10px] py-1 text-center uppercase tracking-wider transition-colors ${
                  isLight
                    ? "bg-gray-50 text-gray-500 hover:text-gray-800 hover:bg-gray-100"
                    : "bg-white/5 text-gray-500 hover:text-white hover:bg-white/10"
                }`}
              >
                {cmdExpanded
                  ? "Collapse"
                  : `Show full command (${command.split("\n").length} lines)`}
              </button>
            )}
          </div>
        </div>

        {/* Danger warning */}
        {dangerous && (
          <div
            className={`shrink-0 flex items-start gap-2 mb-3 p-2 rounded text-xs ${
              isLight
                ? "bg-red-100/50 text-red-700"
                : "bg-red-950/30 text-red-300/80"
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              This command is potentially destructive and may cause irreversible
              changes. Please verify before allowing.
            </span>
          </div>
        )}

        {/* Double-confirm step for dangerous commands */}
        {dangerous && confirmStep === 1 && (
          <div
            className={`shrink-0 flex items-center gap-2 mb-3 p-2 rounded border text-xs font-semibold animate-in fade-in ${
              isLight
                ? "bg-red-200/60 border-red-400 text-red-800"
                : "bg-red-900/40 border-red-500/40 text-red-200"
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5 shrink-0 animate-pulse" />
            Are you absolutely sure? Click "Confirm Execute" to proceed.
          </div>
        )}
      </div>

      {/* Action buttons — always pinned at bottom, never clipped */}
      <div
        ref={actionsRef}
        onKeyDown={handleKeyDown}
        className="flex gap-2 justify-end shrink-0 px-4 py-3"
      >
        <button
          data-testid="permission-deny"
          onClick={() => onPermission("deny")}
          className={`px-4 py-2 text-xs rounded-md border transition-colors flex items-center gap-1.5 ${
            isLight
              ? "bg-white hover:bg-gray-50 text-gray-600 border-gray-300"
              : "bg-transparent hover:bg-white/5 text-white/60 border-white/10"
          }`}
        >
          <X className="w-3 h-3" /> Deny
        </button>
        {!dangerous && (
          <button
            onClick={() => onPermission("always")}
            className={`px-4 py-2 text-xs rounded-md border transition-colors ${
              isLight
                ? "bg-blue-50 hover:bg-blue-100 text-blue-700 border-blue-300"
                : "bg-blue-900/30 hover:bg-blue-900/50 text-blue-200 border-blue-500/20"
            }`}
          >
            Always Allow
          </button>
        )}
        <button
          ref={allowBtnRef}
          data-testid="permission-allow"
          onClick={handleAllow}
          className={`px-4 py-2 text-xs rounded-md transition-colors flex items-center gap-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-1 ${
            dangerous
              ? confirmStep === 1
                ? "bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-900/30"
                : isLight
                  ? "bg-red-100 hover:bg-red-200 text-red-700 border border-red-300"
                  : "bg-red-900/40 hover:bg-red-900/60 text-red-200 border border-red-500/30"
              : "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/20"
          }`}
        >
          {dangerous ? (
            confirmStep === 1 ? (
              <>
                <AlertTriangle className="w-3 h-3" /> Confirm Execute
              </>
            ) : (
              <>
                <ShieldAlert className="w-3 h-3" /> Allow Dangerous
              </>
            )
          ) : (
            <>
              <Check className="w-3 h-3" /> Allow Once
            </>
          )}
        </button>
      </div>
    </div>
  );
};

const AgentOverlay: React.FC<AgentOverlayProps> = ({
  isThinking,
  isAgentRunning,
  agentThread,
  pendingCommand,
  autoExecuteEnabled,
  onToggleAutoExecute,
  thinkingEnabled,
  onToggleThinking,
  onClose,
  onClear,
  onPermission,
  isExpanded,
  onExpand,
  modelCapabilities,
  fullHeight,
  overlayHeight,
  onResizeHeight,
  scrollPosition,
  onScrollPositionChange,
}) => {
  const { resolvedTheme } = useTheme();
  const isLight = resolvedTheme === "light";
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelNarrow, setPanelNarrow] = useState(false);

  // Drag-to-resize state (terminal mode only)
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  const [liveHeight, setLiveHeight] = useState<number | undefined>(undefined);

  const handleDragStart = useCallback(
    (e: React.PointerEvent) => {
      if (fullHeight || !isExpanded || !panelRef.current) return;
      // Only start drag from the header area (not buttons)
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      isDragging.current = true;
      dragStartY.current = e.clientY;
      dragStartHeight.current =
        overlayHeight || panelRef.current.getBoundingClientRect().height;
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
    },
    [fullHeight, isExpanded, overlayHeight],
  );

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      if (!isDragging.current) return;
      // Dragging UP increases height
      const delta = dragStartY.current - e.clientY;
      const newHeight = Math.max(
        100,
        Math.min(window.innerHeight * 0.85, dragStartHeight.current + delta),
      );
      setLiveHeight(newHeight);
    };
    const handlePointerUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (liveHeight !== undefined && onResizeHeight) {
        onResizeHeight(liveHeight);
      }
      setLiveHeight(undefined);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [liveHeight, onResizeHeight]);

  // Track panel width for responsive controls
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setPanelNarrow(entry.contentRect.width < 400);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Collapsible executed steps: track which step indices are collapsed
  const [collapsedSteps, setCollapsedSteps] = useState<Set<number>>(new Set());
  // Collapsible run groups (previous agent runs): track by runIdx
  const [collapsedRuns, setCollapsedRuns] = useState<Set<number>>(new Set());
  // Steps the user has manually toggled open — these are never auto-collapsed
  const manuallyExpandedRef = useRef<Set<number>>(new Set());

  // Auto-collapse previous executed steps when new executing/separator step arrives
  const prevAutoCollapseLen = useRef(agentThread.length);
  useEffect(() => {
    if (agentThread.length <= prevAutoCollapseLen.current) {
      if (agentThread.length === 0) {
        setCollapsedSteps(new Set());
        setCollapsedRuns(new Set());
        manuallyExpandedRef.current = new Set();
      }
      prevAutoCollapseLen.current = agentThread.length;
      return;
    }
    const newSteps = agentThread.slice(prevAutoCollapseLen.current);
    prevAutoCollapseLen.current = agentThread.length;

    // Only collapse previous executed steps when a new run starts (separator).
    // Within a run, steps stay expanded so the user can review results.
    // Skip any that the user has manually expanded.
    const shouldCollapse = newSteps.some((s) => s.step === "separator");
    if (shouldCollapse) {
      const toCollapse = new Set(collapsedSteps);
      for (let i = 0; i < agentThread.length - newSteps.length; i++) {
        if (
          (agentThread[i].step === "executed" || agentThread[i].step === "read_terminal") &&
          !manuallyExpandedRef.current.has(i)
        ) {
          toCollapse.add(i);
        }
      }
      setCollapsedSteps(toCollapse);
    }
  }, [agentThread.length]);

  const toggleStepCollapse = useCallback((idx: number) => {
    setCollapsedSteps((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) {
        // User is expanding — mark as manually expanded
        next.delete(idx);
        manuallyExpandedRef.current.add(idx);
      } else {
        // User is collapsing — remove from manually expanded
        next.add(idx);
        manuallyExpandedRef.current.delete(idx);
      }
      return next;
    });
  }, []);

  const toggleRunCollapse = useCallback((runIdx: number) => {
    setCollapsedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(runIdx)) next.delete(runIdx);
      else next.add(runIdx);
      return next;
    });
  }, []);

  // Toast state: only for transient "executing"/"executed" notifications
  const [toasts, setToasts] = useState<
    { id: number; message: string; type: "info" | "error" | "success" }[]
  >([]);
  const toastIdRef = useRef(0);

  // Watch thread for execution-state steps → spawn toasts
  // Initialize to current length so remount doesn't replay old toasts
  const prevLenRef = useRef(agentThread.length);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      prevLenRef.current = agentThread.length;
      return;
    }
    if (agentThread.length === 0) {
      prevLenRef.current = 0;
      return;
    }
    const newSteps = agentThread.slice(prevLenRef.current);
    prevLenRef.current = agentThread.length;

    // In agent view mode (fullHeight), steps are fully visible in the panel —
    // skip redundant toasts so they don't obscure the content.
    if (!fullHeight) {
      for (const s of newSteps) {
        if (s.step === "executing") {
          const id = ++toastIdRef.current;
          setToasts((prev) => [...prev, { id, message: s.output, type: "info" }]);
        } else if (s.step === "executed") {
          const id = ++toastIdRef.current;
          const toastMsg = s.output.includes("\n---\n")
            ? s.output.slice(0, s.output.indexOf("\n---\n"))
            : s.output;
          setToasts((prev) => [
            ...prev,
            { id, message: `Done: ${toastMsg}`, type: "success" },
          ]);
        }
      }
    }
  }, [agentThread.length, fullHeight]);

  // Auto-scroll: only if user hasn't manually scrolled up
  const [userScrolledUp, setUserScrolledUp] = useState(false);
  const userScrolledUpRef = useRef(false);
  const isAutoScrolling = useRef(false);

  const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleScroll = useCallback(() => {
    // Skip scroll events caused by our own programmatic scrolling
    if (isAutoScrolling.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const scrolledUp = distFromBottom > 60;
    userScrolledUpRef.current = scrolledUp;
    setUserScrolledUp(scrolledUp);

    // Debounce-save scroll position for persistence
    if (onScrollPositionChange) {
      clearTimeout(scrollSaveTimerRef.current);
      scrollSaveTimerRef.current = setTimeout(() => {
        onScrollPositionChange(el.scrollTop);
      }, 300);
    }
  }, [onScrollPositionChange]);

  const scrollToBottom = useCallback(() => {
    isAutoScrolling.current = true;
    userScrolledUpRef.current = false;
    setUserScrolledUp(false);
    // Double-rAF: first lets virtualizer re-measure, second scrolls to true bottom
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
        requestAnimationFrame(() => {
          isAutoScrolling.current = false;
        });
      });
    });
  }, []);

  // Restore persisted scroll position on initial mount (once)
  const hasRestoredScroll = useRef(false);
  useEffect(() => {
    if (hasRestoredScroll.current) return;
    if (typeof scrollPosition !== "number" || !agentThread.length) return;
    // Wait for virtualizer to render content, then restore
    const timer = setTimeout(() => {
      if (scrollRef.current && !hasRestoredScroll.current) {
        hasRestoredScroll.current = true;
        isAutoScrolling.current = true;
        scrollRef.current.scrollTo(0, scrollPosition);
        // Mark as scrolled-up if not at bottom, so auto-scroll doesn't override
        const dist = scrollRef.current.scrollHeight - scrollPosition - scrollRef.current.clientHeight;
        if (dist > 60) {
          userScrolledUpRef.current = true;
          setUserScrolledUp(true);
        }
        requestAnimationFrame(() => {
          isAutoScrolling.current = false;
        });
      }
    }, 100);
    return () => clearTimeout(timer);
  }, [scrollPosition, agentThread.length]);

  const lastEntry = agentThread[agentThread.length - 1];
  const scrollTrigger = `${agentThread.length}:${lastEntry?.output?.length || 0}`;
  useEffect(() => {
    if (!userScrolledUpRef.current) {
      isAutoScrolling.current = true;
      // Double-rAF: let virtualizer re-measure before scrolling to true bottom
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
          requestAnimationFrame(() => {
            isAutoScrolling.current = false;
          });
        });
      });
    }
  }, [scrollTrigger]);

  // Reset toasts on new run
  useEffect(() => {
    if (agentThread.length === 0) setToasts([]);
  }, [agentThread.length]);

  const dismissToast = useCallback(
    (id: number) => setToasts((prev) => prev.filter((t) => t.id !== id)),
    [],
  );

  const statusText = isThinking
    ? "Agent is thinking..."
    : isAgentRunning
      ? "Agent working..."
      : (() => {
          const last = agentThread[agentThread.length - 1];
          if (!last) return "Idle";
          if (last.step === "stopped") return "Stopped";
          if (last.step === "error" || last.step === "failed")
            return last.output.toLowerCase().includes("abort")
              ? "Task Aborted"
              : "Task Failed";
          if (last.step === "question") return "Awaiting Input";
          if (last.step === "done") return "Task Completed";
          return "Task Completed";
        })();

  // Steps to show in panel: include executing steps (with spinner)
  const panelSteps = agentThread;

  // --- Virtual list for agent history ---
  const flatItems = useMemo(() => {
    // Group steps into runs (by separator)
    const runs: {
      title: string;
      isAgentRun: boolean;
      steps: { step: AgentStep; globalIdx: number }[];
    }[] = [];
    for (let gi = 0; gi < panelSteps.length; gi++) {
      const s = panelSteps[gi];
      if (s.step === "separator") {
        runs.push({ title: s.output, isAgentRun: true, steps: [] });
      } else {
        if (runs.length === 0 || runs[runs.length - 1].isAgentRun) {
          runs.push({ title: "", isAgentRun: false, steps: [] });
        }
        runs[runs.length - 1].steps.push({ step: s, globalIdx: gi });
      }
    }
    // Flatten: previous/standalone runs = single item each; current run = header + individual steps
    const items: Array<
      | {
          kind: "group";
          runIdx: number;
          isLast: boolean;
          title: string;
          isAgentRun: boolean;
          steps: { step: AgentStep; globalIdx: number }[];
        }
      | { kind: "step"; step: AgentStep; globalIdx: number }
      | { kind: "loader" }
      | { kind: "continue" }
    > = [];
    runs.forEach((run, runIdx) => {
      const isLast = runIdx === runs.length - 1;
      if (isLast && run.isAgentRun) {
        // Current agent run: header + individual steps for virtualization
        items.push({
          kind: "group",
          runIdx,
          isLast: true,
          title: run.title,
          isAgentRun: true,
          steps: [],
        });
        run.steps.forEach((s) =>
          items.push({ kind: "step", step: s.step, globalIdx: s.globalIdx }),
        );
      } else {
        // Previous runs or standalone: single item containing all steps
        items.push({
          kind: "group",
          runIdx,
          isLast: false,
          title: run.title,
          isAgentRun: run.isAgentRun,
          steps: run.steps,
        });
      }
    });
    // Loading indicator
    if (isAgentRunning) {
      const last = panelSteps[panelSteps.length - 1];
      if (last?.step !== "thinking" && last?.step !== "streaming")
        items.push({ kind: "loader" });
    }
    // Continue button
    if (isAgentRunning) {
      const recentSteps = panelSteps.slice(-5);
      const recentChecks = recentSteps.filter(
        (s) => s.step === "read_terminal" || (s.step === "executed" && s.output.startsWith("Checked terminal")),
      );
      if (recentChecks.length >= 2) {
        const lastCheck =
          recentChecks[recentChecks.length - 1].output.toLowerCase();
        if (
          /\b(login|password|confirm|auth|browser|visit|open.*url|waiting.*input|unchanged)\b/.test(
            lastCheck,
          )
        )
          items.push({ kind: "continue" });
      }
    }
    return items;
  }, [panelSteps, isAgentRunning]);

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => {
      const item = flatItems[i];
      if (!item) return 50;
      if (item.kind === "group") return item.isLast ? 28 : 32;
      if (item.kind === "loader" || item.kind === "continue") return 36;
      return 50;
    },
    paddingStart: 16,
    paddingEnd: 16,
    gap: 8,
    overscan: 3,
  });

  const showPanel =
    fullHeight ||
    isAgentRunning ||
    isThinking ||
    pendingCommand ||
    panelSteps.length > 0;

  if (!showPanel && toasts.length === 0) return null;

  return (
    <>
      {/* Toast stack — top right of session */}
      <AnimatePresence>
        {toasts.length > 0 && (
          <div className="absolute top-2 right-2 z-30 flex flex-col gap-1.5 pointer-events-auto">
            {toasts.slice(-4).map((t) => (
              <motion.div
                key={t.id}
                initial={{ opacity: 0, x: 20, scale: 0.95 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 20, scale: 0.95 }}
                transition={{ duration: 0.2 }}
              >
                <AgentToast
                  message={t.message}
                  type={t.type}
                  isLight={isLight}
                  onDismiss={() => dismissToast(t.id)}
                />
              </motion.div>
            ))}
          </div>
        )}
      </AnimatePresence>

      {/* Agent Panel */}
      {showPanel && (
        <motion.div
          ref={panelRef}
          data-testid="agent-overlay"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          style={
            !fullHeight &&
            isExpanded &&
            (liveHeight !== undefined || overlayHeight)
              ? { height: liveHeight ?? overlayHeight, maxHeight: "60%" }
              : undefined
          }
          className={`w-full ${fullHeight ? "flex-1 min-h-0" : ""} ${
            isExpanded
              ? fullHeight
                ? "flex-col"
                : liveHeight !== undefined || overlayHeight
                  ? "flex-col"
                  : "max-h-[60%] flex-col"
              : "h-auto cursor-pointer hover:opacity-100 opacity-90"
          } overflow-hidden border-t flex shadow-lg z-20 ${
            isLight
              ? "bg-white/95 border-gray-200 text-gray-900"
              : resolvedTheme === "modern"
                ? "bg-[#0a0a1a]/60 border-white/[0.06] text-white shadow-[0_-4px_24px_rgba(0,0,0,0.3)]"
                : "bg-[#0a0a0a]/95 border-white/10 text-white"
          }`}
          onClick={!isExpanded ? onExpand : undefined}
        >
          {/* Resize grip — only in terminal mode when expanded */}
          {!fullHeight && isExpanded && (
            <div
              onPointerDown={handleDragStart}
              className="flex justify-center py-0.5 cursor-ns-resize shrink-0"
            >
              <div
                className={`w-8 h-0.5 rounded-full ${isLight ? "bg-gray-300" : "bg-white/15"}`}
              />
            </div>
          )}

          {/* Status Header */}
          <div
            onPointerDown={handleDragStart}
            className={`flex items-center justify-between gap-2 px-3 py-1.5 shrink-0 ${
              !fullHeight && isExpanded ? "cursor-ns-resize" : ""
            } ${isExpanded ? "border-b" : ""} ${
              isLight
                ? "border-gray-200/80 bg-gray-50/60"
                : "border-white/5 bg-white/5"
            }`}
          >
            <div className="flex items-center gap-2 shrink-0">
              <div
                className={`w-2 h-2 rounded-full ${
                  isAgentRunning || isThinking
                    ? "bg-purple-400 animate-pulse"
                    : "bg-gray-500"
                }`}
              />
              <span
                data-testid="agent-status"
                className={`text-xs font-medium ${
                  isLight ? "text-purple-700" : "text-purple-200"
                }`}
              >
                {statusText}
              </span>
            </div>

            {/* Controls - Only show when expanded, logic for minimize/expand handled by container click when collapsed */}
            {isExpanded && (
              <div className="flex items-center gap-1 flex-wrap justify-end">
                {modelCapabilities?.includes("thinking") && (
                  <button
                    data-testid="thinking-toggle"
                    onClick={onToggleThinking}
                    className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors flex items-center gap-1 shrink-0 ${
                      thinkingEnabled
                        ? isLight
                          ? "border-purple-300 text-purple-600 bg-purple-50 hover:bg-purple-100"
                          : "border-purple-500/30 text-purple-400 bg-purple-500/10 hover:bg-purple-500/20"
                        : isLight
                          ? "border-gray-300 text-gray-500 bg-gray-50 hover:bg-gray-100"
                          : "border-white/10 text-gray-500 bg-white/5 hover:bg-white/10"
                    }`}
                    title={
                      thinkingEnabled
                        ? "Disable thinking (faster responses)"
                        : "Enable thinking (more thorough reasoning)"
                    }
                  >
                    <Brain className="w-3 h-3" />
                    {"Thinking " + (thinkingEnabled ? "ON" : "OFF")}
                  </button>
                )}
                <button
                  data-testid="autoexec-toggle"
                  onClick={onToggleAutoExecute}
                  className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors flex items-center gap-1 shrink-0 ${
                    autoExecuteEnabled
                      ? isLight
                        ? "border-orange-300 text-orange-600 bg-orange-50 hover:bg-orange-100"
                        : "border-orange-500/30 text-orange-400 bg-orange-500/10 hover:bg-orange-500/20"
                      : isLight
                        ? "border-gray-300 text-gray-500 bg-gray-50 hover:bg-gray-100"
                        : "border-white/10 text-gray-500 bg-white/5 hover:bg-white/10"
                  }`}
                  title={
                    autoExecuteEnabled
                      ? "Disable auto-execute"
                      : "Enable auto-execute (skip permission prompts)"
                  }
                >
                  {panelNarrow
                    ? "Exec"
                    : "Auto Exec " + (autoExecuteEnabled ? "ON" : "OFF")}
                </button>
                {!isAgentRunning && agentThread.length > 0 && (
                  <button
                    data-testid="agent-clear"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClear();
                    }}
                    className={`text-[10px] px-1.5 py-0.5 rounded transition-colors shrink-0 flex items-center gap-1 ${
                      isLight
                        ? "text-gray-500 hover:text-red-600 hover:bg-red-50"
                        : "text-gray-500 hover:text-red-400 hover:bg-red-500/10"
                    }`}
                    title="Clear agent panel (⇧⌘K)"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                )}
                {!fullHeight && (
                  <button
                    data-testid="agent-minimize"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose();
                    }}
                    className={`text-[10px] px-1.5 py-0.5 rounded transition-colors shrink-0 flex items-center gap-1 ${
                      isLight
                        ? "text-gray-500 hover:text-gray-900 hover:bg-gray-200/60"
                        : "text-gray-400 hover:text-white hover:bg-white/10"
                    }`}
                    title="Minimize panel (Cmd+.)"
                  >
                    <Minimize2 className="w-3 h-3" />
                    {!panelNarrow && (
                      <span className="uppercase tracking-wider">Min</span>
                    )}
                  </button>
                )}
              </div>
            )}

            {/* Show simple expand hint when collapsed */}
            {!isExpanded && (
              <span className="text-[10px] opacity-50 uppercase tracking-widest">
                Click to Expand
              </span>
            )}
          </div>

          {/* Thread History - Only show when expanded */}
          {isExpanded && (panelSteps.length > 0 || isAgentRunning) && (
            <div className="flex-1 relative min-h-0">
              <div
                ref={scrollRef}
                onScroll={handleScroll}
                className="h-full overflow-y-auto font-mono text-xs"
              >
                {(() => {
                  const renderStep = (
                    step: AgentStep,
                    key: string,
                    globalIdx: number,
                  ) => {
                    const isStopped = step.step === "stopped";
                    const isError =
                      step.step === "error" || step.step === "failed";
                    const isDone = step.step === "done";
                    const isQuestion = step.step === "question";
                    const isReadTerminal = step.step === "read_terminal";
                    const isExecuted = step.step === "executed" || isReadTerminal;
                    const isExecuting = step.step === "executing";
                    const isThinkingStep = step.step === "thinking";
                    const isThought = step.step === "thought";
                    const isStreamingStep = step.step === "streaming";
                    const isSystem = step.step === "system";
                    const streamInfo = isStreamingStep
                      ? describeStreamingContent(step.output)
                      : null;
                    const isCollapsed =
                      isExecuted && collapsedSteps.has(globalIdx);

                    // For executed/failed steps, split command from output
                    let execCommand = "";
                    let execOutput = step.output;
                    if (
                      (isExecuted || isError) &&
                      step.output.includes("\n---\n")
                    ) {
                      const sepIdx = step.output.indexOf("\n---\n");
                      execCommand = step.output.slice(0, sepIdx);
                      execOutput = step.output.slice(sepIdx + 5);
                    }

                    // Stopped: render a tiny inline indicator, not a full step block
                    if (isStopped) {
                      return (
                        <div
                          key={key}
                          className="flex items-center gap-1.5 pl-4 opacity-60"
                        >
                          <Square
                            className={`w-2.5 h-2.5 ${isLight ? "text-gray-400" : "text-gray-500"}`}
                          />
                          <span
                            className={`text-[10px] font-mono ${isLight ? "text-gray-400" : "text-gray-500"}`}
                          >
                            Stopped
                          </span>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={key}
                        className={`border-l-2 pl-4 py-2 ${
                          isError
                            ? isLight
                              ? "border-red-300"
                              : "border-red-500/30"
                            : isDone
                              ? isLight
                                ? "border-green-300"
                                : "border-green-500/30"
                              : isSystem
                                ? isLight
                                  ? "border-teal-300"
                                  : "border-teal-500/30"
                                : isQuestion
                                  ? isLight
                                    ? "border-amber-300"
                                    : "border-amber-500/30"
                                  : isExecuting
                                    ? isLight
                                      ? "border-amber-300"
                                      : "border-amber-500/30"
                                    : isExecuted
                                      ? isLight
                                        ? "border-blue-300"
                                        : "border-blue-500/30"
                                      : isThinkingStep || isThought
                                        ? isLight
                                          ? "border-purple-300"
                                          : "border-purple-500/30"
                                        : isStreamingStep
                                          ? isLight
                                            ? "border-cyan-300"
                                            : "border-cyan-500/30"
                                          : isLight
                                            ? "border-gray-200"
                                            : "border-white/10"
                        }`}
                      >
                        <div
                          className={`flex items-center gap-1.5 mb-0.5 ${isExecuted ? "cursor-pointer select-none" : ""}`}
                          onClick={
                            isExecuted
                              ? () => toggleStepCollapse(globalIdx)
                              : undefined
                          }
                        >
                          {isExecuted && (
                            <span
                              className={`text-[9px] opacity-50 transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                            >
                              ▶
                            </span>
                          )}
                          {isError ? (
                            <AlertTriangle className="w-3 h-3 text-red-400" />
                          ) : isDone ? (
                            <Check className="w-3 h-3 text-green-400" />
                          ) : isSystem ? (
                            <Info className="w-3 h-3 text-teal-400" />
                          ) : isQuestion ? (
                            <HelpCircle className="w-3 h-3 text-amber-400" />
                          ) : isExecuting ? (
                            <TerminalIcon className="w-3 h-3 text-amber-400 animate-pulse" />
                          ) : isExecuted ? (
                            <Check className="w-3 h-3 text-blue-400" />
                          ) : isThinkingStep || isThought ? (
                            <Brain
                              className={`w-3 h-3 text-purple-400 ${isThinkingStep ? "animate-pulse" : ""}`}
                            />
                          ) : isStreamingStep ? (
                            <TerminalIcon className="w-3 h-3 text-cyan-400 animate-pulse" />
                          ) : (
                            <TerminalIcon className="w-3 h-3 text-gray-400 opacity-60" />
                          )}
                          <span
                            className={`uppercase font-bold text-[10px] tracking-wider ${
                              isExecuting
                                ? "text-amber-400"
                                : isExecuted
                                  ? "text-blue-400"
                                  : isError
                                    ? "text-red-400"
                                    : isDone
                                      ? "text-green-400"
                                      : isSystem
                                        ? "text-teal-400"
                                        : isQuestion
                                          ? "text-amber-400"
                                          : isThinkingStep || isThought
                                            ? "text-purple-400"
                                            : isStreamingStep
                                              ? "text-cyan-400"
                                              : "text-gray-500"
                            }`}
                          >
                            {isExecuting
                              ? "running..."
                              : isThinkingStep
                                ? "thinking..."
                                : isStreamingStep
                                  ? `${streamInfo!.label}...`
                                  : isExecuted && execCommand
                                    ? summarizeCommand(execCommand)
                                    : step.step}
                          </span>
                          {isCollapsed && (
                            <span
                              className={`text-[10px] truncate flex-1 min-w-0 ${isLight ? "text-gray-400" : "text-gray-500"}`}
                            >
                              {execCommand
                                ? summarizeCommand(execCommand)
                                : step.output.startsWith("Sent:")
                                  ? "Sent input to terminal"
                                  : step.output.split("\n")[0].slice(0, 120)}
                            </span>
                          )}
                          {(isThinkingStep ||
                            isStreamingStep ||
                            isExecuting) && (
                            <div className="flex gap-0.5 ml-1">
                              <div
                                className={`w-1 h-1 rounded-full animate-bounce ${isThinkingStep ? "bg-purple-400" : isExecuting ? "bg-amber-400" : "bg-cyan-400"}`}
                                style={{ animationDelay: "0ms" }}
                              />
                              <div
                                className={`w-1 h-1 rounded-full animate-bounce ${isThinkingStep ? "bg-purple-400" : isExecuting ? "bg-amber-400" : "bg-cyan-400"}`}
                                style={{ animationDelay: "150ms" }}
                              />
                              <div
                                className={`w-1 h-1 rounded-full animate-bounce ${isThinkingStep ? "bg-purple-400" : isExecuting ? "bg-amber-400" : "bg-cyan-400"}`}
                                style={{ animationDelay: "300ms" }}
                              />
                            </div>
                          )}
                        </div>
                        {/* Output — hidden when collapsed */}
                        {isCollapsed ? null : (isExecuted ||
                            (isError && execCommand)) &&
                          execCommand ? (
                          (() => {
                            // File write preview: syntax-highlighted code
                            const isFileWrite =
                              execCommand.startsWith("Wrote file:");
                            if (isFileWrite && execOutput) {
                              const writtenPath = execCommand
                                .replace("Wrote file: ", "")
                                .trim();
                              const lang = extToLang(writtenPath);
                              const fileName =
                                writtenPath.split(/[\\/]/).pop() || writtenPath;
                              const fenced =
                                "```" + lang + "\n" + execOutput + "\n```";
                              return (
                                <div>
                                  <div
                                    className={`flex items-center gap-1.5 mt-1 mb-1 text-[11px] font-mono cursor-pointer ${isLight ? "text-green-700 hover:text-green-900" : "text-green-400/80 hover:text-green-300"}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      window.electron.ipcRenderer.invoke(
                                        "shell.openPath",
                                        writtenPath,
                                      );
                                    }}
                                    title={`Open ${writtenPath}`}
                                  >
                                    <span>{fileName}</span>
                                    <span
                                      className={`text-[9px] ${isLight ? "text-gray-400" : "text-gray-600"}`}
                                    >
                                      {extractDirectory(writtenPath)}
                                    </span>
                                  </div>
                                  <details className="group">
                                    <summary
                                      className={`cursor-pointer text-[11px] truncate select-none list-none flex items-center gap-1.5 ${
                                        isLight
                                          ? "text-gray-500 hover:text-gray-900"
                                          : "text-gray-400 hover:text-white"
                                      }`}
                                    >
                                      <span className="text-[9px] opacity-50 group-open:rotate-90 transition-transform">
                                        ▶
                                      </span>
                                      Show created file
                                    </summary>
                                    <MarkdownContent
                                      content={fenced}
                                      className={`mt-1 text-[11px] leading-relaxed max-h-60 overflow-y-auto ${isLight ? "markdown-light text-gray-800" : "text-gray-300"}`}
                                    />
                                  </details>
                                </div>
                              );
                            }

                            // File edit diff: show search/replace
                            const isFileEdit =
                              execCommand.startsWith("Edited file:");
                            if (isFileEdit && execOutput) {
                              const editPath = execCommand
                                .replace(/^Edited file:\s*/, "")
                                .replace(/\s*\(\d+ replacements?\)$/, "")
                                .trim();
                              const fileName =
                                editPath.split(/[\\/]/).pop() || editPath;
                              // Parse diff: "--- search\n{search}\n+++ replace\n{replace}"
                              const searchMatch = execOutput.match(
                                /^--- search\n([\s\S]*?)\n\+\+\+ replace\n([\s\S]*)$/,
                              );
                              const searchText = searchMatch?.[1] || "";
                              const replaceText = searchMatch?.[2] || "";
                              return (
                                <div>
                                  <div
                                    className={`flex items-center gap-1.5 mt-1 mb-1 text-[11px] font-mono cursor-pointer ${isLight ? "text-yellow-700 hover:text-yellow-900" : "text-yellow-400/80 hover:text-yellow-300"}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      window.electron.ipcRenderer.invoke(
                                        "shell.openPath",
                                        editPath,
                                      );
                                    }}
                                    title={`Open ${editPath}`}
                                  >
                                    <span>{fileName}</span>
                                    <span
                                      className={`text-[9px] ${isLight ? "text-gray-400" : "text-gray-600"}`}
                                    >
                                      {extractDirectory(editPath)}
                                    </span>
                                  </div>
                                  <details className="group">
                                    <summary
                                      className={`cursor-pointer text-[11px] truncate select-none list-none flex items-center gap-1.5 ${
                                        isLight
                                          ? "text-gray-500 hover:text-gray-900"
                                          : "text-gray-400 hover:text-white"
                                      }`}
                                    >
                                      <span className="text-[9px] opacity-50 group-open:rotate-90 transition-transform">
                                        ▶
                                      </span>
                                      Show edit changes
                                    </summary>
                                    <div
                                      className={`mt-1 rounded border text-[11px] font-mono leading-relaxed max-h-60 overflow-y-auto ${isLight ? "bg-gray-50 border-gray-200" : "bg-black/40 border-white/5"}`}
                                    >
                                      {searchText && (
                                        <div
                                          className={`p-2 ${isLight ? "bg-red-50/80" : "bg-red-950/30"}`}
                                        >
                                          {searchText
                                            .split("\n")
                                            .map((line, i) => (
                                              <div
                                                key={i}
                                                className={
                                                  isLight
                                                    ? "text-red-700"
                                                    : "text-red-400/80"
                                                }
                                              >
                                                <span className="select-none opacity-50">
                                                  -{" "}
                                                </span>
                                                {line}
                                              </div>
                                            ))}
                                        </div>
                                      )}
                                      {replaceText && (
                                        <div
                                          className={`p-2 ${searchText ? (isLight ? "border-t border-gray-200" : "border-t border-white/5") : ""} ${isLight ? "bg-green-50/80" : "bg-green-950/30"}`}
                                        >
                                          {replaceText
                                            .split("\n")
                                            .map((line, i) => (
                                              <div
                                                key={i}
                                                className={
                                                  isLight
                                                    ? "text-green-700"
                                                    : "text-green-400/80"
                                                }
                                              >
                                                <span className="select-none opacity-50">
                                                  +{" "}
                                                </span>
                                                {line}
                                              </div>
                                            ))}
                                        </div>
                                      )}
                                    </div>
                                  </details>
                                </div>
                              );
                            }

                            return (
                              <div>
                                <code
                                  className={`block text-[11px] font-mono mt-1 mb-1 ${isLight ? "text-green-700" : "text-green-400/80"}`}
                                >
                                  $ {execCommand}
                                </code>
                                {execOutput.length > 120 ? (
                                  <details className="group">
                                    <summary
                                      className={`cursor-pointer text-[11px] truncate select-none list-none flex items-center gap-1.5 ${
                                        isLight
                                          ? "text-gray-500 hover:text-gray-900"
                                          : "text-gray-400 hover:text-white"
                                      }`}
                                    >
                                      <span className="text-[9px] opacity-50 group-open:rotate-90 transition-transform">
                                        ▶
                                      </span>
                                      {execOutput.slice(0, 80)}...
                                    </summary>
                                    <pre
                                      className={`mt-1 p-2 rounded border text-[11px] leading-relaxed whitespace-pre-wrap overflow-y-auto max-h-40 ${
                                        isLight
                                          ? "bg-gray-50 border-gray-200 text-gray-800"
                                          : "bg-black/40 border-white/5 text-gray-300"
                                      }`}
                                    >
                                      {execOutput}
                                    </pre>
                                  </details>
                                ) : (
                                  <code
                                    className={`block text-[11px] whitespace-pre-wrap ${isLight ? "text-gray-600" : "text-gray-400"}`}
                                  >
                                    {execOutput}
                                  </code>
                                )}
                              </div>
                            );
                          })()
                        ) : isThinkingStep || isThought ? (
                          <ThinkingBlock
                            content={step.output}
                            isLight={isLight}
                            isStreaming={isThinkingStep}
                          />
                        ) : isStreamingStep ? (
                          (() => {
                            // Show detail if available (only when JSON fully parsed — e.g. command preview)
                            if (streamInfo?.detail) {
                              return (
                                <code
                                  className={`block text-[11px] whitespace-pre-wrap truncate ${isLight ? "text-gray-500" : "text-gray-400"} opacity-70`}
                                >
                                  {streamInfo.detail}
                                </code>
                              );
                            }
                            // Compact heat bar — keeps height stable (~1 line) to avoid layout shift
                            if (step.output.length > 0) {
                              return (
                                <TokenHeatBar
                                  text={step.output}
                                  isLight={isLight}
                                />
                              );
                            }
                            return null;
                          })()
                        ) : isDone || isSystem || isQuestion ? (
                          <LinkifiedDoneContent
                            content={step.output}
                            className={`text-[11px] leading-relaxed ${isLight ? "markdown-light text-gray-700" : "text-gray-300"}`}
                          />
                        ) : step.output.length > 120 ? (
                          <details className="group">
                            <summary
                              className={`cursor-pointer text-[11px] truncate select-none list-none flex items-center gap-1.5 ${
                                isLight
                                  ? "text-gray-500 hover:text-gray-900"
                                  : "text-gray-400 hover:text-white"
                              }`}
                            >
                              <span className="text-[9px] opacity-50 group-open:rotate-90 transition-transform">
                                ▶
                              </span>
                              {step.output.slice(0, 80)}...
                            </summary>
                            <pre
                              className={`mt-1 p-2 rounded border text-[11px] leading-relaxed whitespace-pre-wrap overflow-y-auto max-h-40 ${
                                isLight
                                  ? "bg-gray-50 border-gray-200 text-gray-800"
                                  : "bg-black/40 border-white/5 text-gray-300"
                              }`}
                            >
                              {step.output}
                            </pre>
                          </details>
                        ) : (
                          <code
                            className={`block text-[11px] whitespace-pre-wrap ${isLight ? "text-gray-600" : "text-gray-400"}`}
                          >
                            {step.output}
                          </code>
                        )}
                      </div>
                    );
                  };

                  // Helper: render a group item (previous run, standalone, or current run header)
                  const renderGroup = (item: {
                    runIdx: number;
                    isLast: boolean;
                    title: string;
                    isAgentRun: boolean;
                    steps: { step: AgentStep; globalIdx: number }[];
                  }) => {
                    // Parse images from separator output
                    let promptText = item.title;
                    let runImages: {
                      base64: string;
                      mediaType: string;
                      name: string;
                    }[] = [];
                    const imgDelimIdx = item.title.indexOf("\n---images---\n");
                    if (imgDelimIdx !== -1) {
                      promptText = item.title.slice(0, imgDelimIdx);
                      try {
                        runImages = JSON.parse(
                          item.title.slice(imgDelimIdx + 15),
                        );
                      } catch {
                        /* ignore */
                      }
                    }
                    const firstLine = promptText.split("\n")[0].trim();
                    const displayTitle =
                      firstLine.slice(0, 80) +
                      (firstLine.length > 80 ? "..." : "");

                    const imageThumbs =
                      runImages.length > 0 ? (
                        <div className="flex items-center gap-1 mt-1 ml-5">
                          {runImages.map((img, imgIdx) => (
                            <img
                              key={imgIdx}
                              src={`data:${img.mediaType};base64,${img.base64}`}
                              alt={img.name}
                              className={`h-8 w-8 rounded object-cover border ${isLight ? "border-gray-200" : "border-white/10"}`}
                            />
                          ))}
                        </div>
                      ) : null;

                    // Current (last) agent run: just the header (steps are separate virtual items)
                    if (item.isLast && item.isAgentRun) {
                      return (
                        <div className="py-1">
                          <div className="flex items-center gap-1.5">
                            <Bot className="w-3 h-3 text-purple-400 opacity-60 shrink-0" />
                            <span
                              className={`text-[10px] truncate flex-1 min-w-0 ${isLight ? "text-gray-400" : "text-gray-500"}`}
                            >
                              {displayTitle}
                            </span>
                          </div>
                          {imageThumbs}
                        </div>
                      );
                    }

                    // Standalone commands: render flat, no run wrapper
                    if (!item.isAgentRun) {
                      return (
                        <div className="space-y-1.5">
                          {item.steps.map((s, si) =>
                            renderStep(
                              s.step,
                              `${item.runIdx}-${si}`,
                              s.globalIdx,
                            ),
                          )}
                        </div>
                      );
                    }

                    // Previous agent run (collapsed)
                    const lastStepEntry = item.steps[item.steps.length - 1];
                    const lastStepType = lastStepEntry?.step.step;
                    const statusIcon =
                      lastStepType === "done"
                        ? "✓"
                        : lastStepType === "stopped"
                          ? "■"
                          : lastStepType === "error" ||
                              lastStepType === "failed"
                            ? "✗"
                            : "—";
                    const statusColor =
                      lastStepType === "done"
                        ? isLight
                          ? "text-green-600"
                          : "text-green-400"
                        : lastStepType === "error" || lastStepType === "failed"
                          ? isLight
                            ? "text-red-600"
                            : "text-red-400"
                          : isLight
                            ? "text-gray-400"
                            : "text-gray-500";

                    const isRunCollapsed = collapsedRuns.has(item.runIdx);

                    return (
                      <div>
                        <div
                          className="flex items-center gap-1.5 py-1 cursor-pointer select-none"
                          onClick={() => toggleRunCollapse(item.runIdx)}
                        >
                          <span className={`text-[9px] opacity-50 transition-transform ${isRunCollapsed ? "" : "rotate-90"}`}>
                            ▶
                          </span>
                          <span
                            className={`text-[10px] font-semibold ${statusColor}`}
                          >
                            {statusIcon}
                          </span>
                          <span
                            className={`text-[10px] truncate flex-1 min-w-0 ${isLight ? "text-gray-400" : "text-gray-500"}`}
                          >
                            {displayTitle}
                          </span>
                        </div>
                        {!isRunCollapsed && (
                          <>
                            {imageThumbs}
                            <div className="space-y-1.5 pb-1">
                              {item.steps.map((s, si) =>
                                renderStep(
                                  s.step,
                                  `${item.runIdx}-${si}`,
                                  s.globalIdx,
                                ),
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  };

                  // Helper: render loading indicator
                  const renderLoader = () => {
                    const useThinkingStyle = isThinking;
                    return (
                      <div
                        className={`border-l-2 pl-3 py-1 ${useThinkingStyle ? (isLight ? "border-purple-300" : "border-purple-500/30") : isLight ? "border-cyan-300" : "border-cyan-500/30"}`}
                      >
                        <div className="flex items-center gap-1.5">
                          {useThinkingStyle ? (
                            <Brain className="w-3 h-3 text-purple-400 animate-pulse" />
                          ) : (
                            <Bot className="w-3 h-3 text-cyan-400 animate-pulse" />
                          )}
                          <span
                            className={`uppercase font-bold text-[10px] tracking-wider ${useThinkingStyle ? "text-purple-400" : "text-cyan-400"}`}
                          >
                            {useThinkingStyle ? "Thinking..." : "Working..."}
                          </span>
                          <div className="flex gap-0.5 ml-1">
                            {[0, 150, 300].map((d) => (
                              <div
                                key={d}
                                className={`w-1 h-1 rounded-full animate-bounce ${useThinkingStyle ? "bg-purple-400" : "bg-cyan-400"}`}
                                style={{ animationDelay: `${d}ms` }}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    );
                  };

                  // Helper: render continue button
                  const renderContinue = () => (
                    <div
                      className={`border-l-2 pl-4 py-2 ${isLight ? "border-amber-300" : "border-amber-500/30"}`}
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[11px] ${isLight ? "text-gray-500" : "text-gray-400"}`}
                        >
                          Waiting for your action...
                        </span>
                        <button
                          onClick={() => {
                            (globalThis as any).__tronAgentContinue = true;
                          }}
                          className={`text-[11px] px-2.5 py-1 rounded-md font-medium transition-colors ${
                            isLight
                              ? "bg-amber-100 hover:bg-amber-200 text-amber-700 border border-amber-300"
                              : "bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/20"
                          }`}
                        >
                          I'm Done — Continue
                        </button>
                      </div>
                    </div>
                  );

                  return (
                    <div
                      style={{
                        height: `${virtualizer.getTotalSize()}px`,
                        width: "100%",
                        position: "relative",
                      }}
                    >
                      {virtualizer.getVirtualItems().map((vRow) => {
                        const item = flatItems[vRow.index];
                        if (!item) return null;
                        return (
                          <div
                            key={vRow.key}
                            data-index={vRow.index}
                            ref={virtualizer.measureElement}
                            style={{
                              position: "absolute",
                              top: 0,
                              left: 0,
                              width: "100%",
                              transform: `translateY(${vRow.start}px)`,
                              padding: "0 16px",
                            }}
                          >
                            {item.kind === "step"
                              ? renderStep(
                                  item.step,
                                  `step-${item.globalIdx}`,
                                  item.globalIdx,
                                )
                              : item.kind === "group"
                                ? renderGroup(item)
                                : item.kind === "loader"
                                  ? renderLoader()
                                  : renderContinue()}
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>

              {/* Scroll to bottom button — shown when user has scrolled up */}
              <AnimatePresence>
                {userScrolledUp && isAgentRunning && (
                  <motion.button
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                    transition={{ duration: 0.15 }}
                    onClick={scrollToBottom}
                    className={`absolute bottom-2 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full text-[10px] font-medium shadow-lg z-10 transition-colors ${
                      isLight
                        ? "bg-gray-100 hover:bg-gray-200 text-gray-600 border border-gray-300"
                        : "bg-white/10 hover:bg-white/15 text-gray-300 border border-white/10"
                    }`}
                  >
                    ↓ Scroll to bottom
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Permission Request - Only show when expanded */}
          <AnimatePresence>
            {isExpanded && pendingCommand && (
              <motion.div
                key="permission"
                variants={slideUp}
                initial="hidden"
                animate="visible"
                exit="exit"
                className="shrink-0 max-h-[60%]"
              >
                <PermissionRequest
                  command={pendingCommand}
                  isLight={isLight}
                  onPermission={onPermission}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      )}
    </>
  );
};

// Custom memo: skip function props (event handlers change identity on every parent render
// but always perform the same logical action). Only compare data props.
export default React.memo(AgentOverlay, (prev, next) => {
  const keys = Object.keys(next) as (keyof typeof next)[];
  for (const key of keys) {
    if (typeof next[key] === "function") continue;
    if (prev[key] !== next[key]) return false;
  }
  return true;
});
