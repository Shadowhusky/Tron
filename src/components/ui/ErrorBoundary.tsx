import { Component, type ReactNode } from "react";

/**
 * Root error boundary — turns any uncaught render/boot crash into a
 * recoverable screen instead of a blank white page. Deliberately styled
 * inline with system defaults only: it must render even when theme/config
 * providers (or the storage backing them) are the thing that crashed.
 *
 * Recovery follows the forgiveness principle: "Reload" first (most crashes
 * are transient), "Reset App Data" as the deeper escape hatch for corrupt
 * persisted state — it clears Tron's localStorage and reloads fresh.
 */
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("Tron crashed during render:", error, info.componentStack);
  }

  private resetAppData = () => {
    try {
      // Only clear Tron's own keys — leave unrelated origin data alone.
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith("tron") || k.startsWith("tron:") || k.startsWith("tron_"))) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch { /* storage unavailable — reload anyway */ }
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#1c1c1e",
          color: "#f5f5f7",
          fontFamily: "system-ui, -apple-system, sans-serif",
          padding: 24,
        }}
      >
        <div style={{ maxWidth: 420, textAlign: "center" }}>
          <div style={{ fontSize: 34, marginBottom: 12 }}>⚠️</div>
          <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em", margin: "0 0 8px" }}>
            Tron ran into a problem
          </h1>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: "#a1a1a6", margin: "0 0 20px" }}>
            Something went wrong while loading. Reloading usually fixes this.
            If it keeps happening, resetting app data clears saved layout and
            settings and starts fresh.
          </p>
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: "8px 18px", borderRadius: 8, border: "none", cursor: "pointer",
                background: "#0a84ff", color: "#fff", fontSize: 14, fontWeight: 500,
              }}
            >
              Reload
            </button>
            <button
              onClick={this.resetAppData}
              style={{
                padding: "8px 18px", borderRadius: 8, cursor: "pointer",
                background: "transparent", color: "#ff453a", fontSize: 14, fontWeight: 500,
                border: "1px solid rgba(255,69,58,0.4)",
              }}
            >
              Reset App Data
            </button>
          </div>
          <details style={{ marginTop: 20, textAlign: "left" }}>
            <summary style={{ fontSize: 12, color: "#6e6e73", cursor: "pointer" }}>Details</summary>
            <pre style={{
              fontSize: 11, color: "#8e8e93", whiteSpace: "pre-wrap", wordBreak: "break-word",
              background: "rgba(255,255,255,0.05)", padding: 10, borderRadius: 6, marginTop: 8,
            }}>
              {String(this.state.error?.stack || this.state.error)}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
