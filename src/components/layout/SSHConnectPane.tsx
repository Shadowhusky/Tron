import { useState, useRef, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useTheme } from "../../contexts/ThemeContext";
import { themeClass } from "../../utils/theme";
import SSHConnectModal from "../../features/ssh/components/SSHConnectModal";
import { useLayout } from "../../contexts/LayoutContext";

const SSHConnectPane: React.FC = () => {
  const { resolvedTheme } = useTheme();
  const { createSSHTab } = useLayout();
  const [showModal, setShowModal] = useState(false);
  const [toast, setToast] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const showToast = useCallback(() => {
    setToast(true);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(false), 2500);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      showToast();
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="w-full h-full flex flex-col">
      {/* Terminal area */}
      <div className={`flex-1 min-h-0 flex items-center justify-center ${themeClass(resolvedTheme, {
        dark: "bg-[#0d0d0d]",
        modern: "bg-[#08081a]",
        light: "bg-white",
      })}`}>
        <div className="flex flex-col items-center gap-4">
          <p className={`text-sm ${themeClass(resolvedTheme, {
            dark: "text-gray-600",
            modern: "text-gray-500",
            light: "text-gray-400",
          })}`}>
            No active session
          </p>
          <button
            onClick={() => setShowModal(true)}
            className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer ${themeClass(resolvedTheme, {
              dark: "bg-purple-600/80 hover:bg-purple-600 text-white",
              modern: "bg-purple-500/70 hover:bg-purple-500 text-white",
              light: "bg-purple-600 hover:bg-purple-500 text-white",
            })}`}
          >
            New Connection
          </button>
        </div>

        {/* Toast */}
        <AnimatePresence>
          {toast && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              className={`absolute top-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-xs font-medium shadow-lg ${themeClass(resolvedTheme, {
                dark: "bg-yellow-500/90 text-black",
                modern: "bg-yellow-500/90 text-black",
                light: "bg-yellow-500 text-black",
              })}`}
            >
              Connect to a server first
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Input bar — matches SmartInput visuals */}
      <div className={`shrink-0 p-2 border-t relative z-20 ${themeClass(resolvedTheme, {
        dark: "bg-[#0a0a0a] border-white/5",
        modern: "bg-[#060618] border-white/6",
        light: "bg-gray-50 border-gray-200",
      })}`}>
        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${themeClass(resolvedTheme, {
          dark: "bg-white/[0.03] border-white/[0.06]",
          modern: "bg-white/[0.02] border-white/[0.05]",
          light: "bg-white border-gray-200",
        })}`}>
          <span className={`text-xs select-none ${themeClass(resolvedTheme, {
            dark: "text-gray-600",
            modern: "text-gray-600",
            light: "text-gray-400",
          })}`}>$</span>
          <textarea
            ref={inputRef}
            rows={1}
            onKeyDown={handleKeyDown}
            className={`w-full bg-transparent font-mono text-sm outline-none resize-none overflow-hidden ${themeClass(resolvedTheme, {
              dark: "text-gray-100 placeholder-gray-500",
              modern: "text-gray-100 placeholder-gray-500",
              light: "text-gray-900 placeholder-gray-400",
            })}`}
            style={{ minHeight: "1.5em", maxHeight: "8em" }}
            placeholder="Type a command or ask a question..."
          />
        </div>
      </div>

      {/* Footer bar — matches ContextBar visuals */}
      <div className={`shrink-0 w-full h-8 border-t flex items-center px-3 ${themeClass(resolvedTheme, {
        dark: "bg-[#0a0a0a] border-white/5 text-gray-600",
        modern: "bg-[#060618] border-white/[0.06] text-gray-500",
        light: "bg-gray-50 border-gray-200 text-gray-400",
      })}`}>
        <span className="text-[10px]">Not connected</span>
      </div>

      <SSHConnectModal
        show={showModal}
        resolvedTheme={resolvedTheme}
        onConnect={async (config) => {
          await createSSHTab(config);
          setShowModal(false);
        }}
        onClose={() => setShowModal(false)}
      />
    </div>
  );
};

export default SSHConnectPane;
