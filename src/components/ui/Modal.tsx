import { motion, AnimatePresence } from "framer-motion";
import { overlay } from "../../utils/motion";
import type { ResolvedTheme } from "../../contexts/ThemeContext";

export type ModalButtonType = "primary" | "default" | "ghost" | "danger";

export interface ModalButton {
  label: string;
  type?: ModalButtonType;
  onClick: () => void;
  testId?: string;
}

interface ModalProps {
  show: boolean;
  resolvedTheme: ResolvedTheme;
  onClose: () => void;
  /** Title text */
  title: string;
  /** Optional description below title */
  description?: string;
  /** Button row — rendered as flat tab-style segments */
  buttons: ModalButton[];
  /** Custom body between title and buttons (e.g. SavedTabsModal list) */
  children?: React.ReactNode;
  /** Max-width Tailwind class (default: "max-w-sm") */
  maxWidth?: string;
  testId?: string;
  /** z-index class (default: "z-50") */
  zIndex?: string;
}

const panelTheme = (t: ResolvedTheme) =>
  t === "light"
    ? "bg-gray-100 text-gray-900 border border-black/[0.08]"
    : t === "modern"
      ? "bg-[#0e0e14] text-gray-200 border border-white/[0.06]"
      : "bg-[#0e0e0e] text-gray-200 border border-white/[0.06]";

const btnStyle = (t: ResolvedTheme, type: ModalButtonType) => {
  const base = "flex-1 px-3 py-3 text-xs font-medium transition-colors whitespace-nowrap";
  switch (type) {
    case "primary":
      return `${base} ${t === "light"
        ? "bg-white text-gray-900 hover:bg-gray-50"
        : "bg-white/[0.06] text-gray-200 hover:bg-white/[0.1]"}`;
    case "danger":
      return `${base} ${t === "light"
        ? "text-red-600 hover:bg-red-50"
        : "text-red-400 hover:bg-red-500/10"}`;
    case "ghost":
      return `${base} ${t === "light"
        ? "text-gray-400 hover:text-gray-600 hover:bg-black/[0.03]"
        : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]"}`;
    default:
      return `${base} ${t === "light"
        ? "text-gray-600 hover:bg-white/60"
        : "text-gray-400 hover:bg-white/[0.04]"}`;
  }
};

const dividerCls = (t: ResolvedTheme) =>
  t === "light" ? "border-black/[0.08]" : "border-white/[0.06]";

const Modal: React.FC<ModalProps> = ({
  show,
  resolvedTheme,
  onClose,
  title,
  description,
  buttons,
  children,
  maxWidth = "max-w-sm",
  testId,
  zIndex = "z-50",
}) => {
  const divider = dividerCls(resolvedTheme);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          variants={overlay}
          initial="hidden"
          animate="visible"
          exit="exit"
          className={`fixed inset-0 ${zIndex} flex items-center justify-center bg-black/60`}
          onClick={onClose}
        >
          <motion.div
            data-testid={testId}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.15, ease: "easeOut" } }}
            exit={{ opacity: 0, y: 6, transition: { duration: 0.1 } }}
            onClick={(e) => e.stopPropagation()}
            className={`w-full ${maxWidth} mx-4 overflow-hidden ${panelTheme(resolvedTheme)}`}
          >
            {/* Header */}
            <div className="px-4 py-5">
              <h3 className="text-sm flex font-semibold">{title}</h3>
              {description && (
                <p className="text-sm mt-1 text-gray-500">{description}</p>
              )}
            </div>

            {/* Optional custom body */}
            {children}

            {/* Button row */}
            {buttons.length > 0 && (
              <div className={`flex border-t ${divider}`}>
                {buttons.map((btn, i) => (
                  <button
                    key={i}
                    data-testid={btn.testId}
                    onClick={btn.onClick}
                    className={`${btnStyle(resolvedTheme, btn.type ?? "default")} ${i < buttons.length - 1 ? `border-r ${divider}` : ""
                      }`}
                  >
                    {btn.label}
                  </button>
                ))}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default Modal;
