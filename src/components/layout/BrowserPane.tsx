import { useState, useRef, useCallback, useEffect } from "react";
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, X, Globe, AlertTriangle } from "lucide-react";
import { useTheme } from "../../contexts/ThemeContext";
import { useLayout } from "../../contexts/LayoutContext";
import { themeClass } from "../../utils/theme";
import { normalizeBrowserInput, isMixedContentBlocked, httpFallback } from "../../utils/browserUrl";
import { IPC } from "../../constants/ipc";

interface BrowserPaneProps {
  sessionId: string;
  initialUrl: string;
}

type ProbeResult =
  | { ok: true; embeddable: boolean; status: number }
  | { ok: false; kind: "not-found" | "refused" | "tls" | "http-only" | "timeout" | "error"; message: string };

type PageError = { title: string; message: string; offerHttp: boolean };

/** Past this the pane offers the system browser — some pages never fire onLoad in a frame. */
const SLOW_LOAD_MS = 20_000;

/** The iframe can't report failures (it just stays blank), so ask main / the server first. */
async function probe(url: string): Promise<ProbeResult | null> {
  try {
    return (await window.electron?.ipcRenderer?.invoke?.(IPC.BROWSER_PROBE, url)) ?? null;
  } catch {
    return null; // probe unavailable (e.g. SSH-only gateway) — let the frame try
  }
}

const ERROR_TITLES: Record<string, string> = {
  "not-found": "Site not found",
  refused: "Can't connect",
  tls: "Certificate not trusted",
  "http-only": "This server doesn't support HTTPS",
  error: "Couldn't load this page",
};

