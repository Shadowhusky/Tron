import { useState, useEffect, useRef, useCallback } from "react";
import { Folder, File, ChevronRight, Loader2 } from "lucide-react";
import Modal from "./Modal";
import type { ResolvedTheme } from "../../contexts/ThemeContext";
import { themeClass } from "../../utils/theme";

interface FolderPickerModalProps {
  show: boolean;
  resolvedTheme: ResolvedTheme;
  initialPath?: string;
  mode?: "directory" | "file";
  onSelect: (path: string) => void;
  onClose: () => void;
}

interface DirEntry {
  name: string;
  isDirectory: boolean;
}

/** Resolve `~` prefix to actual home directory. */
async function resolveHome(p: string): Promise<string> {
  if (!p.startsWith("~")) return p;
  try {
    const paths = await window.electron?.ipcRenderer?.invoke("config.getSystemPaths");
    const home = paths?.home || paths?.homedir;
    if (home) return p.replace(/^~/, home);
  } catch { /* fall through */ }
  return p;
}

/** Join path segments, handling trailing slashes. */
function joinPath(base: string, child: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  const trimmed = base.endsWith(sep) ? base.slice(0, -1) : base;
  return `${trimmed}${sep}${child}`;
}

/** Check if path is a filesystem root. */
function isRootPath(p: string): boolean {
  return p === "/" || /^[A-Za-z]:\\?$/.test(p);
}

/** Go up one directory level. */
function parentPath(p: string): string {
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = p.split(sep).filter(Boolean);
  if (parts.length <= 1) {
    // Root — on Unix return "/", on Windows return the drive root
    return p.includes("\\") ? parts[0] + "\\" : "/";
  }
  const parent = parts.slice(0, -1).join(sep);
  // Preserve leading slash on Unix
  return p.startsWith(sep) ? sep + parent : parent;
}

