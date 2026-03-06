import { useState, useEffect, useCallback, useRef } from "react";
import { Save, X, FileCode, ExternalLink, RotateCw } from "lucide-react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { cpp } from "@codemirror/lang-cpp";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { rust } from "@codemirror/lang-rust";
import { java } from "@codemirror/lang-java";
import type { Extension } from "@codemirror/state";
import { useTheme } from "../../contexts/ThemeContext";
import { useLayout } from "../../contexts/LayoutContext";
import { themeClass } from "../../utils/theme";

/** Map file extension to CodeMirror language extension. */
function getLanguageExtension(filePath: string): Extension[] {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "ts":
    case "mts":
    case "cts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ jsx: true, typescript: true })];
    case "py":
    case "pyw":
      return [python()];
    case "json":
    case "jsonc":
      return [json()];
    case "c":
    case "h":
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
    case "hxx":
      return [cpp()];
    case "html":
    case "htm":
    case "svg":
    case "xml":
      return [html()];
    case "css":
    case "scss":
    case "less":
      return [css()];
    case "md":
    case "mdx":
      return [markdown()];
    case "rs":
      return [rust()];
    case "java":
      return [java()];
    default:
      return [];
  }
}

interface CodeEditorPaneProps {
  sessionId: string;
  filePath: string;
}

const CodeEditorPane: React.FC<CodeEditorPaneProps> = ({ sessionId, filePath }) => {
  const { resolvedTheme } = useTheme();
  const { closePane } = useLayout();
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFlash, setSaveFlash] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const isModified = content !== savedContent;
  const isLight = resolvedTheme === "light";
  const t = themeClass;

  // Load file
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const result = await window.electron?.ipcRenderer?.invoke("file.readFile", { filePath });
        if (cancelled) return;
        if (result?.success) {
          setContent(result.content);
          setSavedContent(result.content);
        } else {
          setError(result?.error || "Failed to read file");
        }
      } catch (err: any) {
        if (!cancelled) setError(err.message || "Failed to read file");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [filePath]);

  // Save file
  const handleSave = useCallback(async () => {
    if (!isModified || saving) return;
    setSaving(true);
    try {
      const result = await window.electron?.ipcRenderer?.invoke("file.writeFile", { filePath, content });
      if (result?.success) {
        setSavedContent(content);
        setSaveFlash(true);
        setTimeout(() => setSaveFlash(false), 1000);
      } else {
        setError(result?.error || "Failed to save file");
      }
    } catch (err: any) {
      setError(err.message || "Failed to save file");
    } finally {
      setSaving(false);
    }
  }, [filePath, content, isModified, saving]);

  // Cmd/Ctrl+S keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        // Only handle if this editor pane is focused
        if (containerRef.current?.contains(document.activeElement)) {
          e.preventDefault();
          handleSave();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleSave]);

  const langExtensions = getLanguageExtension(filePath);

  return (
    <div ref={containerRef} className="flex flex-col h-full w-full">
      {/* Header bar */}
      <div
        className={`flex items-center gap-1.5 px-2 py-1.5 border-b shrink-0 ${t(
          resolvedTheme,
          {
            dark: "bg-[#0a0a0a] border-white/5",
            modern: "bg-[#040414] border-white/6",
            light: "bg-gray-50 border-gray-200",
          },
        )}`}
      >
        <FileCode className={`h-3.5 w-3.5 shrink-0 ${isLight ? "text-blue-500" : "text-blue-400"}`} />

        {/* File path display */}
        <div className={`flex-1 flex items-center gap-1.5 px-2 py-0.5 rounded text-[11px] font-mono truncate min-w-0 ${t(
          resolvedTheme,
          {
            dark: "text-gray-300",
            modern: "text-gray-300",
            light: "text-gray-700",
          },
        )}`}>
          <span className="truncate" title={filePath}>{filePath}</span>
          {isModified && (
            <span className={`shrink-0 w-2 h-2 rounded-full ${isLight ? "bg-orange-400" : "bg-orange-500"}`} title="Unsaved changes" />
          )}
          {saveFlash && (
            <span className={`shrink-0 text-[9px] font-medium ${isLight ? "text-green-600" : "text-green-400"}`}>Saved</span>
          )}
        </div>

        {/* Save button */}
        <button
          onClick={handleSave}
          disabled={!isModified || saving}
          className={`p-1 rounded transition-colors ${
            isModified
              ? isLight ? "hover:bg-blue-100 text-blue-600" : "hover:bg-blue-500/20 text-blue-400"
              : isLight ? "text-gray-300 cursor-default" : "text-gray-600 cursor-default"
          }`}
          title={`Save (${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+S)`}
        >
          {saving ? <RotateCw className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        </button>

        {/* Open externally */}
        <button
          onClick={() => {
            if (window.electron?.ipcRenderer?.invoke) {
              window.electron.ipcRenderer.invoke("shell.openPath", filePath)?.catch(() => {});
            }
          }}
          className={`p-1 rounded ${isLight ? "hover:bg-gray-200 text-gray-600" : "hover:bg-white/10 text-gray-400"}`}
          title="Open in system editor"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>

        {/* Close */}
        <button
          onClick={() => closePane(sessionId)}
          className={`p-1 rounded ${isLight ? "hover:bg-gray-200 text-gray-600" : "hover:bg-white/10 text-gray-400"}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Editor body — absolute positioning gives CodeMirror a concrete pixel height */}
      <div className="flex-1 relative min-h-0">
        {loading && (
          <div className={`absolute inset-0 z-10 flex items-center justify-center ${isLight ? "bg-gray-50" : "bg-[#0a0a0a]"}`}>
            <RotateCw className={`h-5 w-5 animate-spin ${isLight ? "text-gray-400" : "text-gray-500"}`} />
          </div>
        )}
        {error && !loading && (
          <div className={`absolute inset-0 z-10 flex items-center justify-center p-8 ${isLight ? "bg-gray-50" : "bg-[#0a0a0a]"}`}>
            <div className={`text-center max-w-md ${isLight ? "text-gray-500" : "text-gray-400"}`}>
              <FileCode className="h-8 w-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm">{error}</p>
            </div>
          </div>
        )}
        {!loading && !error && (
          <div className="absolute inset-0">
            <CodeMirror
              value={content}
              onChange={setContent}
              extensions={langExtensions}
              theme={isLight ? "light" : "dark"}
              height="100%"
              basicSetup={{
                lineNumbers: true,
                highlightActiveLineGutter: true,
                highlightActiveLine: true,
                foldGutter: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: false,
                indentOnInput: true,
                syntaxHighlighting: true,
                searchKeymap: true,
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default CodeEditorPane;
