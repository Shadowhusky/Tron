import React, { useState, useEffect } from 'react';
import { aiService, type AIConfig } from '../services/ai';
import { useTheme } from '../contexts/ThemeContext';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
    const { theme, toggleTheme } = useTheme();
    const [config, setConfig] = useState<AIConfig>(aiService.getConfig());
    const [ollamaModels, setOllamaModels] = useState<string[]>([]);

    useEffect(() => {
        if (isOpen) {
            setConfig(aiService.getConfig());
            // Fetch Ollama models if provider is Ollama
            aiService.getModels().then(list => {
                const ollama = list.filter(m => m.provider === 'ollama').map(m => m.name);
                setOllamaModels(ollama);
            });
        }
    }, [isOpen]);

    const handleSave = () => {
        aiService.saveConfig(config);
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className={`w-[500px] border rounded-xl shadow-2xl p-6 flex flex-col gap-6 ${theme === 'dark' ? 'bg-gray-900 border-white/10' : 'bg-white border-gray-200'}`}>
                <div className="flex items-center justify-between">
                    <h2 className={`text-xl font-bold ${theme === 'dark' ? 'text-white' : 'text-gray-900'}`}>Settings</h2>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-500">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                </div>

                {/* AI Settings */}
                <div className="space-y-4">
                    <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">AI Configuration</h3>

                    <div className="flex flex-col gap-2">
                        <label className={`text-sm ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>Provider</label>
                        <select
                            value={config.provider}
                            onChange={(e) => setConfig({ ...config, provider: e.target.value as any })}
                            className={`w-full p-2 text-sm rounded-lg border outline-none ${theme === 'dark' ? 'bg-black/40 border-white/10 text-white' : 'bg-gray-50 border-gray-300 text-gray-900'}`}
                        >
                            <option value="ollama">Ollama (Local)</option>
                            <option value="openai">OpenAI (Cloud)</option>
                            <option value="anthropic">Anthropic (Cloud)</option>
                        </select>
                    </div>

                    {config.provider === 'ollama' ? (
                        <div className="flex flex-col gap-2">
                            <label className={`text-sm ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>Model</label>
                            <select
                                value={config.model}
                                onChange={(e) => setConfig({ ...config, model: e.target.value })}
                                className={`w-full p-2 text-sm rounded-lg border outline-none ${theme === 'dark' ? 'bg-black/40 border-white/10 text-white' : 'bg-gray-50 border-gray-300 text-gray-900'}`}
                            >
                                {ollamaModels.map(m => <option key={m} value={m}>{m}</option>)}
                                <option value="llama3">llama3</option>
                                <option value="mistral">mistral</option>
                            </select>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <div className="flex flex-col gap-2">
                                <label className={`text-sm ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>Model Name</label>
                                <input
                                    type="text"
                                    value={config.model}
                                    placeholder={config.provider === 'openai' ? 'gpt-4o' : 'claude-3-opus'}
                                    onChange={(e) => setConfig({ ...config, model: e.target.value })}
                                    className={`w-full p-2 text-sm rounded-lg border outline-none ${theme === 'dark' ? 'bg-black/40 border-white/10 text-white' : 'bg-gray-50 border-gray-300 text-gray-900'}`}
                                />
                            </div>
                            <div className="flex flex-col gap-2">
                                <label className={`text-sm ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>API Key</label>
                                <input
                                    type="password"
                                    value={config.apiKey || ''}
                                    onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
                                    className={`w-full p-2 text-sm rounded-lg border outline-none ${theme === 'dark' ? 'bg-black/40 border-white/10 text-white' : 'bg-gray-50 border-gray-300 text-gray-900'}`}
                                />
                            </div>
                        </div>
                    )}
                </div>

                {/* Appearance Settings */}
                <div className="space-y-3">
                    <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider">Appearance</h3>
                    <div className="flex items-center justify-between">
                        <label className={`text-sm ${theme === 'dark' ? 'text-gray-300' : 'text-gray-700'}`}>Theme</label>
                        <div className={`flex gap-2 p-1 rounded-lg border ${theme === 'dark' ? 'bg-black/40 border-white/5' : 'bg-gray-100 border-gray-200'}`}>
                            <button
                                onClick={() => theme !== 'dark' && toggleTheme()}
                                className={`px-3 py-1 rounded-md text-xs transition-colors ${theme === 'dark' ? 'bg-white/10 text-white' : 'text-gray-500 hover:text-black'}`}
                            >Dark</button>
                            <button
                                onClick={() => theme !== 'light' && toggleTheme()}
                                className={`px-3 py-1 rounded-md text-xs transition-colors ${theme === 'light' ? 'bg-white shadow text-black' : 'text-gray-500 hover:text-white'}`}
                            >Light</button>
                        </div>
                    </div>
                </div>

                <div className="flex justify-end pt-4 border-t border-white/5">
                    <button onClick={handleSave} className="px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg text-sm font-medium transition-colors">
                        Save Changes
                    </button>
                </div>
            </div>
        </div>
    );
};

export default SettingsModal;
