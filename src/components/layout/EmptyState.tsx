import { motion } from "framer-motion";
import type { ResolvedTheme } from "../../contexts/ThemeContext";
import { themeClass, getTheme } from "../../utils/theme";
import logoSvg from "../../assets/logo.svg";

interface EmptyStateProps {
  resolvedTheme: ResolvedTheme;
  onConnect: () => void;
}

const EmptyState: React.FC<EmptyStateProps> = ({ resolvedTheme, onConnect }) => {
  return (
    <div className={`flex items-center justify-center h-full ${getTheme(resolvedTheme).appBg}`}>
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="flex flex-col items-center gap-8 text-center px-6"
      >
        {/* Logo */}
        <div className={`p-5 rounded-3xl ${themeClass(resolvedTheme, {
          dark: "bg-white/[0.03] border border-white/[0.06]",
          modern: "bg-white/[0.03] border border-white/[0.06] backdrop-blur-xl",
          light: "bg-gray-50 border border-gray-200",
        })}`}>
          <img src={logoSvg} alt="Tron" className="w-16 h-16" />
        </div>

        <div className="space-y-2">
          <h1 className={`text-2xl font-bold tracking-tight ${themeClass(resolvedTheme, {
            dark: "text-white",
            modern: "text-white",
            light: "text-gray-900",
          })}`}>
            Welcome to Tron
          </h1>
          <p className={`text-sm max-w-xs ${themeClass(resolvedTheme, {
            dark: "text-gray-500",
            modern: "text-gray-400",
            light: "text-gray-500",
          })}`}>
            Connect to a remote server via SSH to start your terminal session.
          </p>
        </div>

        <motion.button
          whileHover={{ scale: 1.02 }}
          whileTap={{ scale: 0.97 }}
          onClick={onConnect}
          className={`flex items-center gap-3 px-8 py-4 rounded-xl text-base font-semibold transition-all shadow-lg cursor-pointer ${themeClass(resolvedTheme, {
            dark: "bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/20",
            modern: "bg-purple-500/90 hover:bg-purple-500 text-white shadow-purple-500/25 backdrop-blur-sm",
            light: "bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/20",
          })}`}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.54a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.343 8.04" />
          </svg>
          Connect to Server
        </motion.button>
      </motion.div>
    </div>
  );
};

export default EmptyState;
