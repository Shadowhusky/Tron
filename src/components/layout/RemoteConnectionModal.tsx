import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { fadeScale, overlay } from "../../utils/motion";
import { themeClass } from "../../utils/theme";
import type { ResolvedTheme } from "../../contexts/ThemeContext";
import type { RemoteServerProfile } from "../../types";

interface RemoteConnectionModalProps {
  show: boolean;
  resolvedTheme: ResolvedTheme;
  onConnect: (url: string) => Promise<void>;
  onClose: () => void;
}

function uuid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).substring(2);
}

const RemoteConnectionModal: React.FC<RemoteConnectionModalProps> = ({
  show,
  resolvedTheme,
  onConnect,
  onClose,
}) => {
  const [profiles, setProfiles] = useState<RemoteServerProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [url, setUrl] = useState("http://");

  // Status
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load profiles on open
  useEffect(() => {
    if (show) {
      loadProfiles();
      resetForm();
    }
  }, [show]);

  const loadProfiles = async () => {
    try {
      const ipc = window.electron?.ipcRenderer;
      const data = (ipc as any)?.readRemoteProfiles
        ? await (ipc as any).readRemoteProfiles()
        : await ipc?.invoke("remote.profiles.read");
      setProfiles(data || []);
    } catch {
      setProfiles([]);
    }
  };

  const resetForm = () => {
    setSelectedProfileId(null);
    setName("");
    setUrl("http://");
    setError(null);
    setConnecting(false);
  };

  const populateFromProfile = (profile: RemoteServerProfile) => {
    setSelectedProfileId(profile.id);
    setName(profile.name);
    setUrl(profile.url);
    setError(null);
  };

  const normalizeUrl = (raw: string): string => {
    let normalized = raw.trim();
    if (!normalized) return "";
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `http://${normalized}`;
    }
    return normalized;
  };

  const handleConnect = async () => {
    const normalized = normalizeUrl(url);
    if (!normalized) {
      setError("Please enter a server URL");
      return;
    }
    try {
      new URL(normalized);
    } catch {
      setError("Invalid URL format");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      await onConnect(normalized);
      // Update lastConnected on the profile if it was a saved one
      if (selectedProfileId) {
        const updated = profiles.map((p) =>
          p.id === selectedProfileId ? { ...p, lastConnected: Date.now() } : p,
        );
        saveProfiles(updated);
      }
    } catch (e: any) {
      setError(e?.message || "Failed to connect to remote server");
      setConnecting(false);
    }
  };

  const saveProfiles = async (updated: RemoteServerProfile[]) => {
    try {
      const ipc = window.electron?.ipcRenderer;
      if ((ipc as any)?.writeRemoteProfiles) await (ipc as any).writeRemoteProfiles(updated);
      else await ipc?.invoke("remote.profiles.write", updated);
      setProfiles(updated);
      window.dispatchEvent(new CustomEvent("tron:remote-profiles-changed"));
    } catch { /* ignore */ }
  };

  const handleSaveProfile = async () => {
    const normalized = normalizeUrl(url);
    if (!normalized) return;
    const profile: RemoteServerProfile = {
      id: selectedProfileId || uuid(),
      name: name || new URL(normalized).host,
      url: normalized,
    };
    const updated = [...profiles.filter((p) => p.id !== profile.id), profile];
    await saveProfiles(updated);
    setSelectedProfileId(profile.id);
  };

  const handleDeleteProfile = async () => {
    if (!selectedProfileId) return;
    const updated = profiles.filter((p) => p.id !== selectedProfileId);
    await saveProfiles(updated);
    resetForm();
  };

  const t = themeClass;

  const inputCls = `w-full px-2.5 py-1.5 text-[13px] rounded-md border outline-none transition-colors ${t(resolvedTheme, {
    dark: "bg-white/[0.04] border-white/[0.08] text-gray-200 placeholder-gray-600 focus:border-white/20",
    modern: "bg-white/[0.04] border-white/[0.08] text-gray-200 placeholder-gray-600 focus:border-purple-400/40",
    light: "bg-gray-50/80 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-gray-400",
  })}`;

  const labelCls = `block text-[11px] font-medium mb-0.5 uppercase tracking-wider ${t(resolvedTheme, {
    dark: "text-gray-500",
    modern: "text-gray-500",
    light: "text-gray-400",
  })}`;

  const btnSecondary = `px-3 py-1.5 text-[13px] rounded-md border transition-colors ${t(resolvedTheme, {
    dark: "border-white/[0.08] hover:bg-white/[0.04] text-gray-400 hover:text-gray-200",
    modern: "border-white/[0.08] hover:bg-white/[0.04] text-gray-400 hover:text-gray-200",
    light: "border-gray-200 hover:bg-gray-50 text-gray-500 hover:text-gray-700",
  })}`;

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="remote-connect"
          variants={overlay}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
          onClick={onClose}
        >
          <motion.div
            variants={fadeScale}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-md mx-3 rounded-lg shadow-2xl overflow-hidden flex flex-col max-h-[85vh] ${t(
              resolvedTheme,
              {
                dark: "bg-[#141414] text-gray-200 border border-white/[0.06]",
                modern: "bg-[#12121a]/95 backdrop-blur-2xl text-gray-200 border border-white/[0.08] shadow-[0_0_40px_rgba(0,0,0,0.5)]",
                light: "bg-white text-gray-900 border border-gray-200/80 shadow-xl",
              },
            )}`}
          >
            {/* Header */}
            <div className={`px-4 py-3 flex items-center justify-between shrink-0 border-b ${t(resolvedTheme, {
              dark: "border-white/[0.04]",
              modern: "border-white/[0.06]",
              light: "border-gray-100",
            })}`}>
              <div className="flex items-center gap-2">
                <svg className={`w-4 h-4 ${t(resolvedTheme, {
                  dark: "text-gray-500",
                  modern: "text-purple-400/60",
                  light: "text-gray-400",
                })}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
                </svg>
                <h3 className="text-sm font-medium">Remote Server</h3>
              </div>
              <button
                onClick={onClose}
                className={`p-0.5 rounded transition-colors ${t(resolvedTheme, {
                  dark: "hover:bg-white/[0.06] text-gray-500",
                  modern: "hover:bg-white/[0.06] text-gray-500",
                  light: "hover:bg-gray-100 text-gray-400",
                })}`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="flex flex-col flex-1 overflow-hidden">
              {/* Saved profiles */}
              {profiles.length > 0 && (
                <div className={`shrink-0 border-b px-3 py-2 ${t(resolvedTheme, {
                  dark: "border-white/[0.04]",
                  modern: "border-white/[0.06]",
                  light: "border-gray-100",
                })}`}>
                  <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
                    {profiles.map((profile) => (
                      <button
                        key={profile.id}
                        onClick={() => populateFromProfile(profile)}
                        onDoubleClick={() => {
                          populateFromProfile(profile);
                          setTimeout(handleConnect, 0);
                        }}
                        className={`shrink-0 max-w-[14rem] px-2 py-1 text-[11px] rounded-md border transition-colors truncate ${
                          selectedProfileId === profile.id
                            ? t(resolvedTheme, {
                                dark: "bg-white/[0.06] border-white/[0.12] text-gray-200",
                                modern: "bg-purple-500/10 border-purple-500/20 text-purple-300",
                                light: "bg-gray-100 border-gray-300 text-gray-800",
                              })
                            : t(resolvedTheme, {
                                dark: "border-white/[0.06] hover:bg-white/[0.03] text-gray-400",
                                modern: "border-white/[0.06] hover:bg-white/[0.03] text-gray-400",
                                light: "border-gray-200 hover:bg-gray-50 text-gray-500",
                              })
                        }`}
                        title={`${profile.name} — ${profile.url}`}
                      >
                        <span className="font-medium">{profile.name}</span>
                        <span className="ml-1 opacity-50">{new URL(profile.url).host}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Form */}
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
                <div>
                  <label className={labelCls}>Name</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My Server (optional)"
                    className={inputCls}
                  />
                </div>

                <div>
                  <label className={labelCls}>Server URL</label>
                  <input
                    value={url}
                    onChange={(e) => { setUrl(e.target.value); setError(null); }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !connecting) {
                        e.preventDefault();
                        handleConnect();
                      }
                    }}
                    disabled={connecting}
                    placeholder="http://192.168.1.10:3888"
                    className={`${inputCls} ${connecting ? "opacity-50" : ""}`}
                    autoFocus
                  />
                </div>

                <p className={`text-[11px] ${resolvedTheme === "light" ? "text-gray-400" : "text-gray-600"}`}>
                  Enter the URL of a Tron server running in web mode.
                </p>

                {/* Error */}
                {error && (
                  <div className={`text-[12px] px-2.5 py-1.5 rounded-md ${t(resolvedTheme, {
                    dark: "text-red-400 bg-red-500/10",
                    modern: "text-red-400 bg-red-500/10",
                    light: "text-red-600 bg-red-50",
                  })}`}>
                    {error}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className={`shrink-0 px-4 py-2.5 flex items-center gap-2 border-t ${t(resolvedTheme, {
                dark: "border-white/[0.04]",
                modern: "border-white/[0.06]",
                light: "border-gray-100",
              })}`}>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={handleConnect}
                  disabled={connecting || !url.trim()}
                  className={`px-3.5 py-1.5 text-[13px] font-medium rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${t(resolvedTheme, {
                    dark: "bg-white/[0.1] hover:bg-white/[0.15] text-gray-200",
                    modern: "bg-purple-500/20 hover:bg-purple-500/30 text-purple-200",
                    light: "bg-gray-900 hover:bg-gray-800 text-white",
                  })}`}
                >
                  {connecting ? "Connecting..." : "Connect"}
                </motion.button>
                <button
                  onClick={handleSaveProfile}
                  disabled={!url.trim()}
                  className={`${btnSecondary} disabled:opacity-40`}
                >
                  Save
                </button>
                {selectedProfileId && (
                  <button
                    onClick={handleDeleteProfile}
                    className={`px-3 py-1.5 text-[13px] rounded-md transition-colors ${t(resolvedTheme, {
                      dark: "text-red-400/70 hover:bg-red-500/10 hover:text-red-400",
                      modern: "text-red-400/70 hover:bg-red-500/10 hover:text-red-400",
                      light: "text-red-400 hover:bg-red-50 hover:text-red-500",
                    })}`}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default RemoteConnectionModal;
