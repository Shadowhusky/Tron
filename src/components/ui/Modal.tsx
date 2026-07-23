import { createPortal } from "react-dom";
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
  /** Vertical alignment. "center" (default) vertically centers the panel.
   *  "top" anchors it a fixed distance from the top — use this for modals
   *  whose body height changes (e.g. a file browser navigating dirs) so the
   *  panel doesn't jump around as content grows/shrinks. */
  align?: "center" | "top";
}

const panelTheme = (t: ResolvedTheme) =>
  t === "light"
    ? "bg-gray-100 text-gray-900 border border-black/[0.08]"
    : t === "modern"
      ? "bg-[#0e0e14] text-gray-200 border border-white/[0.12]"
      : "bg-[#0e0e0e] text-gray-200 border border-white/10";

const btnStyle = (t: ResolvedTheme, type: ModalButtonType) => {
  const base =
    "flex-1 px-3 py-3 text-[13px] font-medium transition-colors whitespace-nowrap";
  switch (type) {
    case "primary":
      return `${base} ${
        t === "light"
          ? "bg-white text-gray-900 hover:bg-gray-50"
          : "bg-white/[0.06] text-gray-200 hover:bg-white/[0.1]"
      }`;
    case "danger":
      return `${base} ${
        t === "light"
          ? "text-red-600 hover:bg-red-50"
          : "text-red-400 hover:bg-red-500/10"
      }`;
    case "ghost":
      return `${base} ${
        t === "light"
          ? "text-gray-400 hover:text-gray-600 hover:bg-black/[0.03]"
          : "text-gray-500 hover:text-gray-300 hover:bg-white/[0.03]"
      }`;
    default:
      return `${base} ${
        t === "light"
          ? "text-gray-600 hover:bg-white/60"
          : "text-gray-400 hover:bg-white/[0.04]"
      }`;
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
  align = "center",
}) => {
  const divider = dividerCls(resolvedTheme);

  // Portal to document.body to escape stacking contexts (e.g. split panes)
  return createPortal(
    <AnimatePresence>
      {show && (
        <motion.div
          variants={overlay}
          initial="hidden"
          animate="visible"
          exit="exit"
          className={`fixed inset-0 ${zIndex} flex justify-center bg-black/60 ${
            align === "top" ? "items-start pt-[10vh]" : "items-center"
          }`}
          onMouseDown={(e) => {
            // Only dismiss on direct backdrop clicks — not clicks that propagated
            // from the trigger button through the portal (click-through bug)
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            data-testid={testId}
            initial={{ opacity: 0, y: 6 }}
            animate={{
              opacity: 1,
              y: 0,
              transition: { type: "spring", bounce: 0, duration: 0.3 },
            }}
            exit={{ opacity: 0, y: 6, transition: { duration: 0.1, ease: "easeIn" } }}
            onMouseDown={(e) => e.stopPropagation()}
            className={`w-full ${maxWidth} mx-4 overflow-hidden rounded-xl shadow-xl ${panelTheme(resolvedTheme)}`}
          >
            {/* Header */}
            <div className="px-4 py-4 gap-2 flex flex-col">
              <h3 className="text-[15px] flex font-medium tracking-tight">{title}</h3>
              {description && (
                <p className="text-[13px] text-gray-500">{description}</p>
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
                    className={`${btnStyle(resolvedTheme, btn.type ?? "default")} ${
                      i < buttons.length - 1 ? `border-r ${divider}` : ""
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
    </AnimatePresence>,
    document.body,
  );
};

export default Modal;
