import { useEffect, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { ArrowLeftRight, Copy, ExternalLink, X } from "lucide-react";
import { themeClass } from "../../../utils/theme";
import { describeForward, forwardLocalAddress } from "../../../utils/portForward";
import { addPortForward, openUrlExternally, removePortForward } from "../../../services/portForwards";
import type { ResolvedTheme } from "../../../contexts/ThemeContext";
import type { PortForward, PortForwardSpec, PortForwardType } from "../../../types";

interface PortForwardsChipProps {
  sessionId: string;
  resolvedTheme: ResolvedTheme;
  forwards: PortForward[];
  /** Whether a loopback listener on the backend is reachable from this window. */
  canOpenLocally: boolean;
  className?: string;
}

const TYPE_LABEL: Record<PortForwardType, string> = { local: "L", remote: "R", dynamic: "D" };

function ipcErrorMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

/** `⇄ N` chip for an SSH pane; opens the Ports popover (also via `tron:openPortForwards`). */
export function PortForwardsChip({ sessionId, resolvedTheme, forwards, canOpenLocally, className = "" }: PortForwardsChipProps) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent).detail?.sessionId === sessionId) setOpen(true);
    };
    window.addEventListener("tron:openPortForwards", handler);
    return () => window.removeEventListener("tron:openPortForwards", handler);
  }, [sessionId]);

  const hasError = forwards.some((f) => f.status === "error");
  const muted = themeClass(resolvedTheme, { dark: "text-gray-500", modern: "text-gray-400", light: "text-gray-500" });

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="Forwarded ports"
          data-testid="port-forwards-chip"
          className={`${forwards.length || open ? "flex" : "hidden"} shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] transition-colors ${
            hasError
              ? "border-red-500/40 text-red-400"
              : themeClass(resolvedTheme, {
                  dark: "border-white/10 bg-gray-800/90 text-gray-300 hover:text-white",
                  modern: "border-white/10 bg-gray-900/90 text-gray-300 hover:text-white",
                  light: "border-gray-300 bg-white/90 text-gray-600 hover:text-gray-900",
                })
          } ${className}`}
        >
          <ArrowLeftRight className="h-3 w-3" strokeWidth={1.75} />
          {forwards.length}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          data-testid="port-forwards-popover"
          onOpenAutoFocus={(e) => e.preventDefault()}
          className={`z-[200] w-[360px] overflow-hidden rounded-xl text-[13px] shadow-xl ${themeClass(resolvedTheme, {
            dark: "border border-white/10 bg-[#1e1e1e] text-gray-200",
            modern: "border border-white/[0.15] bg-[#172033]/95 text-white shadow-[0_8px_32px_rgba(0,0,0,0.4)]",
            light: "border border-gray-200 bg-white text-gray-800",
          })}`}
        >
          <div className={`px-3 pt-2.5 pb-1.5 text-[11px] font-medium uppercase tracking-wider ${muted}`}>Ports</div>
          {forwards.length === 0 ? (
            <div className={`px-3 pb-2 text-[12px] ${muted}`}>No forwarded ports.</div>
          ) : (
            <ul className="pb-1">
              {forwards.map((f) => (
                <ForwardRow
                  key={f.id}
                  forward={f}
                  resolvedTheme={resolvedTheme}
                  canOpenLocally={canOpenLocally}
                  onStop={() => removePortForward(sessionId, f.id).catch(() => {})}
                />
              ))}
            </ul>
          )}
          {!canOpenLocally && forwards.length > 0 && (
            <div className={`px-3 pb-2 text-[11px] ${muted}`}>
              Listeners run on the Tron server, so they're reachable from that machine only.
            </div>
          )}
          <div className={`h-px ${themeClass(resolvedTheme, { dark: "bg-white/10", modern: "bg-white/10", light: "bg-gray-200" })}`} />
          <AddForwardForm sessionId={sessionId} resolvedTheme={resolvedTheme} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ForwardRow({
  forward: f,
  resolvedTheme,
  canOpenLocally,
  onStop,
}: {
  forward: PortForward;
  resolvedTheme: ResolvedTheme;
  canOpenLocally: boolean;
  onStop: () => void;
}) {
  const localUrl = forwardLocalAddress(f);
  const iconBtn = `rounded p-1 transition-colors ${themeClass(resolvedTheme, {
    dark: "text-gray-400 hover:bg-white/10 hover:text-white",
    modern: "text-gray-400 hover:bg-white/10 hover:text-white",
    light: "text-gray-500 hover:bg-gray-100 hover:text-gray-900",
  })}`;
  return (
    <li className="flex items-start gap-2 px-3 py-1">
      <span
        title={f.type}
        className={`mt-0.5 w-4 shrink-0 rounded text-center font-mono text-[10px] font-semibold ${
          f.status === "error"
            ? "bg-red-500/15 text-red-400"
            : themeClass(resolvedTheme, { dark: "bg-blue-500/15 text-blue-300", modern: "bg-blue-500/20 text-blue-300", light: "bg-blue-100 text-blue-600" })
        }`}
      >
        {TYPE_LABEL[f.type]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[12px]" title={describeForward(f)}>{describeForward(f)}</div>
        {f.status === "error" && <div className="truncate text-[11px] text-red-400">{f.error}</div>}
      </div>
      {f.type === "local" && f.status === "active" && canOpenLocally && (
        <button type="button" title="Open in browser" className={iconBtn} onClick={() => openUrlExternally(localUrl)}>
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
      )}
      {f.type !== "remote" && (
        <button
          type="button"
          title="Copy local address"
          className={iconBtn}
          onClick={() => navigator.clipboard?.writeText(localUrl).catch(() => {})}
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      )}
      <button type="button" title="Stop forwarding" className={iconBtn} onClick={onStop}>
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}

function AddForwardForm({ sessionId, resolvedTheme }: { sessionId: string; resolvedTheme: ResolvedTheme }) {
  const [type, setType] = useState<PortForwardType>("local");
  const [remoteHost, setRemoteHost] = useState("localhost");
  const [remotePort, setRemotePort] = useState("");
  const [localPort, setLocalPort] = useState("");
  const [persist, setPersist] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const field = `min-w-0 rounded-md border px-2 py-1 font-mono text-[12px] outline-none ${themeClass(resolvedTheme, {
    dark: "border-white/10 bg-black/30 text-gray-200 placeholder:text-gray-600 focus:border-blue-500/60",
    modern: "border-white/10 bg-black/20 text-white placeholder:text-gray-500 focus:border-blue-400/60",
    light: "border-gray-300 bg-white text-gray-800 placeholder:text-gray-400 focus:border-blue-500",
  })}`;
  const label = `text-[11px] ${themeClass(resolvedTheme, { dark: "text-gray-500", modern: "text-gray-400", light: "text-gray-500" })}`;
  const toPort = (v: string) => (v.trim() === "" ? undefined : Number(v));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const spec: PortForwardSpec =
      type === "dynamic"
        ? { type, localPort: toPort(localPort) }
        : type === "local"
          ? { type, remoteHost: remoteHost.trim() || undefined, remotePort: toPort(remotePort), localPort: toPort(localPort) }
          : { type, remotePort: toPort(remotePort) ?? 0, localPort: toPort(localPort) };
    setBusy(true);
    setError("");
    try {
      const rec = await addPortForward(sessionId, spec, persist);
      if (rec.status === "error") setError(rec.error || "Forward failed");
      else {
        setRemotePort("");
        setLocalPort("");
      }
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 px-3 py-2.5" data-testid="port-forward-form">
      <div className="flex items-center gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as PortForwardType)}
          className={`${field} font-sans`}
          aria-label="Forward type"
        >
          <option value="local">Local (-L)</option>
          <option value="remote">Remote (-R)</option>
          <option value="dynamic">SOCKS (-D)</option>
        </select>
        {type === "local" && (
          <input value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder="remote host" aria-label="Remote host" className={`${field} flex-1`} />
        )}
      </div>
      <div className="flex items-end gap-2">
        {type !== "dynamic" && (
          <label className="flex flex-1 flex-col gap-0.5">
            <span className={label}>{type === "local" ? "Remote port" : "Port on remote"}</span>
            <input
              value={remotePort}
              onChange={(e) => setRemotePort(e.target.value.replace(/\D/g, ""))}
              placeholder={type === "local" ? "5173" : "any"}
              inputMode="numeric"
              className={field}
            />
          </label>
        )}
        <label className="flex flex-1 flex-col gap-0.5">
          <span className={label}>{type === "remote" ? "Local target port" : "Local port"}</span>
          <input
            value={localPort}
            onChange={(e) => setLocalPort(e.target.value.replace(/\D/g, ""))}
            placeholder={type === "local" ? "same" : type === "dynamic" ? "1080" : "3000"}
            inputMode="numeric"
            className={field}
          />
        </label>
        <button
          type="submit"
          disabled={busy}
          className="shrink-0 rounded-md bg-blue-500 px-3 py-1 text-[12px] font-medium text-white transition-colors hover:bg-blue-600 disabled:opacity-50"
        >
          Forward
        </button>
      </div>
      <label className={`flex items-center gap-1.5 ${label}`}>
        <input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} />
        Remember for this profile
      </label>
      {error && <div className="text-[11px] text-red-400">{error}</div>}
    </form>
  );
}
