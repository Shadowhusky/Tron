import { memo } from "react";
import { motion } from "framer-motion";
import { useTheme } from "../../../contexts/ThemeContext";
import { themeClass } from "../../../utils/theme";
import { collapse } from "../../../utils/motion";
import { IPC } from "../../../constants/ipc";

interface TuiKeyToolbarProps {
  sessionId: string;
}

const KEYS = [
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  "divider",
  { label: "\u2190", data: "\x1b[D" },
  { label: "\u2193", data: "\x1b[B" },
  { label: "\u2191", data: "\x1b[A" },
  { label: "\u2192", data: "\x1b[C" },
  "divider",
  { label: "^C", data: "\x03" },
  { label: "Clear", data: null },
  { label: "Enter", data: "\r", accent: true },
] as const;

const TuiKeyToolbar: React.FC<TuiKeyToolbarProps> = memo(({ sessionId }) => {
  const { resolvedTheme } = useTheme();

  const send = (data: string) => {
    window.electron?.ipcRenderer?.send(IPC.TERMINAL_WRITE, { id: sessionId, data });
  };

  const handleKey = (key: (typeof KEYS)[number]) => {
    if (key === "divider") return;
    if (key.data === null) {
      window.dispatchEvent(
        new CustomEvent("tron:clearTerminal", { detail: { sessionId } }),
      );
    } else {
      send(key.data);
    }
  };

  const btnBase = "h-7 min-w-[2rem] px-1.5 rounded text-[11px] font-medium select-none active:scale-95 transition-all duration-75";
  const btnClass = themeClass(resolvedTheme, {
    dark: "text-gray-400 active:bg-white/10 active:text-gray-200",
    modern: "text-gray-400 active:bg-white/8 active:text-gray-200",
    light: "text-gray-500 active:bg-gray-200 active:text-gray-800",
  });
  const accentClass = themeClass(resolvedTheme, {
    dark: "text-purple-400 active:bg-purple-500/20 active:text-purple-300",
    modern: "text-purple-400 active:bg-purple-500/15 active:text-purple-300",
    light: "text-purple-600 active:bg-purple-100 active:text-purple-700",
  });
  const dividerClass = themeClass(resolvedTheme, {
    dark: "bg-white/6",
    modern: "bg-white/5",
    light: "bg-gray-200",
  });

  return (
    <motion.div
      variants={collapse}
      initial="hidden"
      animate="visible"
      exit="exit"
      className={`shrink-0 flex items-center justify-center gap-1 px-2 h-8 ${themeClass(resolvedTheme, {
        dark: "bg-[#0a0a0a]",
        modern: "bg-transparent",
        light: "bg-gray-50",
      })}`}
    >
      {KEYS.map((key, i) =>
        key === "divider" ? (
          <div key={i} className={`w-px h-3.5 mx-0.5 ${dividerClass}`} />
        ) : (
          <button
            key={key.label}
            onPointerDown={(e) => {
              e.preventDefault();
              handleKey(key);
            }}
            className={`${btnBase} ${"accent" in key ? accentClass : btnClass}`}
          >
            {key.label}
          </button>
        ),
      )}
    </motion.div>
  );
});

TuiKeyToolbar.displayName = "TuiKeyToolbar";
export default TuiKeyToolbar;
