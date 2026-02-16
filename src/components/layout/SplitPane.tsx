import type { LayoutNode } from "../../types";
import SettingsPane from "../../features/settings/components/SettingsPane";
import TerminalPane from "./TerminalPane";

interface SplitPaneProps {
  node: LayoutNode;
}

const SplitPane: React.FC<SplitPaneProps> = ({ node }) => {
  // Settings leaf
  if (node.type === "leaf" && node.contentType === "settings") {
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <SettingsPane />
      </div>
    );
  }

  // Terminal leaf
  if (node.type === "leaf") {
    return <TerminalPane sessionId={node.sessionId} />;
  }

  // Split node — recurse
  return (
    <div
      className={`flex w-full h-full ${node.direction === "horizontal" ? "flex-row" : "flex-col"}`}
    >
      {node.children.map((child, index) => (
        <div
          key={index}
          style={{ flex: node.sizes ? node.sizes[index] : 1 }}
          className="relative border-r border-b border-white/5 last:border-0 overflow-hidden"
        >
          <SplitPane node={child} />
        </div>
      ))}
    </div>
  );
};

export default SplitPane;
