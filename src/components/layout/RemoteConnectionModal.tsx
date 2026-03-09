import { useState, useEffect, useRef } from "react";
import Modal from "../ui/Modal";
import type { ResolvedTheme } from "../../contexts/ThemeContext";
import { themeClass } from "../../utils/theme";

interface RemoteConnectionModalProps {
  show: boolean;
  resolvedTheme: ResolvedTheme;
  onConnect: (url: string) => Promise<void>;
  onClose: () => void;
}

const RemoteConnectionModal: React.FC<RemoteConnectionModalProps> = ({
  show,
  resolvedTheme,
  onConnect,
  onClose,
}) => {
  const [url, setUrl] = useState("http://");
  const [error, setError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (show) {
      setUrl("http://");
      setError("");
      setConnecting(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [show]);

  const handleConnect = async () => {
    let normalized = url.trim();
    if (!normalized) {
      setError("Please enter a server URL");
      return;
    }
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `http://${normalized}`;
    }
    try {
      new URL(normalized);
    } catch {
      setError("Invalid URL format");
      return;
    }
    setConnecting(true);
    setError("");
    try {
      await onConnect(normalized);
    } catch (err: any) {
      setError(err?.message || "Failed to connect to remote server");
      setConnecting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !connecting) {
      e.preventDefault();
      handleConnect();
    }
  };

  const t = themeClass;

  return (
    <Modal
      show={show}
      resolvedTheme={resolvedTheme}
      onClose={connecting ? () => {} : onClose}
      title="Connect to Remote Server"
      buttons={[
        { label: "Cancel", type: "ghost", onClick: connecting ? () => {} : onClose },
        { label: connecting ? "Connecting..." : "Connect", type: "primary", onClick: connecting ? () => {} : handleConnect },
      ]}
    >
      <div className="px-4 pb-4 space-y-3">
        <p className={`text-xs ${resolvedTheme === "light" ? "text-gray-500" : "text-gray-400"}`}>
          Enter the URL of a Tron server running in web mode.
        </p>
        <input
          ref={inputRef}
          type="text"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setError(""); }}
          onKeyDown={handleKeyDown}
          disabled={connecting}
          placeholder="http://192.168.1.10:3888"
          className={`w-full px-3 py-2 text-sm rounded-lg outline-none ${t(
            resolvedTheme,
            {
              dark: "bg-white/5 border border-white/10 text-gray-200 placeholder:text-gray-500 focus:border-white/20",
              modern: "bg-white/5 border border-white/10 text-gray-200 placeholder:text-gray-500 focus:border-purple-400/30",
              light: "bg-white border border-gray-200 text-gray-800 placeholder:text-gray-400 focus:border-gray-300",
            },
          )} ${connecting ? "opacity-50" : ""}`}
        />
        {error && (
          <p className="text-xs text-red-400">{error}</p>
        )}
      </div>
    </Modal>
  );
};

export default RemoteConnectionModal;