const BrowserPane: React.FC<BrowserPaneProps> = ({ sessionId, initialUrl }) => {
  const { resolvedTheme } = useTheme();
  const { closePane } = useLayout();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [url, setUrl] = useState(initialUrl);
  const [autoScheme, setAutoScheme] = useState(false);
  const [inputUrl, setInputUrl] = useState(initialUrl);
  const [phase, setPhase] = useState<"checking" | "loading" | "loaded" | "error">("checking");
  const [error, setError] = useState<PageError | null>(null);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const urlRef = useRef(initialUrl);

  urlRef.current = url;

  useEffect(() => {
    let cancelled = false;
    setPhase("checking");
    setError(null);
    setSlow(false);
    const fail = (e: PageError) => { if (!cancelled) { setError(e); setPhase("error"); } };

    if (isMixedContentBlocked(window.location.protocol, url)) {
      fail({
        title: "Insecure page blocked",
        message: "Tron is open over HTTPS, so the browser won't show this http:// page inside it.",
        offerHttp: false,
      });
      return () => { cancelled = true; };
    }

    probe(url).then((r) => {
      if (cancelled) return;
      if (!r || r.ok || r.kind === "timeout") {
        if (r?.ok && !r.embeddable) {
          fail({ title: "This site can't be shown inside Tron", message: "Its security policy forbids being displayed in a frame.", offerHttp: false });
          return;
        }
        setPhase("loading");
        return;
      }
      const fallback = httpFallback(url);
      // Tron guessed https for a bare address — the server may only speak http.
      if (autoScheme && fallback && (r.kind === "refused" || r.kind === "tls" || r.kind === "http-only")) {
        setAutoScheme(false);
        setUrl(fallback);
        setInputUrl(fallback);
        return;
      }
      fail({
        title: ERROR_TITLES[r.kind] ?? ERROR_TITLES.error,
        message: r.message,
        offerHttp: !!fallback && (r.kind === "refused" || r.kind === "tls" || r.kind === "http-only"),
      });
    });
    return () => { cancelled = true; };
  }, [url, autoScheme, attempt]);

  useEffect(() => {
    if (phase !== "loading") return;
    const timer = setTimeout(() => setSlow(true), SLOW_LOAD_MS);
    return () => clearTimeout(timer);
  }, [phase, attempt]);

  const navigate = useCallback((input: string) => {
    const next = normalizeBrowserInput(input);
    setAutoScheme(next.autoScheme);
    setUrl(next.url);
    setInputUrl(next.url);
    setAttempt((n) => n + 1);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") navigate(inputUrl);
  };

  const handleLoad = () => {
    setPhase("loaded");
    setSlow(false);
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

  const doReload = useCallback(() => setAttempt((n) => n + 1), []);

  const tryHttp = useCallback(() => {
    const fallback = httpFallback(urlRef.current);
    if (!fallback) return;
    setAutoScheme(false);
    setUrl(fallback);
    setInputUrl(fallback);
  }, []);

  const t = themeClass;
  const navButton = `p-1 rounded ${t(resolvedTheme, { dark: "hover:bg-white/10 text-gray-400", modern: "hover:bg-white/10 text-gray-300", light: "hover:bg-gray-200 text-gray-600" })}`;
  const actionButton = `flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
    resolvedTheme === "light" ? "bg-gray-200 hover:bg-gray-300 text-gray-700" : "bg-white/10 hover:bg-white/15 text-gray-300"
  }`;

  return (
    <div className="flex flex-col h-full w-full">
      {/* Navigation bar */}
      <div
        className={`flex items-center gap-1.5 px-2 py-1.5 border-b shrink-0 ${t(
          resolvedTheme,
          {
            dark: "bg-[#0a0a0a] border-white/5",
            modern: "bg-[#0b0e16]/70 backdrop-blur-xl backdrop-saturate-150 border-white/[0.08]",
            light: "bg-gray-50 border-gray-200",
          },
        )}`}
      >
        <button
          onClick={() => { try { iframeRef.current?.contentWindow?.history.back(); } catch { /* cross-origin */ } }}
          className={navButton}
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => { try { iframeRef.current?.contentWindow?.history.forward(); } catch { /* cross-origin */ } }}
          className={navButton}
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button onClick={doReload} className={navButton}>
          <RotateCw className={`h-3.5 w-3.5 ${phase === "checking" || phase === "loading" ? "animate-spin" : ""}`} />
        </button>

        {/* URL bar */}
        <div className={`flex-1 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-mono ${t(
          resolvedTheme,
          {
            dark: "bg-white/5 text-gray-300 border border-white/5",
            modern: "bg-white/[0.06] text-gray-300 border border-white/[0.08]",
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

        <button onClick={openExternal} className={navButton} title="Open in system browser">
          <ExternalLink className="h-3.5 w-3.5" />
        </button>

        <button onClick={() => closePane(sessionId)} className={navButton}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 relative min-h-0">
        {phase === "checking" && (
          <div className={`absolute inset-0 z-10 flex items-center justify-center ${
            resolvedTheme === "light" ? "bg-gray-50" : "bg-[#0a0a0a]"
          }`}>
            <RotateCw className={`h-5 w-5 animate-spin ${resolvedTheme === "light" ? "text-gray-400" : "text-gray-500"}`} />
          </div>
        )}
        {phase === "error" && error && (
          <div
            data-testid="browser-error"
            className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-6 ${t(
              resolvedTheme,
              {
                dark: "bg-[#0a0a0a] text-gray-400",
                modern: "bg-[#0b0e16]/70 backdrop-blur-xl backdrop-saturate-150 text-gray-300",
                light: "bg-gray-50 text-gray-600",
              },
            )}`}
          >
            <AlertTriangle className="h-8 w-8 opacity-40" />
            <p className="text-sm">{error.title}</p>
            <p className="text-xs opacity-60 max-w-[320px] text-center">{error.message}</p>
            <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
              <button onClick={doReload} className={actionButton}>
                <RotateCw className="h-3 w-3" />
                Try again
              </button>
              {error.offerHttp && (
                <button onClick={tryHttp} className={actionButton}>
                  Try http://
                </button>
              )}
              <button onClick={openExternal} className={actionButton}>
                <ExternalLink className="h-3 w-3" />
                Open in Browser
              </button>
            </div>
          </div>
        )}
        {(phase === "loading" || phase === "loaded") && (
          <>
            {phase === "loading" && (
              <div className={`absolute inset-0 flex items-center justify-center pointer-events-none ${
                resolvedTheme === "light" ? "bg-gray-50" : "bg-[#0a0a0a]"
              }`}>
                <RotateCw className={`h-5 w-5 animate-spin ${resolvedTheme === "light" ? "text-gray-400" : "text-gray-500"}`} />
              </div>
            )}
            <iframe
              key={`${url}#${attempt}`}
              ref={iframeRef}
              src={url}
              onLoad={handleLoad}
              className={`relative w-full h-full border-0 ${phase === "loading" ? "opacity-0" : ""}`}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
              allow="clipboard-read; clipboard-write"
            />
            {slow && phase === "loading" && (
              <div className={`absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs shadow-lg ${t(
                resolvedTheme,
                {
                  dark: "bg-[#1a1a1a] border-white/10 text-gray-300",
                  modern: "bg-[#121826] border-white/[0.12] text-gray-300",
                  light: "bg-white border-gray-200 text-gray-600",
                },
              )}`}>
                Still loading…
                <button onClick={openExternal} className="text-blue-500 hover:underline">Open in Browser</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default BrowserPane;
