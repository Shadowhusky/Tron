import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { fadeScale, overlay } from "../../../utils/motion";
import { themeClass } from "../../../utils/theme";
import type { ResolvedTheme } from "../../../contexts/ThemeContext";
import type { SSHConnectionConfig, SSHAuthMethod } from "../../../types";

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
      if (result) setPrivateKeyPath(result);
    } catch { /* ignore */ }
  };

  const inputClass = themeClass(resolvedTheme, {
    dark: "bg-white/5 border-white/10 text-white placeholder-gray-500 focus:border-purple-500/50",
    modern: "bg-white/5 border-white/10 text-white placeholder-gray-500 focus:border-purple-400/50",
    light: "bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-purple-500",
  });

  const labelClass = themeClass(resolvedTheme, {
    dark: "text-gray-400",
    modern: "text-gray-400",
    light: "text-gray-600",
  });

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="ssh-connect"
          variants={overlay}
          initial="hidden"
          animate="visible"
          exit="exit"
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70"
          onClick={preventClose ? undefined : onClose}
        >
          <motion.div
            variants={fadeScale}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-w-xl mx-4 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh] ${themeClass(
              resolvedTheme,
              {
                dark: "bg-gray-900 text-white border border-white/10",
                modern: "bg-[#111] text-white border border-white/10 shadow-[0_0_50px_rgba(0,0,0,0.5)]",
                light: "bg-white text-gray-900 border border-gray-200",
              },
            )}`}
          >
            {/* Header */}
            <div className="px-6 pt-5 pb-3 flex items-center justify-between shrink-0">
              <h3 className="text-lg font-semibold">SSH Connection</h3>
              {!preventClose && (
                <button
                  onClick={onClose}
                  className={`p-1 rounded-md transition-colors ${themeClass(resolvedTheme, {
                    dark: "hover:bg-white/10 text-gray-400",
                    modern: "hover:bg-white/10 text-gray-400",
                    light: "hover:bg-gray-100 text-gray-500",
                  })}`}
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            <div className="flex flex-col flex-1 overflow-hidden">
              {/* Saved profiles strip */}
              {profiles.length > 0 && (
                <div className={`shrink-0 border-b px-4 py-2 ${themeClass(resolvedTheme, {
                  dark: "border-white/5",
                  modern: "border-white/5",
                  light: "border-gray-200",
                })}`}>
                  <div className="flex gap-2 overflow-x-auto">
                    {profiles.map((profile) => (
                      <button
                        key={profile.id}
                        onClick={() => populateFromProfile(profile)}
                        onDoubleClick={() => {
                          populateFromProfile(profile);
                          handleConnect();
                        }}
                        className={`shrink-0 px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                          selectedProfileId === profile.id
                            ? themeClass(resolvedTheme, {
                                dark: "bg-purple-600/20 border-purple-500/30 text-purple-300",
                                modern: "bg-purple-600/20 border-purple-500/30 text-purple-300",
                                light: "bg-purple-50 border-purple-200 text-purple-700",
                              })
                            : themeClass(resolvedTheme, {
                                dark: "border-white/10 hover:bg-white/5 text-gray-300",
                                modern: "border-white/10 hover:bg-white/5 text-gray-300",
                                light: "border-gray-200 hover:bg-gray-50 text-gray-700",
                              })
                        }`}
                      >
                        <span className="font-medium">{profile.name}</span>
                        <span className={`ml-1.5 ${themeClass(resolvedTheme, {
                          dark: "text-gray-500",
                          modern: "text-gray-500",
                          light: "text-gray-400",
                        })}`}>
                          {profile.username}@{profile.host}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Connection form */}
              <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
                {/* Name */}
                <div>
                  <label className={`block text-xs font-medium mb-1 ${labelClass}`}>Name (optional)</label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="My Server"
                    className={`w-full px-3 py-2 text-sm rounded-lg border outline-none transition-colors ${inputClass}`}
                  />
                </div>

                {/* Host + Port */}
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className={`block text-xs font-medium mb-1 ${labelClass}`}>Host</label>
                    <input
                      value={host}
                      onChange={(e) => setHost(e.target.value)}
                      placeholder="192.168.1.100 or hostname"
                      className={`w-full px-3 py-2 text-sm rounded-lg border outline-none transition-colors ${inputClass}`}
                    />
                  </div>
                  <div className="w-20">
                    <label className={`block text-xs font-medium mb-1 ${labelClass}`}>Port</label>
                    <input
                      value={port}
                      onChange={(e) => setPort(e.target.value)}
                      placeholder="22"
                      className={`w-full px-3 py-2 text-sm rounded-lg border outline-none transition-colors ${inputClass}`}
                    />
                  </div>
                </div>

                {/* Username */}
                <div>
                  <label className={`block text-xs font-medium mb-1 ${labelClass}`}>Username</label>
                  <input
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="root"
                    className={`w-full px-3 py-2 text-sm rounded-lg border outline-none transition-colors ${inputClass}`}
                  />
                </div>

                {/* Auth Method */}
                <div>
                  <label className={`block text-xs font-medium mb-1 ${labelClass}`}>Authentication</label>
                  <select
                    value={authMethod}
                    onChange={(e) => setAuthMethod(e.target.value as SSHAuthMethod)}
                    className={`w-full px-3 py-2 text-sm rounded-lg border outline-none transition-colors ${inputClass}`}
                  >
                    <option value="password">Password</option>
                    <option value="key">Private Key</option>
                    <option value="agent">SSH Agent</option>
                  </select>
                </div>

                {/* Password field */}
                {authMethod === "password" && (
                  <div>
                    <label className={`block text-xs font-medium mb-1 ${labelClass}`}>Password</label>
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter password"
                      className={`w-full px-3 py-2 text-sm rounded-lg border outline-none transition-colors ${inputClass}`}
                    />
                  </div>
                )}

                {/* Private Key fields */}
                {authMethod === "key" && (
                  <>
                    <div>
                      <label className={`block text-xs font-medium mb-1 ${labelClass}`}>Private Key Path</label>
                      <div className="flex gap-2">
                        <input
                          value={privateKeyPath}
                          onChange={(e) => setPrivateKeyPath(e.target.value)}
                          placeholder="~/.ssh/id_rsa"
                          className={`flex-1 px-3 py-2 text-sm rounded-lg border outline-none transition-colors ${inputClass}`}
                        />
                        <button
                          onClick={handleBrowseKey}
                          className={`px-3 py-2 text-sm rounded-lg border transition-colors ${themeClass(resolvedTheme, {
                            dark: "border-white/10 hover:bg-white/5 text-gray-300",
                            modern: "border-white/10 hover:bg-white/5 text-gray-300",
                            light: "border-gray-200 hover:bg-gray-50 text-gray-700",
                          })}`}
                        >
                          Browse
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className={`block text-xs font-medium mb-1 ${labelClass}`}>Passphrase (optional)</label>
                      <input
                        type="password"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        placeholder="Key passphrase"
                        className={`w-full px-3 py-2 text-sm rounded-lg border outline-none transition-colors ${inputClass}`}
                      />
                    </div>
                  </>
                )}

                {/* SSH Agent info */}
                {authMethod === "agent" && (
                  <div className={`text-xs px-3 py-2 rounded-lg ${themeClass(resolvedTheme, {
                    dark: "bg-white/5 text-gray-400",
                    modern: "bg-white/5 text-gray-400",
                    light: "bg-gray-50 text-gray-500",
                  })}`}>
                    Uses SSH_AUTH_SOCK environment variable. Make sure your SSH agent is running and has the key loaded.
                  </div>
                )}

                {/* Save credentials checkbox */}
                {(authMethod === "password" || (authMethod === "key" && passphrase)) && (
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={saveCredentials}
                      onChange={(e) => setSaveCredentials(e.target.checked)}
                      className="rounded"
                    />
                    <span className={`text-sm ${labelClass}`}>Save credentials</span>
                  </label>
                )}

                {/* Error */}
                {error && (
                  <div className="text-sm text-red-400 bg-red-500/10 px-3 py-2 rounded-lg">
                    {error}
                  </div>
                )}
              </div>

              {/* Buttons — sticky footer, never clipped */}
              <div className={`shrink-0 px-5 py-4 flex gap-2 border-t ${themeClass(resolvedTheme, {
                dark: "border-white/5",
                modern: "border-white/5",
                light: "border-gray-200",
              })}`}>
                <motion.button
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.98 }}
                  onClick={handleConnect}
                  disabled={connecting || !host || !username}
                  className="px-4 py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {connecting ? "Connecting..." : "Connect"}
                </motion.button>
                <button
                  onClick={handleSaveProfile}
                  disabled={!host || !username}
                  className={`px-4 py-2 text-sm rounded-lg border transition-colors disabled:opacity-50 ${themeClass(resolvedTheme, {
                    dark: "border-white/10 hover:bg-white/5 text-gray-300",
                    modern: "border-white/10 hover:bg-white/5 text-gray-300",
                    light: "border-gray-200 hover:bg-gray-50 text-gray-700",
                  })}`}
                >
                  Save Profile
                </button>
                {selectedProfileId && (
                  <button
                    onClick={handleDeleteProfile}
                    className="px-4 py-2 text-sm rounded-lg text-red-400 hover:bg-red-500/10 transition-colors"
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

export default SSHConnectModal;