const FolderPickerModal: React.FC<FolderPickerModalProps> = ({
  show,
  resolvedTheme,
  initialPath,
  mode = "directory",
  onSelect,
  onClose,
}) => {
  const [currentPath, setCurrentPath] = useState(initialPath || "/");
  const [inputPath, setInputPath] = useState(initialPath || "/");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const fetchDir = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    setSelectedFile(null);
    try {
      const resolved = await resolveHome(dirPath);
      const result = await window.electron?.ipcRenderer?.invoke("file.listDir", { dirPath: resolved });
      if (result?.success && result.contents) {
        setEntries(result.contents);
        setCurrentPath(resolved);
        setInputPath(resolved);
      } else {
        setError(result?.error || "Failed to list directory");
      }
    } catch (e: any) {
      setError(e.message || "Failed to list directory");
    } finally {
      setLoading(false);
    }
  }, []);

  // Load initial directory when modal opens
  useEffect(() => {
    if (show) {
      const start = initialPath || "/";
      setInputPath(start);
      fetchDir(start);
    }
  }, [show, initialPath, fetchDir]);

  // Focus input when modal opens
  useEffect(() => {
    if (show) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [show]);

  const handleNavigate = (dirPath: string) => {
    fetchDir(dirPath);
    // Scroll list to top
    listRef.current?.scrollTo(0, 0);
  };

  const handleEntryClick = (entry: DirEntry) => {
    const fullPath = joinPath(currentPath, entry.name);
    if (entry.isDirectory) {
      handleNavigate(fullPath);
    } else if (mode === "file") {
      setSelectedFile(fullPath);
    }
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleNavigate(inputPath);
    }
  };

  const handleSelect = () => {
    if (mode === "file" && selectedFile) {
      onSelect(selectedFile);
    } else {
      onSelect(currentPath);
    }
    onClose();
  };

  const itemHover = themeClass(resolvedTheme, {
    dark: "hover:bg-white/[0.04]",
    modern: "hover:bg-white/[0.04]",
    light: "hover:bg-gray-50",
  });

  const itemSelected = themeClass(resolvedTheme, {
    dark: "bg-white/[0.06]",
    modern: "bg-purple-500/10",
    light: "bg-blue-50",
  });

  const divider = themeClass(resolvedTheme, {
    dark: "border-white/[0.06]",
    modern: "border-white/[0.06]",
    light: "border-gray-200",
  });

  return (
    <Modal
      show={show}
      resolvedTheme={resolvedTheme}
      onClose={onClose}
      title={mode === "file" ? "Select File" : "Select Folder"}
      maxWidth="max-w-md"
      zIndex="z-[200]"
      buttons={[
        { label: "Cancel", type: "ghost", onClick: onClose },
        {
          label: mode === "file" ? "Select File" : "Select Folder",
          type: "primary",
          onClick: handleSelect,
        },
      ]}
    >
      {/* Path input */}
      <div className={`px-4 pb-2 border-b ${divider}`}>
        <div className="flex items-center gap-1.5">
          <ChevronRight className="w-3 h-3 opacity-40 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={inputPath}
            onChange={(e) => setInputPath(e.target.value)}
            onKeyDown={handleInputKeyDown}
            className={`flex-1 text-xs py-1.5 px-2 rounded-md border outline-none transition-colors font-mono ${themeClass(
              resolvedTheme,
              {
                dark: "bg-white/[0.03] border-white/[0.08] text-gray-200 placeholder-gray-600 focus:border-white/20",
                modern: "bg-white/[0.03] border-white/[0.08] text-gray-200 placeholder-gray-600 focus:border-purple-400/40",
                light: "bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-gray-400",
              },
            )}`}
            placeholder="Type a path and press Enter"
          />
        </div>
      </div>

      {/* Directory listing */}
      <div
        ref={listRef}
        className="overflow-y-auto"
        style={{ maxHeight: "50vh" }}
      >
        {loading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-4 h-4 animate-spin opacity-50" />
          </div>
        )}

        {error && (
          <div className={`mx-4 my-3 px-3 py-2 rounded-md text-xs ${themeClass(resolvedTheme, {
            dark: "text-red-400 bg-red-500/10",
            modern: "text-red-400 bg-red-500/10",
            light: "text-red-600 bg-red-50",
          })}`}>
            {error}
          </div>
        )}

        {!loading && !error && (
          <div className="py-1">
            {/* Parent directory entry */}
            <button
              onClick={() => handleNavigate(parentPath(currentPath))}
              disabled={isRootPath(currentPath)}
              className={`w-full flex items-center gap-2 px-4 py-1.5 text-xs text-left transition-colors ${
                isRootPath(currentPath) ? "opacity-20 cursor-default" : itemHover
              }`}
            >
              <Folder className="w-3.5 h-3.5 opacity-50 shrink-0" />
              <span className="opacity-60">..</span>
            </button>

            {/* Directory and file entries */}
            {entries.map((entry) => {
              const fullPath = joinPath(currentPath, entry.name);
              const isSelected = selectedFile === fullPath;
              const isClickable = entry.isDirectory || mode === "file";

              return (
                <button
                  key={entry.name}
                  onClick={() => isClickable && handleEntryClick(entry)}
                  className={`w-full flex items-center gap-2 px-4 py-1.5 text-xs text-left transition-colors ${
                    isSelected ? itemSelected : isClickable ? itemHover : ""
                  } ${!isClickable ? "opacity-40 cursor-default" : ""}`}
                  disabled={!isClickable}
                >
                  {entry.isDirectory ? (
                    <Folder className="w-3.5 h-3.5 opacity-50 shrink-0 text-yellow-500/70" />
                  ) : (
                    <File className="w-3.5 h-3.5 opacity-30 shrink-0" />
                  )}
                  <span className="truncate">{entry.name}</span>
                </button>
              );
            })}

            {entries.length === 0 && (
              <div className="px-4 py-6 text-center text-xs opacity-40">
                Empty directory
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default FolderPickerModal;
