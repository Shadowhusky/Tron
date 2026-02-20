import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { fadeScale, overlay } from "../../utils/motion";

interface CloseConfirmModalProps {
    show: boolean;
    resolvedTheme: "light" | "dark" | "modern";
    onAction: (action: "save" | "discard" | "cancel") => void;
}

const CloseConfirmModal: React.FC<CloseConfirmModalProps> = ({ show, resolvedTheme, onAction }) => {
    return (
        <AnimatePresence>
            {show && (
                <motion.div
                    key="close-confirm"
                    variants={overlay}
                    initial="hidden"
                    animate="visible"
                    exit="exit"
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70"
                    onClick={() => onAction("cancel")}
                >
                    <motion.div
                        variants={fadeScale}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        onClick={(e) => e.stopPropagation()}
                        className={`w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden
              ${resolvedTheme === "light" ? "bg-white text-gray-900 border border-gray-200" : ""}
              ${resolvedTheme === "dark" ? "bg-gray-900 text-white border border-white/10" : ""}
              ${resolvedTheme === "modern" ? "bg-[#111] text-white border border-white/10 shadow-[0_0_50px_rgba(0,0,0,0.5)]" : ""}
            `}
                    >
                        <div className="px-6 pt-3 pb-4 space-y-2">
                            <h3 className="text-lg font-semibold">Close Tron?</h3>
                            <p
                                className={`text-sm ${resolvedTheme === "light" ? "text-gray-500" : "text-gray-400"}`}
                            >
                                You have active terminal sessions. What would you like to do?
                            </p>
                        </div>
                        <div className={`px-6 pb-6 flex flex-row gap-3`}>
                            <motion.button
                                whileHover={{ scale: 1.01 }}
                                whileTap={{ scale: 0.98 }}
                                onClick={() => onAction("save")}
                                className="flex-1 px-3 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-sm font-medium transition-colors shadow-lg shadow-purple-900/20 whitespace-nowrap"
                            >
                                Exit & Save Session
                            </motion.button>
                            <motion.button
                                whileHover={{ scale: 1.01 }}
                                whileTap={{ scale: 0.98 }}
                                onClick={() => onAction("discard")}
                                className={`flex-1 px-3 py-2 rounded-xl text-sm font-medium transition-colors border whitespace-nowrap ${resolvedTheme === "light"
                                    ? "border-gray-200 hover:bg-gray-50 text-gray-700"
                                    : "border-white/10 hover:bg-white/5 text-gray-300"
                                    }`}
                            >
                                Exit Without Saving
                            </motion.button>
                            <motion.button
                                whileHover={{ scale: 1.01 }}
                                whileTap={{ scale: 0.98 }}
                                onClick={() => onAction("cancel")}
                                className={`flex-1 py-2 rounded-xl text-sm font-medium transition-colors whitespace-nowrap ${resolvedTheme === "light"
                                    ? "hover:bg-gray-100 text-gray-500"
                                    : "hover:bg-white/5 text-gray-500"
                                    }`}
                            >
                                Cancel
                            </motion.button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default CloseConfirmModal;
