import { useState, useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Modal from "../ui/Modal";
import type { ResolvedTheme } from "../../contexts/ThemeContext";
import type { SyncTab } from "../../types";

interface SavedTabsModalProps {
  show: boolean;
  resolvedTheme: ResolvedTheme;
  onLoad: (saved: SyncTab) => void;
  onClose: () => void;
}

function timeAgo(ts: number, now: number): string {
  const diff = now - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  // Older than a week — show specific date and time
  const d = new Date(ts);
  const month = d.toLocaleString(undefined, { month: "short" });
  const day = d.getDate();
  const year = d.getFullYear();
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const currentYear = new Date(now).getFullYear();
  return year === currentYear ? `${month} ${day}, ${time}` : `${month} ${day}, ${year} ${time}`;
}

const SavedTabsModal: React.FC<SavedTabsModalProps> = ({
  show,
  resolvedTheme,
  onLoad,
  onClose,
}) => {
  const [savedTabs, setSavedTabs] = useState<SyncTab[]>([]);
  const [loading, setLoading] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [toast, setToast] = useState("");
  // Snapshot time once when the modal opens so timestamps don't shift on re-renders
  const [openedAt, setOpenedAt] = useState(Date.now);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const isLight = resolvedTheme === "light";
  const borderCls = isLight ? "border-black/[0.08]" : "border-white/[0.06]";

  useEffect(() => {
    if (!show) return;
    setOpenedAt(Date.now());
    setLoading(true);
    setRenamingId(null);
    setDeleteConfirmId(null);
    const ipc = window.electron?.ipcRenderer;
    const readFn =
      (ipc as any)?.readSyncTabs || (() => ipc?.invoke("savedTabs.read"));
    readFn()
      .then((tabs: SyncTab[]) => {
        setSavedTabs(tabs || []);
        setLoading(false);
      })
      .catch(() => {
        setSavedTabs([]);
        setLoading(false);
      });
  }, [show]);

  // Auto-focus rename input when entering rename mode
  useEffect(() => {
    if (renamingId) {
      setTimeout(() => renameInputRef.current?.focus(), 0);
    }
  }, [renamingId]);

  const handleDelete = async (id: string) => {
    const updated = savedTabs.filter((t) => t.id !== id);
    setSavedTabs(updated);
    const ipc = window.electron?.ipcRenderer;
    const writeFn =
      (ipc as any)?.writeSyncTabs ||
      ((d: any) => ipc?.invoke("savedTabs.write", d));
    await writeFn(updated);
  };

  const startRename = (tab: SyncTab) => {
    setRenamingId(tab.id);
    setRenameValue(tab.name);
  };

  const commitRename = async () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    const updated = savedTabs.map((t) =>
      t.id === renamingId ? { ...t, name: renameValue.trim() } : t,
    );
    setSavedTabs(updated);
    setRenamingId(null);
    const ipc = window.electron?.ipcRenderer;
    const writeFn =
      (ipc as any)?.writeSyncTabs ||
      ((d: any) => ipc?.invoke("savedTabs.write", d));
    try {
      await writeFn(updated);
      setToast("Renamed");
    } catch {
      setToast("Rename failed");
    }
    setTimeout(() => setToast(""), 2000);
  };

  const sessionCount = (tab: SyncTab) => Object.keys(tab.sessions).length;
  const hasAgent = (tab: SyncTab) =>
    Object.values(tab.agentState).some((s) => s.agentThread.length > 0);

  return (
    <>
      <Modal
        show={show}
        resolvedTheme={resolvedTheme}
        onClose={onClose}
        title="Saved Tabs"
        maxWidth="max-w-md"
        buttons={[{ label: "Close", type: "ghost", onClick: onClose }]}
        testId="saved-tabs-modal"
      >
        <div className="max-h-[50vh] overflow-y-auto pb-2">
          {loading ? (
            <div
              className={`px-4 py-6 text-center text-xs ${isLight ? "text-gray-400" : "text-gray-600"}`}
            >
              Loading...
            </div>
          ) : savedTabs.length === 0 ? (
            <div
              className={`px-4 py-6 text-center text-xs ${isLight ? "text-gray-400" : "text-gray-600"}`}
            >
              No saved tabs. Right-click a tab and choose "Save to Remote".
            </div>
          ) : (
            savedTabs.map((tab, i) => (
              <div
                key={tab.id}
                className={`flex items-center gap-3 px-4 py-2 transition-colors ${i > 0 ? `border-t ${borderCls}` : ""} ${
                  isLight ? "hover:bg-white/60" : "hover:bg-white/[0.02]"
                }`}
              >
                <div className="flex-1 min-w-0">
                  {renamingId === tab.id ? (
                    <input
                      ref={renameInputRef}
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      className={`w-full text-xs font-medium bg-transparent outline-none border-b ${
                        isLight
                          ? "border-gray-300 text-gray-800"
                          : "border-white/20 text-gray-200"
                      }`}
                    />
                  ) : (
                    <div
                      className={`text-xs font-medium truncate ${isLight ? "text-gray-800" : "text-gray-200"}`}
                    >
                      {tab.name}
                    </div>
                  )}
                  <div
                    className={`text-[10px] flex items-center gap-1.5 ${isLight ? "text-gray-400" : "text-gray-600"}`}
                  >
                    <span>{timeAgo(tab.savedAt, openedAt)}</span>
                    <span>·</span>
                    <span>{sessionCount(tab)} pane{sessionCount(tab) === 1 ? "" : "s"}</span>
                    {hasAgent(tab) && (
                      <span className="text-purple-400/60">agent</span>
                    )}
                  </div>
                </div>
                {renamingId === tab.id ? (
                  <button
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={commitRename}
                    className={`px-2 py-1 text-[11px] font-medium transition-colors ${
                      isLight
                        ? "bg-white text-gray-900 hover:bg-gray-50 border border-black/[0.08]"
                        : "bg-white/[0.06] text-gray-200 hover:bg-white/[0.1] border border-white/[0.06]"
                    }`}
                  >
                    Confirm
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => startRename(tab)}
                      className={`px-2 py-1 text-[11px] font-medium transition-colors ${
                        isLight
                          ? "text-gray-500 hover:text-gray-700"
                          : "text-gray-500 hover:text-gray-300"
                      }`}
                    >
                      Rename
                    </button>
                    <button
                      data-testid={`saved-tab-load-${tab.id}`}
                      onClick={() => onLoad(tab)}
                      className={`px-2 py-1 text-[11px] font-medium transition-colors ${
                        isLight
                          ? "bg-white text-gray-900 hover:bg-gray-50 border border-black/[0.08]"
                          : "bg-white/[0.06] text-gray-200 hover:bg-white/[0.1] border border-white/[0.06]"
                      }`}
                    >
                      Load
                    </button>
                  </>
                )}
                <button
                  onClick={() => setDeleteConfirmId(tab.id)}
                  className={`p-1 transition-colors ${isLight ? "text-gray-400 hover:text-red-500" : "text-gray-600 hover:text-red-400"}`}
                  title="Delete"
                >
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            ))
          )}
        </div>
      </Modal>

      <Modal
        show={!!deleteConfirmId}
        resolvedTheme={resolvedTheme}
        onClose={() => setDeleteConfirmId(null)}
        title="Delete saved tab?"
        description={`"${savedTabs.find((t) => t.id === deleteConfirmId)?.name ?? ""}" will be permanently removed.`}
        zIndex="z-[60]"
        buttons={[
          {
            label: "Cancel",
            type: "ghost",
            onClick: () => setDeleteConfirmId(null),
          },
          {
            label: "Delete",
            type: "danger",
            onClick: () => {
              if (deleteConfirmId) handleDelete(deleteConfirmId);
              setDeleteConfirmId(null);
            },
          },
        ]}
      />

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className={`fixed bottom-14 left-1/2 -translate-x-1/2 z-[70] px-4 py-2 text-xs font-medium shadow-lg ${
              isLight
                ? "bg-white/95 text-gray-700 border border-gray-200"
                : "bg-gray-800/95 text-gray-200 border border-gray-600"
            }`}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default SavedTabsModal;
