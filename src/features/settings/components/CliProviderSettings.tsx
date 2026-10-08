import { useEffect, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { CLI_AGENT_PROVIDERS, resolveCliMode, type CliAgentProvider } from "../../../services/ai/cliAgent/providers";
import { detectCliAgents, type CliDetection } from "../../../services/ai/cliAgent/runner";

// Detection spawns `--version` / auth checks — do it once per app session.
let detectionCache: Promise<Awaited<ReturnType<typeof detectCliAgents>>> | null = null;
function detect(force = false) {
  if (!detectionCache || force) detectionCache = detectCliAgents();
  return detectionCache;
}

const CUSTOM = "__custom__";

export function CliProviderSettings({
  provider,
  model,
  mode,
  onChange,
  labelClass,
  inputClass,
  selectClass,
  mutedClass,
}: {
  provider: CliAgentProvider;
  model: string;
  mode?: string;
  onChange: (update: { model?: string; cliMode?: string }) => void;
  labelClass: string;
  inputClass: string;
  selectClass: string;
  mutedClass: string;
}) {
  const info = CLI_AGENT_PROVIDERS[provider];
  const [status, setStatus] = useState<CliDetection | null | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [customOpen, setCustomOpen] = useState(!!model && !info.models.includes(model));

  useEffect(() => {
    let alive = true;
    detect().then((d) => alive && setStatus(d[info.kind]));
    return () => { alive = false; };
  }, [info.kind]);

  const refresh = async () => {
    setRefreshing(true);
    const d = await detect(true);
    setStatus(d[info.kind]);
    setRefreshing(false);
  };

  const activeMode = resolveCliMode(provider, mode);
  const modeInfo = info.modes.find((m) => m.id === activeMode);
  const statusDot = status === undefined ? "bg-gray-400" : status?.loggedIn ? "bg-green-500" : status ? "bg-yellow-500" : "bg-red-500";
  const statusText = status === undefined
    ? "Checking…"
    : status === null
      ? `${info.shortLabel} CLI not found. ${info.installHint}`
      : status.loggedIn
        ? `${info.shortLabel} ${status.version ?? ""} · signed in${status.authMethod ? ` (${status.authMethod})` : ""}`
        : `${info.shortLabel} ${status.version ?? ""} installed but not signed in. ${info.loginHint}`;

  return (
    <div className="space-y-3" data-testid="cli-provider-settings">
      <div className="flex items-start gap-2">
        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${statusDot}`} />
        <p data-testid="cli-provider-status" className={`flex-1 text-[11px] leading-snug ${mutedClass}`}>{statusText}</p>
        <button
          type="button"
          onClick={refresh}
          title="Check again"
          className={`shrink-0 opacity-60 transition-opacity hover:opacity-100 ${mutedClass}`}
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
        </button>
      </div>
      <p className={`text-[11px] leading-snug ${mutedClass}`}>
        Uses your {info.kind === "claude" ? "Claude Pro/Max" : "ChatGPT"} plan through the installed CLI — no API key, and Tron never sees your login.
      </p>

      <div className="flex flex-col gap-1">
        <label className={labelClass}>Model</label>
        <div className="relative">
          <select
            data-testid="cli-model-select"
            value={customOpen ? CUSTOM : model || "default"}
            onChange={(e) => {
              if (e.target.value === CUSTOM) {
                setCustomOpen(true);
                return;
              }
              setCustomOpen(false);
              onChange({ model: e.target.value });
            }}
            className={selectClass}
          >
            {info.models.map((m) => (
              <option key={m} value={m}>{m === "default" ? "Default (from the CLI's settings)" : m}</option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-50" />
        </div>
        {customOpen && (
          <input
            data-testid="cli-model-custom"
            type="text"
            placeholder={info.kind === "claude" ? "e.g. claude-sonnet-5-5" : "e.g. gpt-5-codex"}
            value={info.models.includes(model) ? "" : model}
            onChange={(e) => onChange({ model: e.target.value.trim() || "default" })}
            className={`${inputClass} font-mono`}
          />
        )}
      </div>

      <div className="flex flex-col gap-1">
        <label className={labelClass}>{info.kind === "claude" ? "Permissions" : "Sandbox"}</label>
        <div className="relative">
          <select
            data-testid="cli-mode-select"
            value={activeMode}
            onChange={(e) => onChange({ cliMode: e.target.value })}
            className={selectClass}
          >
            {info.modes.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 opacity-50" />
        </div>
        {modeInfo && <p className={`text-[11px] leading-snug ${mutedClass}`}>{modeInfo.hint}</p>}
      </div>
    </div>
  );
}
