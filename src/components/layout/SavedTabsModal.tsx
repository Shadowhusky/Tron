import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { fadeScale, overlay } from "../../utils/motion";
import { themeClass } from "../../utils/theme";
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
    <AnimatePresence>
      {show && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center"
          variants={overlay}
          initial="hidden"
          animate="visible"
          exit="exit"
          onClick={onClose}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <motion.div
            variants={fadeScale}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={(e) => e.stopPropagation()}
            className={`relative w-full max-w-md mx-4 rounded-lg shadow-2xl overflow-hidden ${themeClass(
              resolvedTheme,
              {
                dark: "bg-[#141414] border border-white/[0.06]",
                modern: "bg-[#12121a]/95 backdrop-blur-2xl border border-white/[0.08]",
                light: "bg-white border border-gray-200",
              },
            )}`}
          >
            {/* Header */}
            <div className={`flex items-center justify-between px-4 py-3 border-b ${themeClass(
              resolvedTheme,
              { dark: "border-white/5", modern: "border-white/8", light: "border-gray-100" },
            )}`}>
              <h2 className={`text-sm font-semibold ${themeClass(resolvedTheme, {
                dark: "text-gray-200", modern: "text-gray-200", light: "text-gray-800",
              })}`}>
                Saved Tabs
              </h2>
              <button
                onClick={onClose}
                className={`p-1 rounded transition-colors ${themeClass(resolvedTheme, {
                  dark: "hover:bg-white/10 text-gray-500", modern: "hover:bg-white/10 text-gray-500", light: "hover:bg-gray-100 text-gray-400",
                })}`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="max-h-[60vh] overflow-y-auto">
              {loading ? (
                <div className={`px-4 py-8 text-center text-[13px] ${themeClass(resolvedTheme, {
                  dark: "text-gray-500", modern: "text-gray-500", light: "text-gray-400",
                })}`}>
                  Loading...
                </div>
              ) : savedTabs.length === 0 ? (
                <div className={`px-4 py-8 text-center text-[13px] ${themeClass(resolvedTheme, {
                  dark: "text-gray-500", modern: "text-gray-500", light: "text-gray-400",
                })}`}>
                  No saved tabs yet. Right-click a tab and select "Save Tab" to save one.
                </div>
              ) : (
                <div className="py-1">
                  {savedTabs.map((tab) => (
                    <div
                      key={tab.id}
                      className={`flex items-center gap-3 px-4 py-2.5 transition-colors ${themeClass(
                        resolvedTheme,
                        { dark: "hover:bg-white/[0.03]", modern: "hover:bg-white/[0.03]", light: "hover:bg-gray-50" },
                      )}`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className={`text-[13px] font-medium truncate ${themeClass(resolvedTheme, {
                          dark: "text-gray-200", modern: "text-gray-200", light: "text-gray-800",
                        })}`}>
                          {tab.name}
                        </div>
                        <div className={`text-[11px] flex items-center gap-2 ${themeClass(resolvedTheme, {
                          dark: "text-gray-500", modern: "text-gray-500", light: "text-gray-400",
                        })}`}>
                          <span>{timeAgo(tab.savedAt)}</span>
                          <span>{sessionCount(tab)} session{sessionCount(tab) !== 1 ? "s" : ""}</span>
                          {hasAgent(tab) && <span className="text-purple-400/70">agent</span>}
                        </div>
                      </div>
                      <button
                        onClick={() => onLoad(tab)}
                        className={`px-2.5 py-1 rounded text-[11px] font-medium transition-colors ${themeClass(
                          resolvedTheme,
                          {
                            dark: "bg-white/[0.06] hover:bg-white/[0.12] text-gray-300",
                            modern: "bg-purple-500/10 hover:bg-purple-500/20 text-purple-300",
                            light: "bg-gray-100 hover:bg-gray-200 text-gray-700",
                          },
                        )}`}
                      >
                        Load
                      </button>
                      <button
                        onClick={() => handleDelete(tab.id)}
                        className={`p-1.5 rounded transition-colors ${themeClass(resolvedTheme, {
                          dark: "hover:bg-white/10 text-gray-600 hover:text-red-400",
                          modern: "hover:bg-white/10 text-gray-600 hover:text-red-400",
                          light: "hover:bg-gray-100 text-gray-400 hover:text-red-500",
                        })}`}
                        title="Delete saved tab"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default SavedTabsModal;
