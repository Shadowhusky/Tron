import { motion } from "framer-motion";
import type { ResolvedTheme } from "../../contexts/ThemeContext";
import { themeClass, getTheme } from "../../utils/theme";

interface EmptyStateProps {
  resolvedTheme: ResolvedTheme;
  onConnect: () => void;
}

const EmptyState: React.FC<EmptyStateProps> = ({ resolvedTheme, onConnect }) => {
  return (
    <div className={`flex items-center justify-center h-full ${getTheme(resolvedTheme).appBg}`}>
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex flex-col items-center gap-6 text-center max-w-sm"
      >
        {/* Globe / SSH icon */}
        <div className={`p-4 rounded-2xl ${themeClass(resolvedTheme, {
          dark: "bg-white/5",
          modern: "bg-white/[0.04] backdrop-blur-xl",
          light: "bg-gray-100",
        })}`}>
          <svg className={`w-12 h-12 ${themeClass(resolvedTheme, {
            dark: "text-gray-500",
            modern: "text-purple-400/60",
            light: "text-gray-400",
          })}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9" />
          </svg>
        </div>

        <div>
          <h2 className={`text-lg font-semibold mb-1 ${themeClass(resolvedTheme, {
            dark: "text-white",
            modern: "text-white",
            light: "text-gray-900",
          })}`}>
            Connect to a Server
          </h2>
          <p className={`text-sm ${themeClass(resolvedTheme, {
            dark: "text-gray-500",
            modern: "text-gray-400",
            light: "text-gray-500",
          })}`}>
            Open an SSH connection to start a remote terminal session.
          </p>
        </div>

        <motion.button
          whileHover={{ scale: 1.03 }}
          whileTap={{ scale: 0.97 }}
          onClick={onConnect}
          className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-colors ${themeClass(resolvedTheme, {
            dark: "bg-blue-600 hover:bg-blue-500 text-white",
            modern: "bg-purple-500/80 hover:bg-purple-500 text-white backdrop-blur-sm",
            light: "bg-blue-600 hover:bg-blue-500 text-white",
          })}`}
        >
          New SSH Connection
        </motion.button>
      </motion.div>
    </div>
  );
};

export default EmptyState;
