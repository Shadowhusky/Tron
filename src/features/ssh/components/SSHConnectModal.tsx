import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { fadeScale, overlay } from "../../../utils/motion";
import { themeClass } from "../../../utils/theme";
import type { ResolvedTheme } from "../../../contexts/ThemeContext";
import type { SSHConnectionConfig, SSHAuthMethod } from "../../../types";
import { isElectronApp } from "../../../utils/platform";
import FolderPickerModal from "../../../components/ui/FolderPickerModal";

interface SSHProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SSHAuthMethod;
  privateKeyPath?: string;
  saveCredentials?: boolean;
  savedPassword?: string;
  savedPassphrase?: string;
  fingerprint?: string;
  lastConnected?: number;
}

interface SSHConnectModalProps {
  show: boolean;
  resolvedTheme: ResolvedTheme;
  onConnect: (config: SSHConnectionConfig) => Promise<void>;
  onClose: () => void;
  /** When true, user cannot dismiss the modal (SSH-only mode with no tabs). */
  preventClose?: boolean;
}

function uuid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).substring(2);
}

const SSHConnectModal: React.FC<SSHConnectModalProps> = ({
  show,
  resolvedTheme,
  onConnect,
  onClose,
  preventClose,
}) => {
  const [profiles, setProfiles] = useState<SSHProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [authMethod, setAuthMethod] = useState<SSHAuthMethod>("password");
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState("~/.ssh/id_rsa");
  const [passphrase, setPassphrase] = useState("");
  const [saveCredentials, setSaveCredentials] = useState(false);

  // Status
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFilePicker, setShowFilePicker] = useState(false);

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
      const data = ipc?.readSSHProfiles
        ? await ipc.readSSHProfiles()
        : await ipc?.invoke("ssh.profiles.read");
      setProfiles(data || []);
    } catch {
      setProfiles([]);
    }
  };

  const resetForm = () => {
    setSelectedProfileId(null);
    setName("");
    setHost("");
    setPort("22");
    setUsername("");
    setAuthMethod("password");
    setPassword("");
    setPrivateKeyPath("~/.ssh/id_rsa");
    setPassphrase("");
    setSaveCredentials(false);
    setError(null);
  };

  const populateFromProfile = (profile: SSHProfile) => {
    setSelectedProfileId(profile.id);
    setName(profile.name);
    setHost(profile.host);
    setPort(String(profile.port));
    setUsername(profile.username);
    setAuthMethod(profile.authMethod);
    setPrivateKeyPath(profile.privateKeyPath || "~/.ssh/id_rsa");
    setSaveCredentials(profile.saveCredentials || false);
    setPassword(profile.savedPassword || "");
    setPassphrase(profile.savedPassphrase || "");
    setError(null);
  };

  const buildConfig = (): SSHConnectionConfig => ({
    id: selectedProfileId || uuid(),
    name: name || `${username}@${host}`,
    host,
    port: parseInt(port) || 22,
    username,
    authMethod,
    privateKeyPath: authMethod === "key" ? privateKeyPath : undefined,
    password: authMethod === "password" ? password : undefined,
    passphrase: authMethod === "key" ? passphrase : undefined,
    saveCredentials,
  });

  const handleConnect = async () => {
    if (!host || !username) {
      setError("Host and username are required");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      await onConnect(buildConfig());
      // Success — modal will be closed by the parent
    } catch (e: any) {
      setError(e.message || "Connection failed");
    } finally {
      setConnecting(false);
    }
  };

  const handleSaveProfile = async () => {
    const config = buildConfig();
    const profile: SSHProfile = {
      id: config.id,
      name: config.name,
      host: config.host,
      port: config.port,
      username: config.username,
      authMethod: config.authMethod,
      privateKeyPath: config.privateKeyPath,
      saveCredentials: config.saveCredentials,
      savedPassword: config.saveCredentials ? config.password : undefined,
      savedPassphrase: config.saveCredentials ? config.passphrase : undefined,
    };
    const updated = [...profiles.filter((p) => p.id !== profile.id), profile];
    try {
      const ipc = window.electron?.ipcRenderer;
      if (ipc?.writeSSHProfiles) await ipc.writeSSHProfiles(updated);
      else await ipc?.invoke("ssh.profiles.write", updated);
      setProfiles(updated);
      setSelectedProfileId(profile.id);
    } catch { /* ignore */ }
  };

  const handleDeleteProfile = async () => {
    if (!selectedProfileId) return;
    const updated = profiles.filter((p) => p.id !== selectedProfileId);
    try {
      const ipc = window.electron?.ipcRenderer;
      if (ipc?.writeSSHProfiles) await ipc.writeSSHProfiles(updated);
      else await ipc?.invoke("ssh.profiles.write", updated);
      setProfiles(updated);
      resetForm();
    } catch { /* ignore */ }
  };

  const handleBrowseKey = async () => {
    try {
      const result = await window.electron?.ipcRenderer?.invoke("system.selectFolder");
      if (result) {
        setPrivateKeyPath(result);
        return;
      }
    } catch { /* ignore */ }
    // Fallback to folder picker modal in web mode
    if (!isElectronApp()) setShowFilePicker(true);
  };

  const inputCls = `w-full px-2.5 py-1.5 text-[13px] rounded-md border outline-none transition-colors ${themeClass(resolvedTheme, {
    dark: "bg-white/[0.04] border-white/[0.08] text-gray-200 placeholder-gray-600 focus:border-white/20",
    modern: "bg-white/[0.04] border-white/[0.08] text-gray-200 placeholder-gray-600 focus:border-purple-400/40",
    light: "bg-gray-50/80 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-gray-400",
  })}`;

  const labelCls = `block text-[11px] font-medium mb-0.5 uppercase tracking-wider ${themeClass(resolvedTheme, {
    dark: "text-gray-500",
    modern: "text-gray-500",
    light: "text-gray-400",
  })}`;

  const btnSecondary = `px-3 py-1.5 text-[13px] rounded-md border transition-colors ${themeClass(resolvedTheme, {
    dark: "border-white/[0.08] hover:bg-white/[0.04] text-gray-400 hover:text-gray-200",
    modern: "border-white/[0.08] hover:bg-white/[0.04] text-gray-400 hover:text-gray-200",
    light: "border-gray-200 hover:bg-gray-50 text-gray-500 hover:text-gray-700",
  })}`;

  return (
    <>
    <AnimatePresence>
      {show && (
        <motion.div
          key="ssh-connect"
          variants={overlay}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
          onClick={preventClose ? undefined : onClose}
        >
          <motion.div
            variants={fadeScale}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-md mx-3 rounded-lg shadow-2xl overflow-hidden flex flex-col max-h-[85vh] ${themeClass(
              resolvedTheme,
              {
                dark: "bg-[#141414] text-gray-200 border border-white/[0.06]",
                modern: "bg-[#12121a]/95 backdrop-blur-2xl text-gray-200 border border-white/[0.08] shadow-[0_0_40px_rgba(0,0,0,0.5)]",
                light: "bg-white text-gray-900 border border-gray-200/80 shadow-xl",
              },
            )}`}
          >
            {/* Header */}
            <div className={`px-4 py-3 flex items-center justify-between shrink-0 border-b ${themeClass(resolvedTheme, {
              dark: "border-white/[0.04]",
              modern: "border-white/[0.06]",
              light: "border-gray-100",
            })}`}>
              <div className="flex items-center gap-2">
                <svg className={`w-4 h-4 ${themeClass(resolvedTheme, {
                  dark: "text-gray-500",
                  modern: "text-purple-400/60",
                  light: "text-gray-400",
                })}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9" />
                </svg>
                <h3 className="text-sm font-medium">SSH Connection</h3>
              </div>
              {!preventClose && (
                <button
                  onClick={onClose}
                  className={`p-0.5 rounded transition-colors ${themeClass(resolvedTheme, {
                    dark: "hover:bg-white/[0.06] text-gray-500",
                    modern: "hover:bg-white/[0.06] text-gray-500",
                    light: "hover:bg-gray-100 text-gray-400",
                  })}`}
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            <div className="flex flex-col flex-1 overflow-hidden">
              {/* Saved profiles */}
              {profiles.length > 0 && (
                <div className={`shrink-0 border-b px-3 py-2 ${themeClass(resolvedTheme, {
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
                          handleConnect();
                        }}
                        className={`shrink-0 max-w-[11rem] px-2 py-1 text-[11px] rounded-md border transition-colors truncate ${
                          selectedProfileId === profile.id
                            ? themeClass(resolvedTheme, {
                                dark: "bg-white/[0.06] border-white/[0.12] text-gray-200",
                                modern: "bg-purple-500/10 border-purple-500/20 text-purple-300",
                                light: "bg-gray-100 border-gray-300 text-gray-800",
                              })
                            : themeClass(resolvedTheme, {
                                dark: "border-white/[0.06] hover:bg-white/[0.03] text-gray-400",
                                modern: "border-white/[0.06] hover:bg-white/[0.03] text-gray-400",
                                light: "border-gray-200 hover:bg-gray-50 text-gray-500",
                              })
                        }`}
                        title={`${profile.name} — ${profile.username}@${profile.host}`}
                      >
                        <span className="font-medium">{profile.name}</span>
                        <span className="ml-1 opacity-50">
                          {profile.username}@{profile.host}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Form */}
              <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
                {/* Name */}
                <div>
                  <label className={labelCls}>Name</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My Server (optional)"
                    className={inputCls}
                  />
                </div>

                {/* Host + Port */}
                <div className="flex gap-2">
                  <div className="flex-1 min-w-0">
                    <label className={labelCls}>Host</label>
                    <input
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder="192.168.1.100"
                      className={inputCls}
                    />
                  </div>
                  <div className="w-16 shrink-0">
                    <label className={labelCls}>Port</label>
                    <input
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      placeholder="22"
                      className={inputCls}
                    />
                  </div>
                </div>

                {/* Username */}
                <div>
                  <label className={labelCls}>Username</label>
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="root"
                    className={inputCls}
                  />
                </div>

                {/* Auth Method */}
                <div>
                  <label className={labelCls}>Authentication</label>
                  <select
                    value={authMethod}
                    onChange={(e) => setAuthMethod(e.target.value as SSHAuthMethod)}
                    className={inputCls}
                  >
                    <option value="password">Password</option>
                    <option value="key">Private Key</option>
                    <option value="agent">SSH Agent</option>
                  </select>
                </div>

                {/* Password */}
                {authMethod === "password" && (
                  <div>
                    <label className={labelCls}>Password</label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter password"
                      className={inputCls}
                    />
                  </div>
                )}

                {/* Private Key */}
                {authMethod === "key" && (
                  <>
                    <div>
                      <label className={labelCls}>Private Key Path</label>
                      <div className="flex gap-1.5">
                        <input
                          value={privateKeyPath}
                          onChange={(e) => setPrivateKeyPath(e.target.value)}
                          placeholder="~/.ssh/id_rsa"
                          className={`flex-1 min-w-0 ${inputCls}`}
                        />
                        <button onClick={handleBrowseKey} className={btnSecondary}>
                          Browse
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className={labelCls}>Passphrase</label>
                      <input
                        type="password"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        placeholder="Optional"
                        className={inputCls}
                      />
                    </div>
                  </>
                )}

                {/* SSH Agent info */}
                {authMethod === "agent" && (
                  <div className={`text-[11px] px-2.5 py-2 rounded-md ${themeClass(resolvedTheme, {
                    dark: "bg-white/[0.03] text-gray-500",
                    modern: "bg-white/[0.03] text-gray-500",
                    light: "bg-gray-50 text-gray-400",
                  })}`}>
                    Uses SSH_AUTH_SOCK. Ensure your SSH agent is running with the key loaded.
                  </div>
                )}

                {/* Save credentials */}
                {(authMethod === "password" || (authMethod === "key" && passphrase)) && (
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={saveCredentials}
                      onChange={(e) => setSaveCredentials(e.target.checked)}
                      className="rounded w-3.5 h-3.5"
                    />
                    <span className={`text-[12px] ${themeClass(resolvedTheme, {
                      dark: "text-gray-500",
                      modern: "text-gray-500",
                      light: "text-gray-400",
                    })}`}>Save credentials</span>
                  </label>
                )}

                {/* Error */}
                {error && (
                  <div className={`text-[12px] px-2.5 py-1.5 rounded-md ${themeClass(resolvedTheme, {
                    dark: "text-red-400 bg-red-500/10",
                    modern: "text-red-400 bg-red-500/10",
                    light: "text-red-600 bg-red-50",
                  })}`}>
                    {error}
                  </div>
                )}
              </div>

              {/* Footer */}
              <div className={`shrink-0 px-4 py-2.5 flex items-center gap-2 border-t ${themeClass(resolvedTheme, {
                dark: "border-white/[0.04]",
                modern: "border-white/[0.06]",
                light: "border-gray-100",
              })}`}>
                <motion.button
                  whileTap={{ scale: 0.97 }}
                  onClick={handleConnect}
                  disabled={connecting || !host || !username}
                  className={`px-3.5 py-1.5 text-[13px] font-medium rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${themeClass(resolvedTheme, {
                    dark: "bg-white/[0.1] hover:bg-white/[0.15] text-gray-200",
                    modern: "bg-purple-500/20 hover:bg-purple-500/30 text-purple-200",
                    light: "bg-gray-900 hover:bg-gray-800 text-white",
                  })}`}
                >
                  {connecting ? "Connecting..." : "Connect"}
                </motion.button>
                <button
                  onClick={handleSaveProfile}
                  disabled={!host || !username}
                  className={`${btnSecondary} disabled:opacity-40`}
                >
                  Save
                </button>
                {selectedProfileId && (
                  <button
                    onClick={handleDeleteProfile}
                    className={`px-3 py-1.5 text-[13px] rounded-md transition-colors ${themeClass(resolvedTheme, {
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

    {/* File picker modal (web mode fallback for SSH key browsing) */}
    <FolderPickerModal
      show={showFilePicker}
      resolvedTheme={resolvedTheme}
      initialPath="~/.ssh"
      mode="file"
      onSelect={(filePath) => setPrivateKeyPath(filePath)}
      onClose={() => setShowFilePicker(false)}
    />
    </>
  );
};

export default SSHConnectModal;
