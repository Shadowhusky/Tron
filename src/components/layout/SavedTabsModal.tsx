import { useState, useEffect } from "react";
import Modal from "../ui/Modal";
import type { ResolvedTheme } from "../../contexts/ThemeContext";
import type { SavedTab } from "../../types";

interface SavedTabsModalProps {
  show: boolean;
  resolvedTheme: ResolvedTheme;
  onLoad: (saved: SavedTab) => void;
  onClose: () => void;
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

const SavedTabsModal: React.FC<SavedTabsModalProps> = ({ show, resolvedTheme, onLoad, onClose }) => {
  const [savedTabs, setSavedTabs] = useState<SavedTab[]>([]);
  const [loading, setLoading] = useState(true);
  const isLight = resolvedTheme === "light";
  const borderCls = isLight ? "border-black/[0.08]" : "border-white/[0.06]";

  useEffect(() => {
    if (!show) return;
    setLoading(true);
    const ipc = window.electron?.ipcRenderer;
    const readFn = (ipc as any)?.readSavedTabs || (() => ipc?.invoke("savedTabs.read"));
    readFn().then((tabs: SavedTab[]) => {
      setSavedTabs(tabs || []);
      setLoading(false);
    }).catch(() => {
      setSavedTabs([]);
      setLoading(false);
    });
  }, [show]);

  const handleDelete = async (id: string) => {
    const updated = savedTabs.filter(t => t.id !== id);
    setSavedTabs(updated);
    const ipc = window.electron?.ipcRenderer;
    const writeFn = (ipc as any)?.writeSavedTabs || ((d: any) => ipc?.invoke("savedTabs.write", d));
    await writeFn(updated);
  };

  const sessionCount = (tab: SavedTab) => Object.keys(tab.sessions).length;
  const hasAgent = (tab: SavedTab) => Object.values(tab.agentState).some(s => s.agentThread.length > 0);

  return (
    <Modal
      show={show}
      resolvedTheme={resolvedTheme}
      onClose={onClose}
      title="Saved Tabs"
      maxWidth="max-w-md"
      buttons={[{ label: "Close", type: "ghost", onClick: onClose }]}
    >
      <div className="max-h-[50vh] overflow-y-auto">
        {loading ? (
          <div className={`px-4 py-6 text-center text-xs ${isLight ? "text-gray-400" : "text-gray-600"}`}>
            Loading...
          </div>
        ) : savedTabs.length === 0 ? (
          <div className={`px-4 py-6 text-center text-xs ${isLight ? "text-gray-400" : "text-gray-600"}`}>
            No saved tabs. Right-click a tab to save one.
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
                <div className={`text-xs font-medium truncate ${isLight ? "text-gray-800" : "text-gray-200"}`}>
                  {tab.name}
                </div>
                <div className={`text-[10px] flex items-center gap-1.5 ${isLight ? "text-gray-400" : "text-gray-600"}`}>
                  <span>{timeAgo(tab.savedAt)}</span>
                  <span>{sessionCount(tab)}s</span>
                  {hasAgent(tab) && <span className="text-purple-400/60">agent</span>}
                </div>
              </div>
              <button
                onClick={() => onLoad(tab)}
                className={`px-2 py-1 text-[11px] font-medium transition-colors ${isLight
                  ? "bg-white text-gray-900 hover:bg-gray-50 border border-black/[0.08]"
                  : "bg-white/[0.06] text-gray-200 hover:bg-white/[0.1] border border-white/[0.06]"
                }`}
              >
                Load
              </button>
              <button
                onClick={() => handleDelete(tab.id)}
                className={`p-1 transition-colors ${isLight ? "text-gray-400 hover:text-red-500" : "text-gray-600 hover:text-red-400"}`}
                title="Delete"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
};

export default SavedTabsModal;
