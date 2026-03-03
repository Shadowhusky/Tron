import { useState, useRef, useCallback } from "react";
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, X, Globe } from "lucide-react";
import { useTheme } from "../../contexts/ThemeContext";
import { useLayout } from "../../contexts/LayoutContext";
import { themeClass } from "../../utils/theme";

interface BrowserPaneProps {
  sessionId: string;
  initialUrl: string;
}

const BrowserPane: React.FC<BrowserPaneProps> = ({ sessionId, initialUrl }) => {
  const { resolvedTheme } = useTheme();
  const { closePane } = useLayout();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState(initialUrl);
  const [inputUrl, setInputUrl] = useState(initialUrl);
  const [loading, setLoading] = useState(true);

  const navigate = useCallback((newUrl: string) => {
    let normalized = newUrl.trim();
    if (!/^https?:\/\//i.test(normalized)) {
      // If it looks like a domain, add https://
      if (/^[a-z0-9-]+\.[a-z]{2,}/i.test(normalized)) {
        normalized = `https://${normalized}`;
      } else {
        // Treat as search query
        normalized = `https://www.google.com/search?q=${encodeURIComponent(normalized)}`;
      }
    }
    setUrl(normalized);
    setInputUrl(normalized);
    setLoading(true);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      navigate(inputUrl);
    }
  };

  const handleLoad = () => {
    setLoading(false);
    // Try to read iframe URL (may fail due to cross-origin)
    try {
      const iframeUrl = iframeRef.current?.contentWindow?.location.href;
      if (iframeUrl && iframeUrl !== "about:blank") {
        setInputUrl(iframeUrl);
      }
    } catch { /* cross-origin — ignore */ }
  };

  const t = themeClass;

  return (
    <div className="flex flex-col h-full w-full">
      {/* Navigation bar */}
      <div
        className={`flex items-center gap-1.5 px-2 py-1.5 border-b shrink-0 ${t(
          resolvedTheme,
          {
            dark: "bg-[#0a0a0a] border-white/5",
            modern: "bg-[#040414] border-white/6",
            light: "bg-gray-50 border-gray-200",
          },
        )}`}
      >
        {/* Nav buttons */}
        <button
          onClick={() => iframeRef.current?.contentWindow?.history.back()}
          className={`p-1 rounded ${resolvedTheme === "light" ? "hover:bg-gray-200 text-gray-600" : "hover:bg-white/10 text-gray-400"}`}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => iframeRef.current?.contentWindow?.history.forward()}
          className={`p-1 rounded ${resolvedTheme === "light" ? "hover:bg-gray-200 text-gray-600" : "hover:bg-white/10 text-gray-400"}`}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => { setLoading(true); iframeRef.current?.contentWindow?.location.reload(); }}
          className={`p-1 rounded ${resolvedTheme === "light" ? "hover:bg-gray-200 text-gray-600" : "hover:bg-white/10 text-gray-400"}`}
        >
          <RotateCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>

        {/* URL bar */}
        <div className={`flex-1 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-mono ${t(
          resolvedTheme,
          {
            dark: "bg-white/5 text-gray-300 border border-white/5",
            modern: "bg-white/5 text-gray-300 border border-white/5",
            light: "bg-white text-gray-700 border border-gray-200",
          },
        )}`}>
          <Globe className="h-3 w-3 shrink-0 opacity-50" />
          <input
            type="text"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent outline-none min-w-0"
            placeholder="Enter URL or search..."
          />
        </div>

        {/* Open external */}
        <button
          onClick={() => window.open(url, "_blank")}
          className={`p-1 rounded ${resolvedTheme === "light" ? "hover:bg-gray-200 text-gray-600" : "hover:bg-white/10 text-gray-400"}`}
          title="Open in system browser"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>

        {/* Close */}
        <button
          onClick={() => closePane(sessionId)}
          className={`p-1 rounded ${resolvedTheme === "light" ? "hover:bg-gray-200 text-gray-600" : "hover:bg-white/10 text-gray-400"}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* iframe */}
      <div className="flex-1 relative min-h-0">
        {loading && (
          <div className={`absolute inset-0 z-10 flex items-center justify-center ${
            resolvedTheme === "light" ? "bg-gray-50" : "bg-[#0a0a0a]"
          }`}>
            <RotateCw className={`h-5 w-5 animate-spin ${resolvedTheme === "light" ? "text-gray-400" : "text-gray-500"}`} />
          </div>
        )}
        <iframe
          ref={iframeRef}
          src={url}
          onLoad={handleLoad}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          allow="clipboard-read; clipboard-write"
        />
      </div>
    </div>
  );
};

export default BrowserPane;
