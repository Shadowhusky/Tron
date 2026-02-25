import React from "react";
import { motion } from "framer-motion";
import type { CrossTabNotification } from "../../contexts/AgentContext";
import type { LayoutNode, Tab } from "../../types";

interface NotificationOverlayProps {
    notifications: CrossTabNotification[];
    tabs: Tab[];
    resolvedTheme: "light" | "dark" | "modern";
    onSelectTab: (tabId: string) => void;
    onDismiss: (id: number) => void;
}

const NotificationOverlay: React.FC<NotificationOverlayProps> = ({
    notifications,
    tabs,
    resolvedTheme,
    onSelectTab,
    onDismiss
}) => {
    if (notifications.length === 0) return null;

    // Find session's tab for click-to-switch
    const findTabForSession = (sessionId: string): string | null => {
        for (const tab of tabs) {
            const check = (node: LayoutNode): boolean => {
                if (node.type === "leaf") return node.sessionId === sessionId;
                return node.children.some(check);
            };
            if (check(tab.root)) return tab.id;
        }
        return null;
    };

    return (
        <div className="absolute top-2 right-3 z-50 flex flex-col gap-2" style={{ maxWidth: 340 }}>
            {notifications.map((n) => {
                const targetTabId = findTabForSession(n.sessionId);
                const targetTab = targetTabId ? tabs.find(t => t.id === targetTabId) : null;
                return (
                    <motion.div
                        key={n.id}
                        initial={{ opacity: 0, x: 40 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 40 }}
                        className={`rounded-lg px-3 py-2 text-xs shadow-lg cursor-pointer border backdrop-blur-md ${resolvedTheme === "light"
                            ? "bg-white/90 border-gray-200 text-gray-700"
                            : "bg-gray-800/90 border-gray-600 text-gray-200"
                            }`}
                        onClick={() => {
                            if (targetTabId) onSelectTab(targetTabId);
                            onDismiss(n.id);
                        }}
                    >
                        <div className="flex items-center gap-2">
                            <span className="text-green-400 text-[10px]">●</span>
                            <span className="font-medium truncate">
                                {targetTab?.title || "Background tab"}
                            </span>
                            <button
                                className="ml-auto text-gray-400 hover:text-gray-200 text-[10px]"
                                onClick={(e) => { e.stopPropagation(); onDismiss(n.id); }}
                            >
                                ✕
                            </button>
                        </div>
                        <div className="mt-0.5 truncate opacity-75">{n.message}</div>
                        {targetTabId && (
                            <button
                                className={`mt-1 text-[10px] font-medium ${resolvedTheme === "light" ? "text-blue-600 hover:text-blue-800" : "text-blue-400 hover:text-blue-300"}`}
                                onClick={(e) => { e.stopPropagation(); onSelectTab(targetTabId); onDismiss(n.id); }}
                            >
                                Go to tab
                            </button>
                        )}
                    </motion.div>
                );
            })}
        </div>
    );
};

export default NotificationOverlay;
