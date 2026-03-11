import { useState, useRef, useCallback, useEffect } from "react";
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, X, Globe } from "lucide-react";
import { useTheme } from "../../contexts/ThemeContext";
import { useLayout } from "../../contexts/LayoutContext";
import { themeClass } from "../../utils/theme";

interface BrowserPaneProps {
  sessionId: string;
  initialUrl: string;
}

/**
 * Check if a URL can be embedded in an iframe by inspecting response headers
 * via the server's /api/frame-check endpoint (avoids CORS from renderer).
 * Falls back to allowing embed if the check can't be performed.
 */
async function canEmbed(targetUrl: string): Promise<boolean> {
  try {
    // In web mode, use relative URL so it works from any hostname.
    // In Electron mode, use the embedded web server on localhost.
    let checkUrl: string;
    if (!(window as any)._electronBridge) {
      // Web mode — relative fetch goes to the same origin
      checkUrl = `/api/frame-check?url=${encodeURIComponent(targetUrl)}`;
    } else {
      const port = (window as any).__tronWebServerPort || 3888;
      checkUrl = `http://localhost:${port}/api/frame-check?url=${encodeURIComponent(targetUrl)}`;
    }
    const res = await fetch(checkUrl, {
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      const data = await res.json();
      return data.embeddable !== false;
    }
  } catch { /* server not available */ }
  // Can't check — allow iframe attempt
  return true;
}

const BrowserPane: React.FC<BrowserPaneProps> = ({ sessionId, initialUrl }) => {
  const { resolvedTheme } = useTheme();
  const { closePane } = useLayout();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState(initialUrl);
  const [inputUrl, setInputUrl] = useState(initialUrl);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [checked, setChecked] = useState(false);
  const urlRef = useRef(initialUrl);

  urlRef.current = url;

  // Pre-check if URL allows embedding before rendering iframe
  useEffect(() => {
    setLoading(true);
    setBlocked(false);
    setChecked(false);
    let cancelled = false;
    canEmbed(url).then((ok) => {
      if (cancelled) return;
      if (!ok) {
        setBlocked(true);
        setLoading(false);
      }
      setChecked(true);
    });
    return () => { cancelled = true; };
  }, [url]);

  const navigate = useCallback((newUrl: string) => {
    let normalized = newUrl.trim();
    if (!/^https?:\/\//i.test(normalized)) {
      // Looks like a URL: has a dot with TLD, or localhost, or IP address, or has a port
      if (/^([a-z0-9-]+\.)+[a-z]{2,}/i.test(normalized) ||
          /^localhost([:\/]|$)/i.test(normalized) ||
          /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}([:\/]|$)/.test(normalized)) {
        normalized = `https://${normalized}`;
      } else {
        normalized = `https://www.google.com/search?q=${encodeURIComponent(normalized)}`;
      }
    }
    setUrl(normalized);
    setInputUrl(normalized);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") navigate(inputUrl);
  };

  const handleLoad = () => {
    setLoading(false);
    try {
      const iframeUrl = iframeRef.current?.contentWindow?.location.href;
      if (iframeUrl && iframeUrl !== "about:blank") {
        setInputUrl(iframeUrl);
      }
    } catch { /* cross-origin */ }
  };

  const openExternal = useCallback(() => {
    if (window.electron?.ipcRenderer?.invoke) {
      window.electron.ipcRenderer.invoke("shell.openExternal", urlRef.current)?.catch(() => {});
    } else {
      window.open(urlRef.current, "_blank", "noopener,noreferrer");
    }
  }, []);

  const doReload = useCallback(() => {
    setLoading(true);
    setBlocked(false);
    setChecked(false);
    canEmbed(url).then((ok) => {
      if (!ok) { setBlocked(true); setLoading(false); }
      setChecked(true);
    });
  }, [url]);

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
        <button
          onClick={() => { try { iframeRef.current?.contentWindow?.history.back(); } catch { /* cross-origin */ } }}
          className={`p-1 rounded ${resolvedTheme === "light" ? "hover:bg-gray-200 text-gray-600" : "hover:bg-white/10 text-gray-400"}`}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => { try { iframeRef.current?.contentWindow?.history.forward(); } catch { /* cross-origin */ } }}
          className={`p-1 rounded ${resolvedTheme === "light" ? "hover:bg-gray-200 text-gray-600" : "hover:bg-white/10 text-gray-400"}`}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={doReload}
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

        <button
          onClick={openExternal}
          className={`p-1 rounded ${resolvedTheme === "light" ? "hover:bg-gray-200 text-gray-600" : "hover:bg-white/10 text-gray-400"}`}
          title="Open in system browser"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </button>

        <button
          onClick={() => closePane(sessionId)}
          className={`p-1 rounded ${resolvedTheme === "light" ? "hover:bg-gray-200 text-gray-600" : "hover:bg-white/10 text-gray-400"}`}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 relative min-h-0">
        {loading && !blocked && (
          <div className={`absolute inset-0 z-10 flex items-center justify-center ${
            resolvedTheme === "light" ? "bg-gray-50" : "bg-[#0a0a0a]"
          }`}>
            <RotateCw className={`h-5 w-5 animate-spin ${resolvedTheme === "light" ? "text-gray-400" : "text-gray-500"}`} />
          </div>
        )}
        {blocked && (
          <div className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 ${
            resolvedTheme === "light" ? "bg-gray-50 text-gray-600" : "bg-[#0a0a0a] text-gray-400"
          }`}>
            <Globe className="h-8 w-8 opacity-40" />
            <p className="text-sm">This site cannot be embedded</p>
            <p className="text-xs opacity-60 max-w-[280px] text-center">The site&apos;s security policy prevents it from being displayed in a frame.</p>
            <button
              onClick={openExternal}
              className={`mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                resolvedTheme === "light"
                  ? "bg-gray-200 hover:bg-gray-300 text-gray-700"
                  : "bg-white/10 hover:bg-white/15 text-gray-300"
              }`}
            >
              <ExternalLink className="h-3 w-3" />
              Open in Browser
            </button>
          </div>
        )}
        {checked && !blocked && (
          <iframe
            ref={iframeRef}
            src={url}
            onLoad={handleLoad}
            className="w-full h-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
            allow="clipboard-read; clipboard-write"
          />
        )}
      </div>
    </div>
  );
};

export default BrowserPane;
