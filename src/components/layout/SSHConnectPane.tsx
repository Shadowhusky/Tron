import { useState } from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { themeClass, getTheme } from "../../utils/theme";
import SSHConnectModal from "../../features/ssh/components/SSHConnectModal";
import { useLayout } from "../../contexts/LayoutContext";

const SSHConnectPane: React.FC = () => {
  const { resolvedTheme } = useTheme();
  const { createSSHTab } = useLayout();
  const [showModal, setShowModal] = useState(false);

  return (
    <div className={`flex items-center justify-center h-full ${getTheme(resolvedTheme).appBg}`}>
      <button
        onClick={() => setShowModal(true)}
        className={`px-6 py-3 rounded-lg text-sm font-medium transition-colors cursor-pointer ${themeClass(resolvedTheme, {
          dark: "bg-white/[0.06] hover:bg-white/10 text-gray-300 border border-white/[0.08]",
          modern: "bg-white/[0.04] hover:bg-white/[0.08] text-gray-300 border border-white/[0.06]",
          light: "bg-gray-100 hover:bg-gray-200 text-gray-700 border border-gray-200",
        })}`}
      >
        Connect to Server
      </button>

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
